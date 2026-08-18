import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	SessionEntry,
	SessionMessageEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { normalizeMemoryTextForDedupe } from "./advice.js";
import { HARD_LIMITS, READ_ONLY_TOOL_NAMES } from "./config.js";
import { redactSecrets, truncateUtf8Bytes, truncateUtf8TailBytes } from "./redaction.js";
import { isRecordValue, isStringValue } from "./value-guards.js";

export const ADVISOR_CUSTOM_TYPE = "pi-advisor-note";
const UPDATE_TRUNCATION_MARKER = "[Older Advisor update content truncated to configured limit]\n";
const REPRIME_TRUNCATION_MARKER =
	"[Older Advisor re-prime content truncated to configured limit]\n";
const TOOL_RESULT_TRUNCATION_MARKER = "\n[Tool result truncated to per-result limit]";
export const MAX_ADVISOR_TOOL_RESULT_BYTES = 64 * 1_024;
export const MAX_ADVISOR_TOOL_RESULT_LINES = 2_000;
const MAX_MEMORY_TOOL_CANDIDATE_ITEMS = 4_096;
const MAX_MEMORY_TOOL_CANDIDATE_BYTES = HARD_LIMITS.maxPendingTranscriptBytes;
const MAX_MEMORY_TOOL_TEXT_INPUT_UTF16_UNITS = HARD_LIMITS.maxProposedMemoryCharacters * 2;

export interface AdvisorCursor {
	lastEntryId?: string;
	expectedIndex: number;
}

export interface RenderedAdvisorDelta {
	text: string;
	redactions: number;
	entryCount: number;
	truncated: boolean;
}

export function cursorAtTail(branch: SessionEntry[]): AdvisorCursor {
	const cursor: AdvisorCursor = { expectedIndex: branch.length };
	const lastEntryId = branch.at(-1)?.id;
	if (lastEntryId !== undefined) cursor.lastEntryId = lastEntryId;
	return cursor;
}

export type AdvisorCursorValidation = "valid" | "transcript-shrunk" | "ancestry-mismatch";

export function validateCursor(
	branch: SessionEntry[],
	cursor: AdvisorCursor,
): AdvisorCursorValidation {
	if (branch.length < cursor.expectedIndex) return "transcript-shrunk";
	if (cursor.expectedIndex === 0) {
		return cursor.lastEntryId === undefined ? "valid" : "ancestry-mismatch";
	}
	return branch[cursor.expectedIndex - 1]?.id === cursor.lastEntryId
		? "valid"
		: "ancestry-mismatch";
}

export function cursorMatches(branch: SessionEntry[], cursor: AdvisorCursor): boolean {
	return validateCursor(branch, cursor) === "valid";
}

export function branchHasNewerInstructionInput(
	branch: SessionEntry[],
	window: AdvisorCursor,
): boolean {
	for (let index = window.expectedIndex; index < branch.length; index++) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type === "custom_message") {
			if (entry.customType !== ADVISOR_CUSTOM_TYPE) return true;
			continue;
		}
		if (!isMessageEntry(entry)) continue;
		const message = entry.message;
		if (message.role === "user" || message.role === "bashExecution") return true;
		if (message.role === "custom" && message.customType !== ADVISOR_CUSTOM_TYPE) return true;
	}
	return false;
}

function isReadOnlyToolName(toolName: string): boolean {
	return (READ_ONLY_TOOL_NAMES as readonly string[]).includes(toolName);
}

function messageContainsMaterialToolCall(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	for (const part of message.content) {
		if (part.type === "toolCall" && !isReadOnlyToolName(part.name)) return true;
	}
	return false;
}

/**
 * True when entries after the window contain materially newer Executor activity.
 *
 * Materially newer activity means a non-read-only tool call or its tool result, a
 * context-included user bash execution, or a compaction or branch-summary entry.
 * User messages, plain assistant text and reasoning, read-only tool calls and their
 * results, and Advisor or other non-mutating extension context never count.
 */
export function branchHasMateriallyNewerExecutorActivity(
	branch: SessionEntry[],
	window: AdvisorCursor,
): boolean {
	for (let index = window.expectedIndex; index < branch.length; index++) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type === "compaction" || entry.type === "branch_summary") return true;
		if (!isMessageEntry(entry)) continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (!isReadOnlyToolName(message.toolName)) return true;
		} else if (message.role === "bashExecution") {
			if (message.excludeFromContext !== true) return true;
		} else if (messageContainsMaterialToolCall(message)) {
			return true;
		}
	}
	return false;
}

function stringValue(value: unknown, fallback = ""): string {
	return isStringValue(value) ? value : fallback;
}

interface UnvalidatedMessageContentPart {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	arguments?: unknown;
}

interface UnvalidatedMemoryToolArguments {
	text?: unknown;
}

function contentText(content: unknown, includeReasoning: boolean): string {
	if (isStringValue(content)) return content;
	if (!Array.isArray(content)) return "";
	return (content as unknown[])
		.map((part) => {
			if (!isRecordValue<UnvalidatedMessageContentPart>(part)) return "";
			const record = part;
			if (record.type === "text") return stringValue(record.text);
			if (record.type === "thinking") {
				return includeReasoning ? `[reasoning]\n${stringValue(record.thinking)}` : "";
			}
			if (record.type === "toolCall") {
				return `[tool call ${stringValue(record.name, "unknown")}] ${JSON.stringify(record.arguments ?? {})}`;
			}
			if (record.type === "image") return "[image omitted]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

interface SerializedEntry {
	text: string;
	toolResult: boolean;
}

function serializeMessage(
	message: AgentMessage,
	includeReasoning: boolean,
): SerializedEntry | undefined {
	switch (message.role) {
		case "user":
			return {
				text: `[Executor user]\n${contentText(message.content, includeReasoning)}`,
				toolResult: false,
			};
		case "assistant":
			return {
				text: `[Executor assistant]\n${contentText(message.content, includeReasoning)}`,
				toolResult: false,
			};
		case "toolResult":
			return {
				text: `[Executor tool result ${message.toolName}${message.isError ? " error" : ""}]\n${contentText(message.content, includeReasoning)}`,
				toolResult: true,
			};
		case "custom":
			if (message.customType === ADVISOR_CUSTOM_TYPE) return undefined;
			return {
				text: `[Executor extension context ${message.customType}]\n${contentText(message.content, includeReasoning)}`,
				toolResult: false,
			};
		case "bashExecution":
			if (message.excludeFromContext) return undefined;
			return {
				text: `[Executor user bash]\n$ ${message.command}\n${message.output}`,
				toolResult: true,
			};
		case "branchSummary":
			return { text: `[Executor branch summary]\n${message.summary}`, toolResult: false };
		case "compactionSummary":
			return { text: `[Executor compaction summary]\n${message.summary}`, toolResult: false };
	}
}

function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function serializeEntry(
	entry: SessionEntry,
	includeReasoning: boolean,
): SerializedEntry | undefined {
	if (isMessageEntry(entry)) return serializeMessage(entry.message, includeReasoning);
	if (entry.type === "custom_message") {
		if (entry.customType === ADVISOR_CUSTOM_TYPE) return undefined;
		return {
			text: `[Executor extension context ${entry.customType}]\n${contentText(entry.content, includeReasoning)}`,
			toolResult: false,
		};
	}
	if (entry.type === "compaction") {
		return { text: `[Executor compaction summary]\n${entry.summary}`, toolResult: false };
	}
	if (entry.type === "branch_summary") {
		return { text: `[Executor branch summary]\n${entry.summary}`, toolResult: false };
	}
	return undefined;
}

interface BoundedText {
	text: string;
	truncated: boolean;
}

function boundToolResult(text: string, maximumBytes: number): BoundedText {
	let lineEnd = -1;
	let searchFrom = 0;
	for (let line = 0; line < MAX_ADVISOR_TOOL_RESULT_LINES; line++) {
		lineEnd = text.indexOf("\n", searchFrom);
		if (lineEnd === -1) break;
		searchFrom = lineEnd + 1;
	}
	const lineTruncated = lineEnd !== -1;
	const lineBounded = lineTruncated
		? `${text.slice(0, lineEnd)}${TOOL_RESULT_TRUNCATION_MARKER}`
		: text;
	const byteBounded = truncateUtf8Bytes(lineBounded, maximumBytes, TOOL_RESULT_TRUNCATION_MARKER);
	return {
		text: byteBounded,
		truncated: lineTruncated || byteBounded !== lineBounded,
	};
}

function addTailTruncationMarker(text: string, maximumBytes: number, marker: string): string {
	const boundedMarker = truncateUtf8Bytes(marker, maximumBytes, "");
	const availableBytes = Math.max(0, maximumBytes - Buffer.byteLength(boundedMarker, "utf8"));
	return `${boundedMarker}${truncateUtf8TailBytes(text, availableBytes, "")}`;
}

function renderBoundedEntries(
	entries: SessionEntry[],
	maximumTokens: number,
	truncationMarker: string,
	includeReasoning = true,
): RenderedAdvisorDelta {
	const maximumBytes = Math.max(1, maximumTokens * 4);
	const perToolResultBytes = Math.min(maximumBytes, MAX_ADVISOR_TOOL_RESULT_BYTES);
	let redactions = 0;
	let retained = "";
	let hasRetainedEntry = false;
	let overallTruncated = false;
	let toolResultTruncated = false;

	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === undefined) continue;
		const serialized = serializeEntry(entry, includeReasoning);
		if (serialized === undefined) continue;
		const redacted = redactSecrets(serialized.text);
		redactions += redacted.redactions;
		const bounded = serialized.toolResult
			? boundToolResult(redacted.text, perToolResultBytes)
			: { text: redacted.text, truncated: false };
		toolResultTruncated ||= bounded.truncated;
		if (overallTruncated) continue;

		const entryBytes = Buffer.byteLength(bounded.text, "utf8");
		const collectionText =
			entryBytes > maximumBytes
				? truncateUtf8TailBytes(bounded.text, maximumBytes, "")
				: bounded.text;
		const candidate = hasRetainedEntry ? `${collectionText}\n\n${retained}` : collectionText;
		if (entryBytes > maximumBytes || Buffer.byteLength(candidate, "utf8") > maximumBytes) {
			retained = truncateUtf8TailBytes(candidate, maximumBytes, "");
			overallTruncated = true;
		} else {
			retained = candidate;
		}
		hasRetainedEntry = true;
	}

	return {
		text: overallTruncated
			? addTailTruncationMarker(retained, maximumBytes, truncationMarker)
			: retained,
		redactions,
		entryCount: entries.length,
		truncated: overallTruncated || toolResultTruncated,
	};
}

function hasMaterialExecutorActivity(entry: SessionEntry): boolean {
	if (entry.type === "custom") return false;
	if (entry.type === "custom_message") return entry.customType !== ADVISOR_CUSTOM_TYPE;
	if (entry.type === "compaction" || entry.type === "branch_summary") return true;
	if (!isMessageEntry(entry)) return false;
	const message = entry.message;
	if (message.role === "assistant") {
		return message.content.some((content) => content.type === "toolCall");
	}
	if (message.role === "custom") return message.customType !== ADVISOR_CUSTOM_TYPE;
	if (message.role === "bashExecution") return !message.excludeFromContext;
	return true;
}

export function isMeaningfulExecutorTurn(event: TurnEndEvent, entries: SessionEntry[]): boolean {
	if (event.message.role !== "assistant") return false;
	if (event.message.stopReason === "aborted") return false;
	let latestAdvisorNoteIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom_message" && entry.customType === ADVISOR_CUSTOM_TYPE) {
			latestAdvisorNoteIndex = index;
			break;
		}
	}
	const hasExecutorUserMessage = entries.some(
		(entry) => entry.type === "message" && entry.message.role === "user",
	);
	if (
		latestAdvisorNoteIndex >= 0 &&
		!hasExecutorUserMessage &&
		!entries.slice(latestAdvisorNoteIndex + 1).some(hasMaterialExecutorActivity)
	) {
		return false;
	}
	const assistantContent = contentText(event.message.content, true).trim();
	return assistantContent.length > 0 || event.toolResults.length > 0;
}

export function successfulMemoryToolTexts(
	entries: SessionEntry[],
	maxItems: number,
	maxBytes: number,
): Set<string> {
	if (!Number.isInteger(maxItems) || maxItems < 0) {
		throw new RangeError("Successful Memory text item budget must be a non-negative integer");
	}
	if (!Number.isInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError("Successful Memory text byte budget must be a non-negative integer");
	}
	interface Candidate {
		text: string;
		bytes: number;
		toolName: "memory_save" | "memory_suggest";
		entryIndex: number;
	}
	const calls = new Map<string, Candidate>();
	let candidateBytes = 0;
	for (const [entryIndex, entry] of entries.entries()) {
		if (!isMessageEntry(entry) || entry.message.role !== "assistant") continue;
		for (const content of entry.message.content) {
			if (
				content.type !== "toolCall" ||
				(content.name !== "memory_save" && content.name !== "memory_suggest")
			) {
				continue;
			}
			const text = (content.arguments as UnvalidatedMemoryToolArguments).text;
			if (
				!isStringValue(text) ||
				text.length > MAX_MEMORY_TOOL_TEXT_INPUT_UTF16_UNITS ||
				text.trim().length === 0
			) {
				continue;
			}
			const normalized = normalizeMemoryTextForDedupe(text);
			const normalizedBytes = Buffer.byteLength(normalized, "utf8");
			if (normalized.length === 0 || normalizedBytes > MAX_MEMORY_TOOL_CANDIDATE_BYTES) {
				continue;
			}
			const replaced = calls.get(content.id);
			if (replaced !== undefined) {
				calls.delete(content.id);
				candidateBytes -= replaced.bytes;
			}
			while (
				calls.size >= MAX_MEMORY_TOOL_CANDIDATE_ITEMS ||
				candidateBytes + normalizedBytes > MAX_MEMORY_TOOL_CANDIDATE_BYTES
			) {
				const oldestId = calls.keys().next().value;
				if (oldestId === undefined) break;
				const oldest = calls.get(oldestId);
				calls.delete(oldestId);
				if (oldest !== undefined) candidateBytes -= oldest.bytes;
			}
			calls.set(content.id, {
				text: normalized,
				bytes: normalizedBytes,
				toolName: content.name,
				entryIndex,
			});
			candidateBytes += normalizedBytes;
		}
	}

	const resolved = new Set<string>();
	const successfulIds = new Set<string>();
	for (const [entryIndex, entry] of entries.entries()) {
		if (!isMessageEntry(entry) || entry.message.role !== "toolResult") continue;
		const message = entry.message;
		const candidate = calls.get(message.toolCallId);
		if (
			candidate === undefined ||
			resolved.has(message.toolCallId) ||
			entryIndex <= candidate.entryIndex
		) {
			continue;
		}
		resolved.add(message.toolCallId);
		if (!message.isError && message.toolName === candidate.toolName) {
			successfulIds.add(message.toolCallId);
		}
	}

	const newestFirst: string[] = [];
	const seenTexts = new Set<string>();
	let retainedBytes = 0;
	const candidates = [...calls.entries()];
	for (let index = candidates.length - 1; index >= 0; index--) {
		const candidateEntry = candidates[index];
		if (candidateEntry === undefined) continue;
		const [id, candidate] = candidateEntry;
		if (!successfulIds.has(id) || seenTexts.has(candidate.text)) continue;
		seenTexts.add(candidate.text);
		if (newestFirst.length >= maxItems) break;
		if (retainedBytes + candidate.bytes > maxBytes) continue;
		newestFirst.push(candidate.text);
		retainedBytes += candidate.bytes;
	}
	return new Set(newestFirst.reverse());
}

export function renderAdvisorDelta(
	entries: SessionEntry[],
	maxUpdateTokens: number,
): RenderedAdvisorDelta {
	return renderBoundedEntries(entries, maxUpdateTokens, UPDATE_TRUNCATION_MARKER);
}

/**
 * Serialize a redacted, bounded current-branch snapshot for lifecycle and configuration Re-prime.
 */
export function renderAdvisorReprimeSnapshot(
	entries: SessionEntry[],
	maxReprimeTokens: number,
): RenderedAdvisorDelta {
	return renderBoundedEntries(entries, maxReprimeTokens, REPRIME_TRUNCATION_MARKER);
}
