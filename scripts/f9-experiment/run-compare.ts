/**
 * Old-vs-new Advisor comparison harness (v0.4.1 logic vs HEAD defaults).
 *
 * Arms differ exactly the way the src diff v0.4.1..729ebf6 differs:
 *   - `old`: includeReasoning=true rendering, NO history compression (v0.4.1)
 *   - `new`: includeReasoning=false rendering (PI_ADVISOR_NO_REASONING default ON),
 *            compressAdvisorHistory(keepRecentCycles=1) in maintainContextPolicy
 *            (PI_ADVISOR_HISTORY_COMPRESSION default ON)
 *
 * Protocol follows the User WATCHDOG configuration used for the run:
 *   - model: commandcode-goat/deepseek/deepseek-v4-flash (contextWindow 1e6)
 *     -> advisorContextLimit = floor(1e6*0.3) - 8192 = 291,808 tokens
 *   - context.maxUpdateTokens 20000 -> 80,000-byte delta budget
 *   - cadence: reviews are replayed from REAL historical nested-session chains
 *     (one review per recorded update, spaced every few turns as they occurred)
 *   - per-arm session soft caps from WATCHDOG limits; harness safety budget
 *     1,000,000 review tokens and $25 (F9 convention)
 *
 * Two measurement blocks:
 *   A) STATIC render A/B on the 9 ctx cuts (raw entries from
 *      docs/internal/context-dataset.draft.ts): retained entries, bytes,
 *      truncation under includeReasoning on/off — no live model needed.
 *   B) LIVE cadence replay of the real hist corpus chain
 *      (docs/internal/advisor-hist-corpus.jsonl, 56 real reviews with
 *      ground-truth labels): per-arm persistent nested advisor session,
 *      sequential updates, maintainContextPolicy replication, per-review
 *      usage (input/cacheRead/cacheWrite/output) + verdict + compression
 *      events.
 *
 * Run: `bun scripts/f9-experiment/run-compare.ts` (live model required).
 * Results appended to docs/internal/compare-results.jsonl; evaluation note
 * written to docs/internal/old-vs-new-compare-results.md.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import { createAdviseTool, type AdviceCollector } from "../../src/advice.js";
import { loadAdvisorConfiguration } from "../../src/configuration.js";
import { DEFAULT_ADVISOR_CONFIG } from "../../src/config.js";
import {
	compressAdvisorHistory,
	type AdvisorHistoryMessage,
} from "../../src/history-compaction.js";
import { buildAdvisorSystemPrompt, estimateAdvisorContext } from "../../src/runtime.js";
import { renderAdvisorDelta } from "../../src/transcript.js";
import {
	f9HarnessHash,
	gitHeadCommit,
	identityBaseMatches,
	sha256Head16,
	type ExperimentIdentityBase,
} from "./experiment-identity.js";
import {
	lastAssistantUsage,
	loadPersistedJsonl,
	registerUserProviderExtensions,
} from "./harness.js";

const REVIEW_TOKEN_CEILING = 1_000_000;
const COST_CEILING_USD = 25;
const RESULTS_PATH = join("docs", "internal", "compare-results.jsonl");
const HIST_CORPUS_PATH = join("docs", "internal", "advisor-hist-corpus.jsonl");
function sessionSnapshotPath(arm: Arm): string {
	return join("docs", "internal", `compare-session-${arm}.json`);
}

type Arm = "old" | "new";

interface HistItem {
	id: string;
	file: string;
	kind: "finding" | "silence" | "noop";
	findingKey?: string;
	severity?: string;
	terms: string[];
	update_text: string;
	upd_bytes: number;
	truncated: boolean;
	ras: boolean;
}

interface CompareRunResult {
	itemId: string;
	arm: Arm;
	stage: "render-ab" | "cadence";
	note?: string;
	severity?: string;
	stopReason: string;
	errorMessage?: string;
	verdict: "hit" | "miss" | "false-positive" | "silence-correct" | "run-error" | "over-limit";
	tokens: number;
	costUsd: number;
	cachedTokens: number;
	inputTokens: number;
	responseModel?: string;
	renderedBytes: number;
	retainedEntries: number;
	totalEntries: number;
	compressedCount: number;
	turnInChain: number;
	/** Experiment identity — persisted cadence results are only eligible for
	 * resume when it matches the current corpus/model/prompt/limit/commit.
	 * Optional: results persisted before identity tracking have no field and
	 * are discarded on resume (render-ab rows are deterministic static renders
	 * and are exempt). */
	experiment?: {
		datasetHash: string;
		model: string;
		promptHash: string;
		limitTokens: number;
		protocol: string;
		sourceCommit: string;
		harnessHash: string;
	};
}

interface ArmRunState {
	arm: Arm;
	usageAnchorInvalidated: boolean;
	compressedEvents: number;
	promptHeaderBytes: number;
}

const COMPARE_PROTOCOL = "compare-experiment-v2";

interface ExperimentIdentity extends ExperimentIdentityBase {
	limitTokens: number;
}

function buildCompareIdentity(
	model: string,
	prompt: string,
	chain: readonly HistItem[],
	limitTokens: number,
): ExperimentIdentity {
	const datasetHash = sha256Head16(JSON.stringify(chain));
	return {
		datasetHash,
		model,
		promptHash: sha256Head16(prompt),
		limitTokens,
		protocol: COMPARE_PROTOCOL,
		sourceCommit: gitHeadCommit(),
		harnessHash: f9HarnessHash(import.meta.url),
	};
}

function identityMatches(result: CompareRunResult, identity: ExperimentIdentity): boolean {
	return (
		identityBaseMatches(result.experiment, identity) &&
		result.experiment?.limitTokens === identity.limitTokens
	);
}

function advisorContextLimit(contextWindow: number, config: typeof DEFAULT_ADVISOR_CONFIG): number {
	return Math.max(
		0,
		Math.floor(contextWindow * config.context.maxFraction) - config.context.reserveTokens,
	);
}

function verdictForHist(
	kind: HistItem["kind"],
	note: string | undefined,
	terms: readonly string[],
): CompareRunResult["verdict"] {
	if (kind === "silence" || kind === "noop") {
		return note === undefined ? "silence-correct" : "false-positive";
	}
	if (note === undefined) return "miss";
	const normalized = note.toLocaleLowerCase("en-US");
	return terms.some((term) => normalized.includes(term.toLocaleLowerCase("en-US")))
		? "hit"
		: "miss";
}

interface AdviseViews {
	suppressed: number;
	accepted: { note?: string; severity?: string; intent?: string; truncated?: boolean } | undefined;
}

function sessionAdviseView(session: AgentSession): AdviseViews {
	let lastAdvise: { note?: string; severity?: string; intent?: string } | undefined;
	let suppressed = 0;
	for (const message of session.messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || part.name !== "advise") continue;
			// SAFETY: advise toolCall arguments are JSON-schema-constrained by the
			// advise tool contract; unknown fields are ignored downstream.
			const args = part.arguments as {
				note?: string;
				severity?: string;
				intent?: string;
				outcome?: { advised?: boolean };
			};
			if (args.outcome?.advised === false) {
				suppressed++;
				continue;
			}
			lastAdvise = {};
			if (args.note !== undefined) lastAdvise.note = args.note;
			if (args.severity !== undefined) lastAdvise.severity = args.severity;
			if (args.intent !== undefined) lastAdvise.intent = args.intent;
		}
	}
	return { suppressed, accepted: lastAdvise };
}

/**
 * Replicate runtime maintainContextPolicy: estimate next context; when over
 * limit and history compression is armed (new arm), compress old cycles; if
 * still over, the update is dropped (over-limit).
 */
function maintainContextPolicy(
	session: AgentSession,
	pendingPrompt: string,
	systemPrompt: string,
	limit: number,
	armState: ArmRunState,
	compress: boolean,
): "proceed" | "over-limit" {
	let estimate = estimateAdvisorContext(
		session.messages,
		pendingPrompt,
		systemPrompt,
		!armState.usageAnchorInvalidated,
	);
	if (estimate.tokens <= limit) return "proceed";
	armState.usageAnchorInvalidated = true;
	if (!compress) return "over-limit";
	// SAFETY: session.state.messages are AgentMessage objects whose role/content/
	// timestamp shape structurally matches AdvisorHistoryMessage; the cast is
	// read-only and content is decoded defensively downstream.
	const compressed = compressAdvisorHistory(
		session.state.messages as readonly AdvisorHistoryMessage[],
	);
	if (compressed.compressedCycles <= 0) return "over-limit";
	// SAFETY: compressAdvisorHistory returns verbatim input messages plus one
	// string-content user summary — a valid AgentMessage state array shape.
	session.state.messages = compressed.messages as typeof session.state.messages;
	armState.compressedEvents += compressed.compressedCycles;
	estimate = estimateAdvisorContext(session.messages, pendingPrompt, systemPrompt, false);
	return estimate.tokens <= limit ? "proceed" : "over-limit";
}

async function loadHistCorpus(): Promise<HistItem[]> {
	try {
		const raw = await readFile(HIST_CORPUS_PATH, "utf8");
		// SAFETY: advisor-hist-corpus.jsonl is a git-ignored hand corpus with a
		// fixed HistItem schema (not written by collect-corpus.ts); malformed
		// lines surface on field access below.
		return raw
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as HistItem);
	} catch (error) {
		console.error(
			`[cmp] cannot read ${HIST_CORPUS_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

async function loadPersistedResults(): Promise<CompareRunResult[]> {
	// Fail closed on corruption: degrading to [] would re-run (and re-bill) every
	// already-completed cadence row of live reviews.
	return loadPersistedJsonl<CompareRunResult>(RESULTS_PATH, "[cmp]");
}

/** Static render A/B over ctx cuts — no live model. Pure renderer math. */
async function renderAbBlock(): Promise<void> {
	const datasetPath = join("docs", "internal", "context-dataset.draft.ts");
	try {
		await readFile(datasetPath, "utf8");
	} catch {
		console.log("[cmp] ctx dataset missing; skipping static render A/B");
		return;
	}
	// SAFETY: the dataset module is generated by collect-corpus.ts with one
	// known named export; the dynamically imported namespace is untyped and
	// every read is null-guarded (`?? []`).
	const module = (await import(pathToFileURL(datasetPath).href)) as {
		F9_CONTEXT_DATASET?: readonly {
			id: string;
			entries: readonly unknown[];
			expectation: { kind: string };
		}[];
	};
	const cuts = module.F9_CONTEXT_DATASET ?? [];
	console.log(`[cmp] static render A/B over ${String(cuts.length)} ctx cuts`);
	const rows: CompareRunResult[] = [];
	for (const cut of cuts) {
		const budget = 20_000;
		for (const arm of ["old", "new"] as const) {
			const includeReasoning = arm === "old";
			const rendered = renderAdvisorDelta(
				// SAFETY: dataset entries are SessionEntry objects serialized verbatim
				// by collect-corpus.ts from real session files; renderAdvisorDelta
				// reads them defensively.
				cut.entries as Parameters<typeof renderAdvisorDelta>[0],
				budget,
				{ includeReasoning },
			);
			rows.push({
				itemId: cut.id,
				arm,
				stage: "render-ab",
				stopReason: "renderer",
				verdict: "silence-correct",
				tokens: 0,
				costUsd: 0,
				cachedTokens: 0,
				inputTokens: 0,
				renderedBytes: Buffer.byteLength(rendered.text, "utf8"),
				retainedEntries: rendered.retainedEntryCount,
				totalEntries: cut.entries.length,
				compressedCount: 0,
				turnInChain: 0,
			});
		}
	}
	for (const row of rows) {
		await appendFile(RESULTS_PATH, `${JSON.stringify(row)}\n`, "utf8");
		console.log(
			`[cmp] render-ab ${row.itemId} ${row.arm}: retained ${String(row.retainedEntries)}/${String(row.totalEntries)} bytes=${String(row.renderedBytes)}`,
		);
	}
}

interface ArmSessionCtx {
	arm: Arm;
	session: AgentSession;
	armState: ArmRunState;
}

async function saveSessionSnapshot(arm: Arm, session: AgentSession): Promise<void> {
	await writeFile(sessionSnapshotPath(arm), JSON.stringify(session.messages), "utf8");
}

async function loadSessionSnapshot(arm: Arm): Promise<AgentSession["messages"] | undefined> {
	try {
		const raw = await readFile(sessionSnapshotPath(arm), "utf8");
		// SAFETY: the snapshot was written by saveSessionSnapshot from
		// AgentSession.messages verbatim, so the parsed JSON has that shape.
		return JSON.parse(raw) as AgentSession["messages"];
	} catch {
		return undefined;
	}
}

async function createArmSession(options: {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	model: Model<string>;
	prompt: string;
	arm: Arm;
	config: typeof DEFAULT_ADVISOR_CONFIG;
	resumeMessages?: AgentSession["messages"];
}): Promise<ArmSessionCtx> {
	const { config } = options;
	const collector: AdviceCollector = {
		validCalls: 0,
		suppressedCalls: 0,
		memoryPolicySuppressedCalls: 0,
		memoryLimitSuppressedCalls: 0,
	};
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => options.prompt,
		appendSystemPromptOverride: () => [],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(options.cwd);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime: options.modelRuntime,
		model: options.model,
		thinkingLevel: "off",
		resourceLoader,
		sessionManager,
		settingsManager,
		customTools: [createAdviseTool(config, collector)],
		tools: ["advise"],
	});
	// Breakpoint resume: rehydrate the accumulated nested-session context from a
	// prior run so cache/compression behavior continues exactly where it stopped.
	if (options.resumeMessages !== undefined && options.resumeMessages.length > 0) {
		session.state.messages = options.resumeMessages;
		console.log(
			`[cmp] ${options.arm}: rehydrated ${String(options.resumeMessages.length)} messages from snapshot`,
		);
	}
	return {
		arm: options.arm,
		session,
		armState: {
			arm: options.arm,
			usageAnchorInvalidated: false,
			compressedEvents: 0,
			promptHeaderBytes: 0,
		},
	};
}

/** Review a single item on one arm's persistent session; returns the row and usage. */
async function replayOneItem(
	ctx: ArmSessionCtx,
	options: { prompt: string; limit: number; turn: number; experiment: ExperimentIdentity },
	item: HistItem,
): Promise<CompareRunResult> {
	const { session } = ctx;
	const delta = item.update_text.includes("<advisor-update>")
		? item.update_text
		: `<advisor-update>\n${item.update_text}\n</advisor-update>`;
	const policy = maintainContextPolicy(
		session,
		delta,
		options.prompt,
		options.limit,
		ctx.armState,
		ctx.arm === "new",
	);
	if (policy === "over-limit") {
		console.log(`  -> ${item.id} ${ctx.arm} OVER-LIMIT (dropped)`);
		return {
			itemId: item.id,
			arm: ctx.arm,
			stage: "cadence",
			stopReason: "over-limit",
			verdict: "over-limit",
			tokens: 0,
			costUsd: 0,
			cachedTokens: 0,
			inputTokens: 0,
			renderedBytes: item.upd_bytes,
			retainedEntries: 0,
			totalEntries: 0,
			compressedCount: ctx.armState.compressedEvents,
			turnInChain: options.turn,
			experiment: options.experiment,
		};
	}
	try {
		await session.prompt(delta, { expandPromptTemplates: false, source: "extension" });
	} catch (error) {
		console.error(
			`  -> ${item.id} ${ctx.arm} run error: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {
			itemId: item.id,
			arm: ctx.arm,
			stage: "cadence",
			stopReason: "thrown",
			errorMessage: error instanceof Error ? error.message : String(error),
			verdict: "run-error",
			tokens: 0,
			costUsd: 0,
			cachedTokens: 0,
			inputTokens: 0,
			renderedBytes: item.upd_bytes,
			retainedEntries: 0,
			totalEntries: 0,
			compressedCount: ctx.armState.compressedEvents,
			turnInChain: options.turn,
			experiment: options.experiment,
		};
	}
	const usage = lastAssistantUsage(session);
	const adviseView = sessionAdviseView(session);
	const row: CompareRunResult = {
		itemId: item.id,
		arm: ctx.arm,
		stage: "cadence",
		stopReason:
			// SAFETY: the last message is an AgentMessage; stopReason is read as an
			// untrusted string with an "unknown" fallback, nothing else is assumed.
			(session.messages.at(-1) as { stopReason?: string } | undefined)?.stopReason ?? "unknown",
		verdict: verdictForHist(item.kind, adviseView.accepted?.note, item.terms),
		tokens: usage.tokens,
		costUsd: usage.costUsd,
		cachedTokens: usage.cachedTokens,
		inputTokens: usage.inputTokens,
		renderedBytes: item.upd_bytes,
		retainedEntries: 0,
		totalEntries: 0,
		compressedCount: ctx.armState.compressedEvents,
		turnInChain: options.turn,
		experiment: options.experiment,
	};
	if (adviseView.accepted?.note !== undefined) row.note = adviseView.accepted.note;
	if (adviseView.accepted?.severity !== undefined) row.severity = adviseView.accepted.severity;
	if (usage.responseModel !== undefined) row.responseModel = usage.responseModel;
	console.log(
		`  -> ${item.id} ${ctx.arm} ${row.verdict} (${String(usage.tokens)} tok, cached ${String(usage.cachedTokens)}, ctx ~${String(estimateAdvisorContext(session.messages, delta, options.prompt, false).tokens)}/${String(options.limit)})${row.note === undefined ? "" : `: ${row.note.slice(0, 80)}`}`,
	);
	return row;
}

async function writeEvaluation(options: {
	modelReference: string;
	responseModels: Set<string>;
	rows: CompareRunResult[];
	stoppedEarly: boolean;
	reason?: string;
	contextLimit: number;
	maxFractionPct: number;
	reserveTokens: number;
	contextWindow: number;
}): Promise<string> {
	const { rows } = options;
	const renderRows = rows.filter((r) => r.stage === "render-ab");
	const cadenceRows = rows.filter((r) => r.stage === "cadence" && r.verdict !== "over-limit");
	const overLimitRows = rows.filter((r) => r.verdict === "over-limit");

	const renderTable = renderRows
		.map(
			(r) =>
				`| ${r.itemId} | ${r.arm} | ${String(r.retainedEntries)} | ${String(r.totalEntries)} | ${String(r.renderedBytes)} |`,
		)
		.join("\n");
	const renderByArm = new Map<Arm, { retained: number; bytes: number; n: number }>();
	for (const r of renderRows) {
		const e = renderByArm.get(r.arm) ?? { retained: 0, bytes: 0, n: 0 };
		e.retained += r.retainedEntries;
		e.bytes += r.renderedBytes;
		e.n += 1;
		renderByArm.set(r.arm, e);
	}

	const cadenceByArm = new Map<
		Arm,
		{
			n: number;
			hit: number;
			miss: number;
			fp: number;
			silence: number;
			tokens: number;
			cached: number;
			input: number;
			cost: number;
			compressed: number;
		}
	>();
	for (const r of cadenceRows) {
		const e = cadenceByArm.get(r.arm) ?? {
			n: 0,
			hit: 0,
			miss: 0,
			fp: 0,
			silence: 0,
			tokens: 0,
			cached: 0,
			input: 0,
			cost: 0,
			compressed: 0,
		};
		e.n += 1;
		if (r.verdict === "hit") e.hit += 1;
		if (r.verdict === "miss") e.miss += 1;
		if (r.verdict === "false-positive") e.fp += 1;
		if (r.verdict === "silence-correct") e.silence += 1;
		e.tokens += r.tokens;
		e.cached += r.cachedTokens;
		e.input += r.inputTokens;
		e.cost += r.costUsd;
		e.compressed += r.compressedCount;
		cadenceByArm.set(r.arm, e);
	}
	const armTable = [...cadenceByArm.entries()]
		.map(([arm, e]) => {
			// deepseek reports usage.input as the uncached portion; total input =
			// input + cacheRead; cache share = cacheRead/(cacheRead+input).
			const totalInput = e.cached + e.input;
			const cacheShare = totalInput === 0 ? 0 : (e.cached / totalInput) * 100;
			return `| ${arm} | ${String(e.n)} | ${String(e.hit)} | ${String(e.miss)} | ${String(e.fp)} | ${String(e.silence)} | ${String(e.tokens)} | ${String(e.input)} | ${String(e.cached)} (${cacheShare.toFixed(1)}%) | ${String(e.compressed)} | $${e.cost.toFixed(4)} |`;
		})
		.join("\n");

	const detail = cadenceRows
		.map((r) => {
			const totalInput = r.cachedTokens + r.inputTokens;
			const cacheShare = totalInput === 0 ? 0 : (r.cachedTokens / totalInput) * 100;
			return `| ${r.itemId} | ${r.arm} | ${String(r.turnInChain)} | ${r.verdict} | ${String(r.compressedCount)} | ${String(r.tokens)} | ${String(r.inputTokens)} | ${String(r.cachedTokens)} (${cacheShare.toFixed(1)}%) | ${(r.note ?? "(silence)").replaceAll("\n", " ").slice(0, 90).replaceAll("|", "\\|")} |`;
		})
		.join("\n");

	const note = `# Advisor 新旧逻辑对比（v0.4.1 vs HEAD 默认）— 实测结果

Status: ${options.stoppedEarly ? `stopped early: ${options.reason ?? "budget ceiling reached"}` : "completed"}.
对比对象: \`old\` = includeReasoning=true + 无历史压缩（≈v0.4.1）; \`new\` = HEAD 默认
（no-reasoning + \`compressAdvisorHistory(keepRecentCycles=1)\`）。两者只差 HEAD 引入的两个特性,
与 src diff v0.4.1..729ebf6 一致。

## 模型与参数

- 配置模型: \`${options.modelReference}\`（WATCHDOG.yml）
- Provider-reported response models: ${[...options.responseModels].join(", ") || "(none recorded)"}
- contextLimit = floor(contextWindow×${String(options.maxFractionPct)}%) − ${String(options.reserveTokens)} = ${String(options.contextLimit)}（${options.modelReference} contextWindow ${String(options.contextWindow)}）
- delta 预算: maxUpdateTokens 20,000 → 80,000 字节
- 成本软顶: 1e6 review tokens / $25（F9 约定）

## A) 静态渲染对比（ctx 9 条截断窗口, 无 live model）

| Item | Arm | Retained entries | Total entries | Rendered bytes |
| --- | --- | --- | --- | --- |
${renderTable}

汇总 (${String(renderByArm.get("old")?.n ?? 0)} 窗口/arm): old 合计 ${String(renderByArm.get("old")?.retained ?? 0)} entries / ${String(renderByArm.get("old")?.bytes ?? 0)} bytes;
new 合计 ${String(renderByArm.get("new")?.retained ?? 0)} entries / ${String(renderByArm.get("new")?.bytes ?? 0)} bytes。

## B) 真实历史链 live 回放（cadence, 每条 = 一次真实 review）

| Arm | n | hit | miss | false-pos | silence-correct | Σtokens | Σuncached input | Σcached (share) | compressedEvents | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${armTable}

Over-limit（drop）: ${String(overLimitRows.length)} 条。

### 每条明细

| Item | Arm | Turn | Verdict | compressedCount | Tokens | Uncached input | Cached (share) | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
${detail}

## Reading

- hit/miss/fp/silence 反映 advisor 检测准确率在两个 arm 下的差异; Σtokens 与 cached share 反映
  token 消耗与 prefix-cache 命中差异; compressedCount 反映 \`new\` arm 的历史压缩实际触发次数。
- 单次 run 受模型方差主导; 任一差值为测量信号而非结论。
`;
	const path = join("docs", "internal", "old-vs-new-compare-results.md");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, note, "utf8");
	return path;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const limitRaw = args.find((_v, index) => args[index - 1] === "--limit-items");
	const limitItems = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
	const limitTokensRaw = args.find((_v, index) => args[index - 1] === "--limit-tokens");
	const limitTokensOverride =
		limitTokensRaw === undefined ? undefined : Number.parseInt(limitTokensRaw, 10);
	const hist = await loadHistCorpus();
	if (hist.length === 0) {
		console.error(`[cmp] hist corpus empty at ${HIST_CORPUS_PATH}`);
		process.exitCode = 1;
		return;
	}
	const persisted = await loadPersistedResults();
	console.log(`[cmp] resuming: ${String(persisted.length)} results already recorded`);
	if (!persisted.some((r) => r.stage === "render-ab")) {
		await renderAbBlock();
	}
	const persistedAfterRender = await loadPersistedResults();
	let donePairs = new Set(
		persistedAfterRender.map((r) => `${r.stage}:${r.itemId}:${r.arm}:${String(r.turnInChain)}`),
	);
	console.log(`[cmp] resuming: ${String(persistedAfterRender.length)} results after render block`);

	// Choose chain: real order (hist-01..56), covering findings + silences.
	let chain = hist.filter((item) => item.update_text.length > 0);
	if (limitItems !== undefined && Number.isFinite(limitItems) && limitItems > 0) {
		chain = chain.slice(0, limitItems);
	}
	console.log(`[cmp] chain: ${String(chain.length)} real historical reviews`);

	const agentDir = getAgentDir();
	const cwd = process.cwd();
	const loaded = await loadAdvisorConfiguration({
		agentDir,
		cwd,
		projectTrusted: false,
		fallbackUserConfig: DEFAULT_ADVISOR_CONFIG,
	});
	const modelReference = loaded.effectiveConfig.model;
	if (modelReference === undefined) {
		console.error("[cmp] requires a configured Advisor model in the User WATCHDOG configuration.");
		process.exitCode = 1;
		return;
	}
	const separator = modelReference.indexOf("/");
	const providerId = separator < 0 ? modelReference : modelReference.slice(0, separator);
	const modelId = separator < 0 ? modelReference : modelReference.slice(separator + 1);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: true,
	});
	const registry = new ModelRegistry(modelRuntime);
	let available = registry.getAvailable();
	if (!available.some((model) => `${model.provider}/${model.id}` === modelReference)) {
		const loadedExtensions = await registerUserProviderExtensions(
			agentDir,
			providerId,
			modelRuntime,
			"cmp",
		);
		if (loadedExtensions.length > 0) {
			console.log(`[cmp] loaded provider extension: ${loadedExtensions.join(", ")}`);
			await registry.refresh();
			available = registry.getAvailable();
		}
	}
	if (!available.some((model) => `${model.provider}/${model.id}` === modelReference)) {
		console.error(`[cmp] could not resolve an authenticated model for ${modelReference}.`);
		process.exitCode = 1;
		return;
	}
	const model = modelRuntime.getModel(providerId, modelId);
	if (model === undefined) {
		console.error(`[cmp] could not find model ${modelReference}.`);
		process.exitCode = 1;
		return;
	}
	const configForRun = { ...loaded.effectiveConfig };
	const naturalLimit = advisorContextLimit(model.contextWindow, configForRun);
	const limit = limitTokensOverride ?? naturalLimit;
	console.log(
		`[cmp] model ${modelReference}, contextLimit=${String(limit)} (natural ${String(naturalLimit)})`,
	);
	const prompt = buildAdvisorSystemPrompt(configForRun, "");
	// Experiment identity: persisted cadence results are only eligible for resume
	// when dataset/model/prompt/limit/commit all match — otherwise a regenerated
	// corpus or changed config would silently mix unrelated results. Render-ab
	// rows are deterministic static renders and are exempt.
	const experiment = buildCompareIdentity(modelReference, prompt, chain, limit);
	const eligibleCadenceRows = persistedAfterRender.filter(
		(r) => r.stage !== "cadence" || identityMatches(r, experiment),
	);
	const discardedCadence = persistedAfterRender.length - eligibleCadenceRows.length;
	if (discardedCadence > 0) {
		console.log(
			`[cmp] identity mismatch: discarding ${String(discardedCadence)} persisted cadence results (corpus/model/prompt/limit/commit changed)`,
		);
	}
	donePairs = new Set(
		eligibleCadenceRows.map((r) => `${r.stage}:${r.itemId}:${r.arm}:${String(r.turnInChain)}`),
	);

	const rows: CompareRunResult[] = [...eligibleCadenceRows];
	const responseModels = new Set<string>(
		eligibleCadenceRows.flatMap((r) => (r.responseModel === undefined ? [] : [r.responseModel])),
	);
	// Seed billed totals from persisted rows (both arms share the ceiling).
	let totalTokens = eligibleCadenceRows.reduce((s, r) => s + r.tokens, 0);
	let totalCost = eligibleCadenceRows.reduce((s, r) => s + r.costUsd, 0);
	let stoppedEarly = false;
	let stopReason: string | undefined;

	// Interleaved per item: both arm sessions persist across the chain, and each
	// chain item is reviewed by both arms before the next — so the token ceiling
	// applies to the pair and coverage stays identical between arms. Resume
	// rehydrates each arm's accumulated session from its breakpoint snapshot.
	const pendingOld = chain
		.map((item, turn) => ({ item, turn }))
		.filter(({ item, turn }) => !donePairs.has(`cadence:${item.id}:old:${String(turn)}`));
	const pendingNew = chain
		.map((item, turn) => ({ item, turn }))
		.filter(({ item, turn }) => !donePairs.has(`cadence:${item.id}:new:${String(turn)}`));
	if (pendingOld.length === 0 && pendingNew.length === 0) {
		console.log(`[cmp] all ${String(chain.length)} cadence turns already recorded`);
	} else {
		const oldSnapshot = await loadSessionSnapshot("old");
		const newSnapshot = await loadSessionSnapshot("new");
		// SAFETY: `model` is the runtime-resolved model instance for this run.
		const armModel = model as Model<string>;
		// SAFETY: configForRun is DEFAULT_ADVISOR_CONFIG merged with documented
		// user WATCHDOG overrides.
		const armConfig = configForRun as typeof DEFAULT_ADVISOR_CONFIG;
		const oldOptions: Parameters<typeof createArmSession>[0] = {
			cwd,
			agentDir,
			modelRuntime,
			model: armModel,
			prompt,
			arm: "old",
			config: armConfig,
		};
		if (oldSnapshot !== undefined) oldOptions.resumeMessages = oldSnapshot;
		const oldCtx = pendingOld.length === 0 ? undefined : await createArmSession(oldOptions);
		const newOptions: Parameters<typeof createArmSession>[0] = {
			cwd,
			agentDir,
			modelRuntime,
			model: armModel,
			prompt,
			arm: "new",
			config: armConfig,
		};
		if (newSnapshot !== undefined) newOptions.resumeMessages = newSnapshot;
		const newCtx = pendingNew.length === 0 ? undefined : await createArmSession(newOptions);
		try {
			const maxTurn = Math.max(
				pendingOld.length === 0 ? -1 : (pendingOld.at(-1)?.turn ?? -1),
				pendingNew.length === 0 ? -1 : (pendingNew.at(-1)?.turn ?? -1),
			);
			for (let turn = 0; turn <= maxTurn; turn++) {
				const item = chain[turn];
				if (item === undefined) continue;
				const oldPending = pendingOld.some((p) => p.turn === turn);
				const newPending = pendingNew.some((p) => p.turn === turn);
				if (!oldPending && !newPending) continue;
				console.log(`[cmp] === turn ${String(turn)} ${item.id} ===`);
				if (oldPending && oldCtx !== undefined) {
					const oldRow = await replayOneItem(oldCtx, { prompt, limit, turn, experiment }, item);
					await appendFile(RESULTS_PATH, `${JSON.stringify(oldRow)}\n`, "utf8");
					rows.push(oldRow);
					totalTokens += oldRow.tokens;
					totalCost += oldRow.costUsd;
					if (oldRow.responseModel !== undefined) responseModels.add(oldRow.responseModel);
					// Breakpoint: snapshot the accumulated session after every review.
					await saveSessionSnapshot("old", oldCtx.session);
					if (totalTokens >= REVIEW_TOKEN_CEILING || totalCost >= COST_CEILING_USD) {
						stoppedEarly = true;
						stopReason = `budget ceiling reached at ${String(totalTokens)} tokens / $${totalCost.toFixed(4)}`;
						break;
					}
				}
				if (newPending && newCtx !== undefined) {
					const newRow = await replayOneItem(newCtx, { prompt, limit, turn, experiment }, item);
					await appendFile(RESULTS_PATH, `${JSON.stringify(newRow)}\n`, "utf8");
					rows.push(newRow);
					totalTokens += newRow.tokens;
					totalCost += newRow.costUsd;
					if (newRow.responseModel !== undefined) responseModels.add(newRow.responseModel);
					await saveSessionSnapshot("new", newCtx.session);
					if (totalTokens >= REVIEW_TOKEN_CEILING || totalCost >= COST_CEILING_USD) {
						stoppedEarly = true;
						stopReason = `budget ceiling reached at ${String(totalTokens)} tokens / $${totalCost.toFixed(4)}`;
						break;
					}
				}
			}
		} finally {
			oldCtx?.session.dispose();
			newCtx?.session.dispose();
		}
	}
	const path = await writeEvaluation({
		modelReference,
		responseModels,
		rows,
		stoppedEarly,
		contextLimit: limit,
		maxFractionPct: Math.round(configForRun.context.maxFraction * 100),
		reserveTokens: configForRun.context.reserveTokens,
		contextWindow: model.contextWindow,
	});
	const byArm = new Map<Arm, { tokens: number; cached: number; input: number }>();
	for (const r of rows.filter((r) => r.stage === "cadence" && r.verdict !== "over-limit")) {
		const e = byArm.get(r.arm) ?? { tokens: 0, cached: 0, input: 0 };
		e.tokens += r.tokens;
		e.cached += r.cachedTokens;
		e.input += r.inputTokens;
		byArm.set(r.arm, e);
	}
	console.log("");
	for (const [arm, e] of byArm) {
		const sub = rows.filter(
			(r) => r.stage === "cadence" && r.arm === arm && r.verdict !== "over-limit",
		);
		const uncachedInput = Math.max(0, e.input - e.cached);
		const cacheShare = e.input + e.cached === 0 ? 0 : (e.cached / (e.input + e.cached)) * 100;
		console.log(
			`[cmp] ${arm}: ${String(sub.length)} reviews, Σ${String(e.tokens)} tok (input ${String(e.input)} cached ${String(e.cached)}/cacheShare ${cacheShare.toFixed(1)}% uncachedInput ${String(uncachedInput)})`,
		);
	}
	console.log(`[cmp] evaluation note written to ${path}`);
	if (stoppedEarly) console.log(`[cmp] ${stopReason ?? "stopped early"}`);
}

await main();
