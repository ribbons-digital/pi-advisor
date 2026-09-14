import { truncateUtf8Bytes } from "./redaction.js";
import { isRecordValue, isStringValue } from "./value-guards.js";

/**
 * pi-vcc-style deterministic compression of the advisor's OWN nested-session
 * history: review cycles older than the most recent one are replaced by a
 * bounded summary block. Raw update bodies are destroyed (the reviewer is
 * strongly recency-weighted and buried old deltas never measured a recall
 * benefit), while the dedupe substrate (advise findingKey/note), unresolved
 * error-register lines, breadcrumbs, and user-instruction heads survive
 * verbatim. Pure and deterministic: identical history compresses to an
 * identical block, so the rewritten prefix is cache-stable afterwards.
 */

export const HISTORY_SUMMARY_TAG = "advisor-history-summary";
const DEFAULT_KEEP_RECENT_CYCLES = 1;
const SUMMARY_BLOCK_MAX_BYTES = 4 * 1_024;
const TAG_OVERHEAD_RESERVE_BYTES = 128;
const LINE_USER_HEAD_CHARS = 80;
const LINE_NOTE_HEAD_CHARS = 120;
const MAX_REGISTER_LINES_PER_CYCLE = 3;

/**
 * Message-level lossy compression of the nested-session history, applied as a
 * milder fallback before the nuclear `clearPrivateContextAtCurrentCursor`.
 *
 * Older messages are slimmed per-message and deterministically (idempotent: a
 * second pass over already-slimmed messages changes nothing), so the rewritten
 * prefix stays byte-stable and re-cacheable. The newest few messages are kept
 * verbatim — they are the ones the reviewer is most likely to reference next
 * turn. Never cuts mid-message: user/assistant text is preserved as-is and
 * only `thinking` blocks are stripped, because splitting a user frame or a
 * toolCall sequence would orphan its toolResult and corrupt provider replay.
 */
export const NESTED_SLIM_KEEP_RECENT_MESSAGES = 4;
/** Keep this many leading lines of a slimmed toolResult. */
export const NESTED_SLIM_TOOL_RESULT_HEAD_LINES = 24;
/** Byte cap for a slimmed toolResult (same magnitude as transcript per-result cap). */
export const NESTED_SLIM_TOOL_RESULT_HEAD_BYTES = 4 * 1_024;
export const NESTED_SLIM_TRUNCATION_MARKER = "\n[Older Advisor tool result trimmed]";

export interface AdvisorNestedSlim {
	messages: AdvisorHistoryMessage[];
	/** Total bytes removed across all slimmed messages. */
	savingsBytes: number;
	/** Number of messages that were actually modified. */
	degraded: number;
}

export interface AdvisorHistoryMessage {
	role: string;
	content: unknown;
	timestamp?: unknown;
}

export interface AdvisorHistoryCompaction {
	messages: AdvisorHistoryMessage[];
	summaryText: string;
	compressedCycles: number;
	keptCycles: number;
}

interface HistoryCycle {
	start: number;
	endExclusive: number; // exclusive
	updateText: string;
	adviseLines: string[];
}

interface UnvalidatedAdviseOutcome {
	findingKey?: unknown;
	severity?: unknown;
	note?: unknown;
	outcome?: unknown;
}

/** Unvalidated content-part shape for the message decode path. */
interface UnvalidatedContentPart {
	type?: unknown;
	text?: unknown;
	name?: unknown;
	arguments?: unknown;
}

/** Unvalidated advise outcome record shape for the `outcome.advised` check. */
interface UnvalidatedOutcomeRecord {
	advised?: unknown;
}

function contentToText(content: Parameters<typeof isRecordValue>[0]): string {
	if (isStringValue(content)) return content;
	if (!Array.isArray(content)) return "";
	// SAFETY: the Array.isArray check above narrows content to an array of unvalidated parts.
	return (content as unknown[])
		.map((part) => {
			if (!isRecordValue<UnvalidatedContentPart>(part)) return "";
			const record = part;
			if (record.type === "text") return isStringValue(record.text) ? record.text : "";
			if (record.type === "thinking") return "";
			if (record.type === "toolCall") {
				const name = isStringValue(record.name) ? record.name : "unknown";
				return `[tool call ${name}] ${JSON.stringify(record.arguments ?? {})}`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function firstBlockLine(text: string, header: string): string | undefined {
	const start = text.indexOf(header);
	if (start === -1) return undefined;
	const bodyStart = start + header.length;
	const lineEnd = text.indexOf("\n", bodyStart);
	const line = lineEnd === -1 ? text.slice(bodyStart) : text.slice(bodyStart, lineEnd);
	const trimmed = line.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function adviseOutcomeLine(contentText: string): string | undefined {
	const trimmed = contentText.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!isRecordValue<UnvalidatedAdviseOutcome>(parsed)) return undefined;
		const advised =
			isRecordValue<UnvalidatedOutcomeRecord>(parsed.outcome) && parsed.outcome.advised === true;
		const findingKey = isStringValue(parsed.findingKey) ? parsed.findingKey : "";
		const severity = isStringValue(parsed.severity) ? parsed.severity : "";
		if (!advised && findingKey.length === 0) return undefined;
		const parts = [`advise advised=${advised ? "true" : "false"}`];
		if (findingKey.length > 0) parts.push(`findingKey=${findingKey}`);
		if (severity.length > 0) parts.push(`severity=${severity}`);
		if (advised && isStringValue(parsed.note) && parsed.note.trim().length > 0) {
			parts.push(`note: "${parsed.note.trim().slice(0, LINE_NOTE_HEAD_CHARS)}"`);
		}
		return parts.join(" ");
	} catch {
		return undefined;
	}
}

function splitCycles(messages: readonly AdvisorHistoryMessage[]): HistoryCycle[] {
	const cycles: HistoryCycle[] = [];
	let current: HistoryCycle | undefined;
	for (const [index, message] of messages.entries()) {
		// Only advisor-update prompts (and previous summary blocks) start a review
		// cycle. Other user-role injections (lifecycle reprime, steering) stay
		// inside the enclosing cycle so compression cuts never orphan tool results.
		const text = contentToText(message.content);
		if (
			message.role !== "user" ||
			(!text.startsWith(`<${HISTORY_SUMMARY_TAG}`) && !text.includes("<advisor-update>"))
		) {
			continue;
		}
		if (current !== undefined) current.endExclusive = index;
		current = {
			start: index,
			endExclusive: messages.length,
			updateText: text,
			adviseLines: [],
		};
		cycles.push(current);
	}
	return cycles;
}

/**
 * Extract the inner lines of a previous summary block so re-compression can
 * carry them verbatim (idempotency): prior findingKey/notes and [ERROR]
 * register lines must never be re-summarized into a shorter form.
 *
 * Cache-stability: the block header carries NO growing counter — the covered
 * range is derived from the highest `[#N]` row ordinal instead, so the block's
 * leading bytes stay byte-identical across re-compressions (a growing
 * `updates="1..N"` attribute in the header broke the prefix-cache hit on the
 * whole previous block after each rewrite; see p2-retention-cap-evaluation
 * probe: consecutive summaries shared only 62 bytes).
 */
interface SummaryLines {
	lines: string[];
	coveredThrough: number;
}

function extractSummaryLines(updateText: string): SummaryLines {
	const closeIndex = updateText.indexOf(`</${HISTORY_SUMMARY_TAG}>`);
	const headerEnd = updateText.indexOf("\n");
	const inner =
		headerEnd === -1 || closeIndex === -1 ? "" : updateText.slice(headerEnd + 1, closeIndex);
	const lines = inner.split("\n").filter((line) => line.startsWith("[#"));
	// Covered range = highest carried `[#N]` ordinal (idempotent carry keeps the
	// row numbering continuous, so the tail row is the covered-through count).
	// Legacy fallback: older blocks carried `updates="1..N"` in the header.
	let coveredThrough = 0;
	for (const line of lines) {
		const match = /^\[#(\d+)\]/.exec(line);
		const ordinal = match?.[1];
		if (ordinal !== undefined && /^\d+$/.test(ordinal)) {
			coveredThrough = Math.max(coveredThrough, Number.parseInt(ordinal, 10));
		}
	}
	if (coveredThrough === 0) {
		const headerLine = headerEnd === -1 ? updateText : updateText.slice(0, headerEnd);
		const legacy = /updates="1\.\.(\d+)"/.exec(headerLine);
		const legacyMatch = legacy?.[1];
		if (legacyMatch !== undefined && /^\d+$/.test(legacyMatch)) {
			coveredThrough = Number.parseInt(legacyMatch, 10);
		}
	}
	return { lines, coveredThrough: Number.isFinite(coveredThrough) ? coveredThrough : 0 };
}

function cycleSummaryLine(cycle: HistoryCycle, ordinal: number, updateText: string): string {
	const parts: string[] = [`[#${String(ordinal)}]`];
	const userHead = firstBlockLine(updateText, "[Executor user]\n");
	if (userHead !== undefined) {
		parts.push(`user "${userHead.slice(0, LINE_USER_HEAD_CHARS)}"`);
	} else {
		const head = updateText.replace(/<[^>]+>/g, " ").trim();
		if (head.length > 0) parts.push(`update "${head.slice(0, LINE_USER_HEAD_CHARS)}"`);
	}
	let adviseCount = 0;
	for (const line of cycle.adviseLines) {
		if (adviseCount >= 3) break;
		parts.push(line);
		adviseCount++;
	}
	const registerLines = updateText
		.split("\n")
		.filter((line) => line.startsWith("- [ERROR]"))
		.slice(0, MAX_REGISTER_LINES_PER_CYCLE);
	for (const line of registerLines) parts.push(line.trim().slice(0, 160));
	const breadcrumb = updateText
		.split("\n")
		.find((line) => line.startsWith("Dropped beyond window:"));
	if (breadcrumb !== undefined) parts.push(breadcrumb.slice(0, 200));
	return parts.join(" | ").slice(0, 400);
}

export function compressAdvisorHistory(
	messages: readonly AdvisorHistoryMessage[],
	options: { keepRecentCycles?: number } = {},
): AdvisorHistoryCompaction {
	const keepRecentCycles = Math.max(1, options.keepRecentCycles ?? DEFAULT_KEEP_RECENT_CYCLES);
	const cycles = splitCycles(messages);
	if (cycles.length <= keepRecentCycles) {
		return {
			messages: [...messages],
			summaryText: "",
			compressedCycles: 0,
			keptCycles: cycles.length,
		};
	}
	const compressed = cycles.slice(0, cycles.length - keepRecentCycles);
	const lastCompressed = compressed.at(-1);
	const firstCompressed = compressed[0];
	if (lastCompressed === undefined || firstCompressed === undefined) {
		return {
			messages: [...messages],
			summaryText: "",
			compressedCycles: 0,
			keptCycles: cycles.length,
		};
	}
	const keptVerbatimFromFallback = lastCompressed.endExclusive;
	// advise outcomes from compressed cycles (advise toolResult messages inside each cycle)
	const lines: string[] = [];
	let linesBytes = 0;
	let nextOrdinal = 1;
	let representedCycles = 0;
	for (const [index, cycle] of compressed.entries()) {
		const updateText = cycle.updateText;
		// Idempotency: a previous summary block is carried verbatim — prior
		// findingKey/notes and [ERROR] register lines must never be re-summarized.
		const isSummary = updateText.startsWith(`<${HISTORY_SUMMARY_TAG}`);
		let candidateLines: string[];
		if (isSummary) {
			candidateLines = extractSummaryLines(updateText).lines;
		} else {
			const adviseLines: string[] = [];
			for (
				let index2 = cycle.start + 1;
				index2 < cycle.endExclusive && adviseLines.length < 3;
				index2++
			) {
				const message = messages[index2];
				if (message?.role !== "toolResult") continue;
				const line = adviseOutcomeLine(contentToText(message.content));
				if (line !== undefined) adviseLines.push(line);
			}
			cycle.adviseLines = adviseLines;
			candidateLines = [cycleSummaryLine(cycle, nextOrdinal, updateText)];
		}
		let candidateBytes = 0;
		for (const line of candidateLines) candidateBytes += Buffer.byteLength(`${line}\n`, "utf8");
		// Cap path: cycles that no longer fit stay VERBATIM (kept-from moves back
		// to them) instead of being dropped without representation.
		if (linesBytes + candidateBytes > SUMMARY_BLOCK_MAX_BYTES - TAG_OVERHEAD_RESERVE_BYTES) break;
		lines.push(...candidateLines);
		linesBytes += candidateBytes;
		nextOrdinal = isSummary
			? Math.max(nextOrdinal, extractSummaryLines(updateText).coveredThrough + 1)
			: nextOrdinal + 1;
		representedCycles = index + 1;
	}
	if (lines.length === 0) {
		return {
			messages: [...messages],
			summaryText: "",
			compressedCycles: 0,
			keptCycles: cycles.length,
		};
	}
	const firstUnrepresented = compressed[representedCycles]?.start;
	const keptVerbatimFrom = firstUnrepresented ?? keptVerbatimFromFallback;
	// Total update count across cycles: a carried summary container represents
	// the updates it covers, not just itself.
	let totalUpdates = 0;
	for (const cycle of cycles) {
		totalUpdates += cycle.updateText.startsWith(`<${HISTORY_SUMMARY_TAG}`)
			? extractSummaryLines(cycle.updateText).coveredThrough
			: 1;
	}
	const summaryText = `<${HISTORY_SUMMARY_TAG} compressed="algorithmic">\n${lines.join("\n")}\n</${HISTORY_SUMMARY_TAG}>`;
	const keptHead = messages.slice(0, firstCompressed.start);
	const keptTail = messages.slice(keptVerbatimFrom);
	// Deterministic: never inject Date.now() — the rewritten prefix must be
	// byte-stable for a given history (cache stability + testability).
	const summaryTimestamp = messages[keptVerbatimFrom]?.timestamp;
	const summaryMessage: AdvisorHistoryMessage = { role: "user", content: summaryText };
	if (summaryTimestamp !== undefined) {
		summaryMessage.timestamp = summaryTimestamp;
	}
	return {
		messages: [...keptHead, summaryMessage, ...keptTail],
		summaryText,
		compressedCycles: nextOrdinal - 1,
		keptCycles: totalUpdates - (nextOrdinal - 1),
	};
}

// ============================================================================
// Message-level lossy history slimming (fallback before the nuclear full clear)
// ============================================================================

/**
 * Decoded shape of a content block inside a nested-session message. Advisor
 * history messages are AgentMessage objects whose `content` is either a plain
 * string (user frames / re-prime / summary) or an array of provider content
 * blocks (text / thinking / toolCall / image). Fields stay `unknown` because
 * the array is unvalidated at this boundary; every read goes through
 * `isRecordValue` / `isStringValue` below.
 */
interface SlimPart {
	type: string;
	text?: unknown;
	thinking?: unknown;
	thinkingSignature?: unknown;
	redacted?: unknown;
	name?: unknown;
	arguments?: unknown;
}

function slimPartText(part: SlimPart): string {
	if (part.type === "text" && isStringValue(part.text)) return part.text;
	if (part.type === "thinking" && isStringValue(part.thinking)) return part.thinking;
	if (part.type === "toolCall") return JSON.stringify(part.arguments ?? {});
	return "";
}

function slimPartBytes(part: SlimPart): number {
	return Buffer.byteLength(slimPartText(part), "utf8");
}

/** Message content is either a string (user frames) or a content-block array. */
type SlimContent = string | SlimPart[];

function contentBytes(content: SlimContent): number {
	if (isStringValue(content)) return Buffer.byteLength(content, "utf8");
	return content.reduce(
		(total, part) => total + (isRecordValue<SlimPart>(part) ? slimPartBytes(part) : 0),
		0,
	);
}

function hasThinkingBlock(content: SlimContent): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((part) => isRecordValue<SlimPart>(part) && part.type === "thinking");
}

/** Whether an opaque redacted/encrypted thinking block must be kept verbatim. */
function isRetainedThinking(part: SlimPart): boolean {
	if (!isRecordValue<SlimPart>(part) || part.type !== "thinking") return false;
	return (
		part.redacted === true ||
		(part.thinkingSignature !== undefined && !isStringValue(part.thinking))
	);
}

/** Bulk text thinking is droppable; opaque/redacted thinking and non-thinking blocks stay. */
function isDroppableThinking(part: SlimPart): boolean {
	return isRecordValue<SlimPart>(part) && part.type === "thinking" && !isRetainedThinking(part);
}

/**
 * Strip `thinking` blocks from an assistant message while preserving every
 * text and toolCall block verbatim, so provider replay never sees a dangling
 * tool call. Redacted/opaque thinking is kept (its `thinkingSignature` payload
 * is required for same-model continuity). An assistant message that would
 * become empty is left untouched rather than turning into an empty-turn
 * artifact. The `usage` anchor is zeroed because the rewritten history no
 * longer contains the stripped thinking tokens.
 */
function stripAssistantThinking(message: AdvisorHistoryMessage): AdvisorHistoryMessage {
	if (!Array.isArray(message.content)) return message;
	// SAFETY: only assistant messages reach here (checked by the caller), and
	// AgentMessage assistant content is a text/thinking/toolCall/image block
	// array — each part is validated with isRecordValue before field access.
	const parts = message.content as SlimPart[];
	const kept = parts.filter((part) => !isDroppableThinking(part));
	if (kept.length === parts.length) return message;
	if (
		!kept.some(
			(part) => isRecordValue<SlimPart>(part) && (part.type === "text" || part.type === "toolCall"),
		)
	) {
		return message;
	}
	const zeroed = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// SAFETY: spreading the original message preserves its other AgentMessage
	// fields; content stays a valid text/thinking/toolCall/image array and
	// usage is a structurally valid Usage value.
	return { ...message, content: kept, usage: zeroed } as AdvisorHistoryMessage;
}

/**
 * Cap a toolResult body to its leading head lines/bytes (deterministic).
 *
 * Two caps can bound an oversized result, each firing only when the body
 * actually exceeds it:
 *   - line cap: keep the first `NESTED_SLIM_TOOL_RESULT_HEAD_LINES` lines;
 *   - byte cap: keep the first `NESTED_SLIM_TOOL_RESULT_HEAD_BYTES` bytes.
 * The byte cap applies even when the body has fewer lines than the line cap
 * (long lines, or a single no-newline line such as a JSON dump) — previously
 * the scan overwrote the last good line boundary with -1 and skipped the byte
 * cap entirely, so such results were never trimmed and overflow fell through
 * to the nuclear full clear. Surviving text is always a prefix (dropped
 * content is a suffix), so the kept head stays contiguous; `truncateUtf8Bytes`
 * walks code points, so the byte cut never splits a multibyte character.
 * Re-compressing an already-capped result is a no-op (idempotent).
 */
function slimToolResultText(text: string): string | undefined {
	// The line cap binds only when the body actually exceeds it: it fires when
	// the newline terminating the (cap)-th line exists. Scan for up to cap
	// newlines; if the cap-th one is found the line cap applies, otherwise the
	// body has at most cap lines and only the byte cap can trim it.
	let capLineEnd = -1;
	let searchFrom = 0;
	let found = 0;
	for (; found < NESTED_SLIM_TOOL_RESULT_HEAD_LINES; found++) {
		const next = text.indexOf("\n", searchFrom);
		if (next === -1) break;
		capLineEnd = next;
		searchFrom = next + 1;
	}
	const lineCapBinds = found === NESTED_SLIM_TOOL_RESULT_HEAD_LINES && searchFrom < text.length;
	if (lineCapBinds) {
		// capLineEnd is the cap-th newline; slice keeps the first cap lines
		// (content only) and the marker restores the line break.
		const candidate = `${text.slice(0, capLineEnd)}${NESTED_SLIM_TRUNCATION_MARKER}`;
		if (Buffer.byteLength(candidate, "utf8") <= NESTED_SLIM_TOOL_RESULT_HEAD_BYTES) {
			// The line cap alone fits the byte budget: drop the tail lines.
			return candidate;
		}
		// Line-capped head still over budget — fall through to the byte cap on
		// the original body (a prefix cut, consistent with the line head).
	}
	if (Buffer.byteLength(text, "utf8") <= NESTED_SLIM_TOOL_RESULT_HEAD_BYTES) {
		// At most cap lines and under the byte budget: nothing to trim.
		return undefined;
	}
	// Byte cap: long lines, few newlines, or no newline at all still get
	// bounded to the head byte budget.
	return truncateUtf8Bytes(text, NESTED_SLIM_TOOL_RESULT_HEAD_BYTES, NESTED_SLIM_TRUNCATION_MARKER);
}

/**
 * Cap an oversized toolResult body to its deterministic head. Tool results are
 * the bulkiest history entries (file reads, grep output); the head usually
 * carries the actionable signal. An already-short result is returned unchanged
 * so re-compression is idempotent.
 */
function slimToolResult(message: AdvisorHistoryMessage): AdvisorHistoryMessage {
	if (!Array.isArray(message.content)) return message;
	// SAFETY: toolResult content is a text/image block array; only text parts
	// contribute to the combined body, and each is validated before use.
	const textParts = (message.content as SlimPart[]).filter(
		(part) => isRecordValue<SlimPart>(part) && part.type === "text" && isStringValue(part.text),
	);
	if (textParts.length === 0) return message;
	// SAFETY: every filtered part is a record with a string `text` (see the
	// guards above), so joining them reads only validated string fields.
	const combined = textParts.map((part) => part.text as string).join("\n");
	const slimmed = slimToolResultText(combined);
	if (slimmed === undefined) return message;
	// The candidate is applied only when it actually shrinks the content: the
	// truncation marker can be longer than the dropped tail for a result that
	// barely exceeds the line cap, so the trimmed body may be larger than the
	// original. Applying it anyway would (a) inflate history instead of
	// relieving the overflow that triggered slimming, and (b) make
	// `degraded`/`savingsBytes` (which count only `after < before`) diverge
	// from the messages actually rewritten. Requiring a strict shrink keeps the
	// count contract exact: every mutated message is counted, every counted
	// message shrank.
	if (Buffer.byteLength(slimmed, "utf8") >= Buffer.byteLength(combined, "utf8")) {
		return message;
	}
	// SAFETY: a trimmed toolResult body is a single text block, a valid
	// toolResult content shape.
	return { ...message, content: [{ type: "text", text: slimmed }] } as AdvisorHistoryMessage;
}

/**
 * Slim the older portion of the nested-session history in place of the
 * nuclear full-clear. Deterministic and idempotent: identical histories slim
 * to identical bytes and a second pass over a slimmed history is a no-op.
 * The newest `NESTED_SLIM_KEEP_RECENT_MESSAGES` messages are kept verbatim.
 */
export function compressNestedMessages(
	messages: readonly AdvisorHistoryMessage[],
): AdvisorNestedSlim {
	const keep = Math.min(NESTED_SLIM_KEEP_RECENT_MESSAGES, messages.length);
	const head = messages.slice(0, messages.length - keep);
	const tail = messages.slice(messages.length - keep);
	const out: AdvisorHistoryMessage[] = [];
	let savingsBytes = 0;
	let degraded = 0;
	for (const message of head) {
		// SAFETY: AdvisorHistoryMessage.content is either a plain string or a
		// content-block array; both are handled by contentBytes and the
		// role-specific slim helpers below.
		const content = message.content as SlimContent;
		const before = contentBytes(content);
		const candidate =
			message.role === "assistant" && hasThinkingBlock(content)
				? stripAssistantThinking(message)
				: message.role === "toolResult"
					? slimToolResult(message)
					: message;
		// SAFETY: stripAssistantThinking and slimToolResult preserve the same
		// string-or-block-array content contract as AdvisorHistoryMessage.
		const after = contentBytes(candidate.content as SlimContent);
		if (after < before) {
			savingsBytes += before - after;
			degraded++;
		}
		out.push(candidate);
	}
	return { messages: [...out, ...tail], savingsBytes, degraded };
}
