/**
 * Local prefix-cache hit simulation (NO provider calls, NO model cost).
 *
 * Replays the real history chain (advisor-hist-corpus.jsonl) through the
 * PRODUCTION context-assembly pipeline — estimateAdvisorContext and the
 * deterministic history compressor — and computes for every review turn the
 * prompt-prefix cache hit ratio under the append-only prefix model:
 * consecutive turn prompts share the growing history prefix, so hitBytes =
 * longest common prefix of this turn's prompt with the previous turn's prompt.
 *
 * This replicates how provider prefix caching behaves on this workload:
 *   - old arm (includeReasoning, no compression): pure append-only → prefix
 *     grows monotonically, high share;
 *   - new arm (no-reasoning + compress): append-only between compressions,
 *     one-time prefix rewrite on each compression event.
 *
 * Run: `bun scripts/f9-experiment/analyze-cache-hit.ts [--context-window N]`
 * Default contextWindow: 1_000_000 (deepseek-v4-flash).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildAdvisorSystemPrompt, estimateAdvisorContext } from "../../src/runtime.js";
import {
	compressAdvisorHistory,
	compressNestedMessages,
	type AdvisorHistoryMessage,
} from "../../src/history-compaction.js";
import { DEFAULT_ADVISOR_CONFIG } from "../../src/config.js";
import { isRecordValue, isStringValue } from "../../src/value-guards.js";
import { loadAdvisorConfiguration } from "../../src/configuration.js";

const CORPUS_PATH = join("docs", "internal", "advisor-hist-corpus.jsonl");
const ADVISE_RESULT_BYTES =
	'{"adviceBlocked":false,"findingKey":"","severity":"none","note":"","outcome":{"advised":false}}';

interface HistRow {
	id: string;
	kind: string;
	update_text: string;
}

interface TurnLine {
	itemId: string;
	arm: "old" | "new";
	turn: number;
	estimateTokens: number;
	limitTokens: number;
	promptBytes: number;
	hitBytes: number;
	sharePct: number;
	event: "proceed" | "compressed" | "slimmed" | "cleared" | "over-limit";
	compressedCycles: number;
	keptCycles: number;
}

function bytesOf(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Longest common prefix (bytes) of two strings — the provider cache key. */
function longestCommonPrefixBytes(a: string, b: string): number {
	const len = Math.min(a.length, b.length);
	let i = 0;
	while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

function advisorContextLimit(contextWindow: number, config: typeof DEFAULT_ADVISOR_CONFIG): number {
	return Math.max(
		0,
		Math.floor(contextWindow * config.context.maxFraction) - config.context.reserveTokens,
	);
}

function buildDelta(updateText: string): string {
	return updateText.includes("<advisor-update>")
		? updateText
		: `<advisor-update>\n${updateText}\n</advisor-update>`;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const windowRaw = args.find((_v, index) => args[index - 1] === "--context-window");
	const contextWindow = windowRaw === undefined ? 1_000_000 : Number.parseInt(windowRaw, 10);
	if (windowRaw !== undefined && !Number.isFinite(contextWindow)) {
		console.error("[cache] --context-window must be a number");
		process.exitCode = 1;
		return;
	}
	// What-if override for max-fraction: without it the knob comes from the
	// User WATCHDOG configuration.
	const maxFractionRaw = args.find((_v, index) => args[index - 1] === "--max-fraction");
	const maxFractionOverride =
		maxFractionRaw === undefined ? undefined : Number.parseFloat(maxFractionRaw);
	if (maxFractionOverride !== undefined && !(maxFractionOverride > 0 && maxFractionOverride <= 1)) {
		console.error("[cache] --max-fraction must be within (0, 1]");
		process.exitCode = 1;
		return;
	}

	const rows = (await readFile(CORPUS_PATH, "utf8"))
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l): HistRow => {
			try {
				// SAFETY: advisor-hist-corpus.jsonl is a git-ignored hand corpus consumed
				// by run-compare.ts and this analyzer (not written by collect-corpus.ts);
				// a malformed row fails loudly here rather than silently emptying the chain.
				return JSON.parse(l) as HistRow;
			} catch (error) {
				throw new Error(
					`[cache] invalid corpus row: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	const chain = rows.filter((item) => item.update_text.length > 0);
	console.log(
		`[cache] chain: ${String(chain.length)} real historical updates, contextWindow=${String(contextWindow)}`,
	);

	const loaded = await loadAdvisorConfiguration({
		agentDir: getAgentDir(),
		cwd: process.cwd(),
		projectTrusted: false,
		fallbackUserConfig: DEFAULT_ADVISOR_CONFIG,
	});
	const config = loaded.effectiveConfig;
	if (maxFractionOverride !== undefined) config.context.maxFraction = maxFractionOverride;
	const limit = advisorContextLimit(contextWindow, config);
	const systemPrompt = buildAdvisorSystemPrompt(config, "");
	console.log(
		`[cache] maxFraction=${String(config.context.maxFraction)} → limit=${String(limit)} tokens`,
	);
	console.log("[cache] keepRecentCycles=1 (fixed), compress on every over-limit turn");

	// Nesting-session message accumulation modeled as AdvisorHistoryMessage[];
	// byte-identical to the shape compressAdvisorHistory consumes.
	for (const arm of ["old", "new"] as const) {
		// Nested-session message accumulation modeled as AgentMessage[] — the
		// shape estimateAdvisorContext consumes; contentless variants are filtered
		// out by hasContent before the compression helpers read the array.
		const hasContent = (
			m: AgentMessage | AdvisorHistoryMessage,
		): m is AgentMessage & AdvisorHistoryMessage => "content" in m;
		let messages: AgentMessage[] = [];
		let prevPrompt = "";
		const lines: TurnLine[] = [];
		let drops = 0;
		let compressions = 0;
		let slimmedCount = 0;
		let clears = 0;
		let totalPromptBytes = 0;
		let totalHitBytes = 0;

		for (let turn = 0; turn < chain.length; turn++) {
			const item = chain[turn];
			if (item === undefined) continue;
			const delta = buildDelta(item.update_text);
			// SAFETY: messages are real AgentMessage objects pushed by this loop, so
			// no cast is needed at the estimator boundary.
			const estimate = estimateAdvisorContext(messages, delta, systemPrompt, true);
			let event: TurnLine["event"] = "proceed";
			let compressedCycles = 0;
			let keptCycles = messages.length;

			// Recompute the estimate against the CURRENT messages after a history
			// rewrite (cycle-compress / slim / full clear). Mirrors the runtime
			// re-calling estimateNextAdvisorContext(..., false) after each stage of
			// maintainContextPolicy — a stage that leaves the history still over
			// limit must escalate to the next one, and only a frame that does not
			// fit an EMPTY history is a genuine drop.
			const reestimate = (): ReturnType<typeof estimateAdvisorContext> => {
				return estimateAdvisorContext(messages, delta, systemPrompt, false);
			};

			if (estimate.tokens > limit) {
				if (arm === "new") {
					// Mirror the runtime escalation ladder (runtime.ts
					// maintainContextPolicy): cycle-compress → message-level slim →
					// full clear. After each rewrite the estimate is recomputed and an
					// over-limit result escalates to the next stage; only a frame that
					// still does not fit an EMPTY history is dropped.
					// Stage 1: deterministic cycle compression (no-op when there are
					// few cycles). If it reduces the history, re-estimate.
					const compressed = compressAdvisorHistory(messages.filter(hasContent));
					let settled = false;
					if (compressed.compressedCycles > 0) {
						messages = compressed.messages.filter(hasContent);
						compressedCycles = compressed.compressedCycles;
						keptCycles = compressed.keptCycles;
						compressions++;
						if (reestimate().tokens <= limit) {
							event = "compressed";
							settled = true;
						}
					}
					if (!settled) {
						// Stage 2: message-level lossy slim (no-op on a corpus without
						// thinking blocks or oversized tool results). Kept in the ladder
						// so a future corpus with thinking-bearing replies is measured
						// correctly instead of silently full-clearing.
						const slimmed = compressNestedMessages(messages.filter(hasContent));
						if (slimmed.degraded > 0) {
							messages = slimmed.messages.filter(hasContent);
							slimmedCount++;
							if (reestimate().tokens <= limit) {
								event = "slimmed";
								settled = true;
							}
						}
					}
					if (!settled) {
						// Stage 3: full clear, then re-estimate. Only a frame that still
						// does not fit an EMPTY history is a genuine drop.
						messages = [];
						if (reestimate().tokens <= limit) {
							clears++;
							event = "cleared";
						} else {
							drops++;
							event = "over-limit";
						}
					}
				} else {
					drops++;
					event = "over-limit";
				}
			}

			// Prompt this turn sends = system prompt + accumulated messages + this delta.
			const thisPrompt = `${systemPrompt}\n${messageBody(messages)}\n${delta}`;
			const hitBytes = longestCommonPrefixBytes(prevPrompt, thisPrompt);
			const promptBytes = bytesOf(thisPrompt);
			totalPromptBytes += promptBytes;
			totalHitBytes += hitBytes;

			lines.push({
				itemId: item.id,
				arm,
				turn,
				estimateTokens: estimate.tokens,
				limitTokens: limit,
				promptBytes,
				hitBytes,
				sharePct: promptBytes === 0 ? 0 : (hitBytes / promptBytes) * 100,
				event,
				compressedCycles,
				keptCycles,
			});

			// This turn's delta + a compact advise tool result join the history
			// (append-only between compressions).
			prevPrompt = thisPrompt;
			messages.push(
				{ role: "user", content: delta, timestamp: 1_700_000_000_000 + turn },
				{
					role: "toolResult",
					toolCallId: `probe-${String(turn)}`,
					toolName: "advise",
					isError: false,
					content: [{ type: "text", text: ADVISE_RESULT_BYTES }],
					timestamp: 1_700_000_000_001 + turn,
				},
			);
		}

		console.log(`\n=== arm ${arm} (${String(lines.length)} turns) ===`);
		console.log("turn | item      | event      | cycl | kept | estTk | promptB | hitB | share%");
		for (const line of lines) {
			console.log(
				`${String(line.turn).padEnd(4)} | ${line.itemId.padEnd(9)} | ${line.event.padEnd(10)} | ${String(line.compressedCycles).padEnd(4)} | ${String(line.keptCycles).padEnd(4)} | ${String(line.estimateTokens).padEnd(6)} | ${String(line.promptBytes).padEnd(7)} | ${String(line.hitBytes).padEnd(5)} | ${line.sharePct.toFixed(1)}`,
			);
		}
		const meanShare =
			lines.length === 0 ? 0 : lines.reduce((s, l) => s + l.sharePct, 0) / lines.length;
		const sharePct = totalPromptBytes === 0 ? 0 : (totalHitBytes / totalPromptBytes) * 100;
		console.log(
			`--- totals: mean share=${meanShare.toFixed(1)}% | Σprompt=${String(totalPromptBytes)} B | Σhit=${String(totalHitBytes)} B (${sharePct.toFixed(1)}%) | drops=${String(drops)} | compressions=${String(compressions)} | slims=${String(slimmedCount)} | clears=${String(clears)}`,
		);
	}
}

function contentToText(content: Parameters<typeof isStringValue>[0]): string {
	if (isStringValue(content)) return content;
	if (Array.isArray(content)) {
		// SAFETY: the Array.isArray check above narrows content to an array of
		// unvalidated parts; every field read below goes through the value guards.
		return (content as unknown[])
			.map((part) => {
				if (isStringValue(part)) return part;
				if (
					!isRecordValue<{
						type?: unknown;
						text?: unknown;
						name?: unknown;
						arguments?: unknown;
					}>(part)
				) {
					return "";
				}
				if (part.type === "text") return isStringValue(part.text) ? part.text : "";
				if (part.type === "toolCall") {
					const name = isStringValue(part.name) ? part.name : "unknown";
					return `[tool call ${name}] ${JSON.stringify(part.arguments ?? {})}`;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function messageBody(messages: readonly (AgentMessage | AdvisorHistoryMessage)[]): string {
	return messages.map((m) => ("content" in m ? contentToText(m.content) : "")).join("\n");
}

void main();
