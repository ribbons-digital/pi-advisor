import { createHash } from "node:crypto";

import { StringEnum, validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import { HARD_LIMITS, type AdvisorConfig } from "./config.js";
import {
	MEMORY_SUGGESTION_BASES,
	MEMORY_SUGGESTION_CATEGORIES,
	type MemorySuggestionBasis,
	type MemorySuggestionCategory,
} from "./memory-suggestions.js";
import { boundedFindingLabel } from "./mutes.js";
import { escapeXmlAttribute, escapeXmlText } from "./presentation.js";
import { estimateTokens, redactSecrets } from "./redaction.js";

export {
	MEMORY_SUGGESTION_BASES,
	MEMORY_SUGGESTION_CATEGORIES,
	type MemorySuggestionBasis,
	type MemorySuggestionCategory,
} from "./memory-suggestions.js";

export type AdviceSeverity = "nit" | "concern" | "blocker";

interface AcceptedAdviceBase {
	note: string;
	truncated: boolean;
	originalCharacters: number;
	originalEstimatedTokens: number;
	createdAt: number;
}

export interface AcceptedReviewAdvice extends AcceptedAdviceBase {
	intent: "review";
	severity: AdviceSeverity;
	findingKeyHash?: string;
	/** Bounded redacted display label of the raw findingKey; never command input. */
	findingKey?: string;
}

export interface AcceptedMemorySuggestion extends AcceptedAdviceBase {
	intent: "memory-suggestion";
	memory: {
		text: string;
		category: MemorySuggestionCategory;
		basis: MemorySuggestionBasis;
	};
}

export type AcceptedAdvice = AcceptedReviewAdvice | AcceptedMemorySuggestion;

export interface MemorySuggestionPolicyContext {
	enabled: boolean;
	capabilityAvailable: boolean;
	turnNumber: number;
	now: number;
	admittedCount: number;
	lastDeliveredTurn?: number;
	lastDeliveredAt?: number;
	successfulMemoryTexts: ReadonlySet<string>;
}

export interface AdviceCollector {
	accepted?: AcceptedAdvice;
	validCalls: number;
	suppressedCalls: number;
	memoryPolicySuppressedCalls: number;
	memoryLimitSuppressedCalls: number;
	memoryPolicy?: MemorySuggestionPolicyContext;
}

const MEMORY_ARGUMENT_GUIDANCE =
	'When intent is "memory-suggestion", provide memory.text, memory.category, and memory.basis. Otherwise omit memory.';
const MAX_FINDING_KEY_CHARACTERS = 200;

export const ADVISE_WIRE_SCHEMA = Type.Object({
	note: Type.String({
		minLength: 1,
		description: "Concise rationale for the review finding or Memory suggestion.",
	}),
	intent: Type.Optional(
		StringEnum(["review", "memory-suggestion"] as const, {
			description: MEMORY_ARGUMENT_GUIDANCE,
		}),
	),
	severity: Type.Optional(StringEnum(["nit", "concern", "blocker"] as const)),
	findingKey: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: MAX_FINDING_KEY_CHARACTERS,
			description:
				"Canonical identity for exactly one concrete underlying defect. Reuse it for paraphrases or severity changes of that defect; never reuse it for a materially different defect.",
		}),
	),
	memory: Type.Optional(
		Type.Object(
			{
				text: Type.Optional(Type.String()),
				category: Type.Optional(StringEnum(MEMORY_SUGGESTION_CATEGORIES)),
				basis: Type.Optional(StringEnum(MEMORY_SUGGESTION_BASES)),
			},
			{ description: MEMORY_ARGUMENT_GUIDANCE },
		),
	),
});

export type AdviseWireInput = Static<typeof ADVISE_WIRE_SCHEMA>;

const STRICT_MEMORY_ARGUMENT_GUIDANCE =
	"When intent is memory-suggestion, provide memory.text, memory.category, and memory.basis. Otherwise use null for memory.";

const STRICT_ADVISE_WIRE_OBJECT = Type.Object(
	{
		note: Type.Unsafe<unknown>({
			type: "string",
			description: "Concise rationale for the review finding or Memory suggestion.",
		}),
		intent: Type.Unsafe<unknown>({
			type: ["string", "null"],
			enum: ["review", "memory-suggestion", null],
			description: STRICT_MEMORY_ARGUMENT_GUIDANCE,
		}),
		severity: Type.Unsafe<unknown>({
			type: ["string", "null"],
			enum: ["nit", "concern", "blocker", null],
		}),
		findingKey: Type.Unsafe<unknown>({
			type: ["string", "null"],
			description:
				"Canonical identity for exactly one concrete underlying defect. Reuse it for paraphrases or severity changes of that defect; never reuse it for a materially different defect. Use null when absent.",
		}),
		memory: Type.Unsafe<unknown>({
			type: ["object", "null"],
			additionalProperties: false,
			required: ["text", "category", "basis"],
			properties: {
				text: { type: ["string", "null"] },
				category: {
					type: ["string", "null"],
					enum: [...MEMORY_SUGGESTION_CATEGORIES, null],
				},
				basis: {
					type: ["string", "null"],
					enum: [...MEMORY_SUGGESTION_BASES, null],
				},
			},
			description: STRICT_MEMORY_ARGUMENT_GUIDANCE,
		}),
	},
	{ additionalProperties: false },
);

/** Provider-compatible, closed schema used only when constrained sampling is available. */
export const STRICT_ADVISE_WIRE_SCHEMA = Type.Unsafe<unknown>(STRICT_ADVISE_WIRE_OBJECT);

const ADVISE_WIRE_VALIDATION_TOOL = {
	name: "advise",
	description: "Validate internal Advisor wire input.",
	parameters: ADVISE_WIRE_SCHEMA,
};

export interface ParsedReviewAdviceInput {
	note: string;
	intent: "review";
	severity?: AdviceSeverity;
	findingKey?: string;
}

export interface ParsedMemorySuggestionInput {
	note: string;
	intent: "memory-suggestion";
	memory: AcceptedMemorySuggestion["memory"];
}

export type ParsedAdviceInput = ParsedReviewAdviceInput | ParsedMemorySuggestionInput;

function isOptionalEnum<T, const Values extends readonly string[]>(
	value: T,
	values: Values,
): value is T & (Values[number] | undefined) {
	return value === undefined || (typeof value === "string" && values.includes(value));
}

function hasValidLocalStringBounds(input: Readonly<Record<string, unknown>>): boolean {
	return (
		(typeof input.note !== "string" || Check(ADVISE_WIRE_SCHEMA.properties.note, input.note)) &&
		(typeof input.findingKey !== "string" ||
			Check(ADVISE_WIRE_SCHEMA.properties.findingKey, input.findingKey))
	);
}

export function isAdviseWireInput(input: unknown): input is AdviseWireInput {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
	const wire = input as Readonly<Record<string, unknown>>;
	const { note, intent, severity, findingKey, memory } = wire;
	if (
		typeof note !== "string" ||
		!isOptionalEnum(intent, ["review", "memory-suggestion"]) ||
		!isOptionalEnum(severity, ["nit", "concern", "blocker"]) ||
		(findingKey !== undefined && typeof findingKey !== "string") ||
		(memory !== undefined &&
			(typeof memory !== "object" || memory === null || Array.isArray(memory)))
	) {
		return false;
	}
	if (memory !== undefined) {
		const nested = memory as Readonly<Record<string, unknown>>;
		if (
			(nested.text !== undefined && typeof nested.text !== "string") ||
			!isOptionalEnum(nested.category, MEMORY_SUGGESTION_CATEGORIES) ||
			!isOptionalEnum(nested.basis, MEMORY_SUGGESTION_BASES)
		) {
			return false;
		}
	}
	if (!hasValidLocalStringBounds(wire)) return false;
	try {
		validateToolArguments(ADVISE_WIRE_VALIDATION_TOOL, {
			type: "toolCall",
			id: "advise-wire-validation",
			name: "advise",
			arguments: wire,
		});
		return true;
	} catch {
		return false;
	}
}

export function parseAdviseWireInput(input: AdviseWireInput): ParsedAdviceInput | undefined {
	if (input.intent === "memory-suggestion") {
		const memory = input.memory;
		if (
			memory?.text === undefined ||
			memory.text.trim().length === 0 ||
			memory.category === undefined ||
			memory.basis === undefined
		) {
			return undefined;
		}
		return {
			note: input.note,
			intent: "memory-suggestion",
			memory: {
				text: memory.text,
				category: memory.category,
				basis: memory.basis,
			},
		};
	}
	return {
		note: input.note,
		intent: "review",
		...(input.severity === undefined ? {} : { severity: input.severity }),
		...(input.findingKey === undefined ? {} : { findingKey: input.findingKey }),
	};
}

const CONTENT_FREE = new Set([
	"stop",
	"done",
	"complete",
	"ok",
	"lgtm",
	"looks good",
	"all good",
	"no issue",
	"no issues",
	"no concerns",
	"nothing to add",
	"nothing to report",
	"continue",
	"on track",
]);
const TRUNCATION_MARKER = "\n[Advisory note truncated to configured limit]";

export function normalizeContentFreeAdvice(input: string): string {
	return input
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function foldProseCaseOutsideCodeSpans(input: string): string | undefined {
	const foldProse = (value: string): string =>
		value.toLocaleLowerCase("en-US").replace(/\s+/g, " ");
	let output = "";
	let cursor = 0;
	while (cursor < input.length) {
		const openingStart = input.indexOf("`", cursor);
		if (openingStart === -1) {
			return `${output}${foldProse(input.slice(cursor))}`;
		}
		output += foldProse(input.slice(cursor, openingStart));
		let openingEnd = openingStart;
		while (input[openingEnd] === "`") openingEnd++;
		const delimiterLength = openingEnd - openingStart;
		let search = openingEnd;
		let closingStart = -1;
		let closingEnd = -1;
		while (search < input.length) {
			const candidateStart = input.indexOf("`", search);
			if (candidateStart === -1) break;
			let candidateEnd = candidateStart;
			while (input[candidateEnd] === "`") candidateEnd++;
			if (candidateEnd - candidateStart === delimiterLength) {
				closingStart = candidateStart;
				closingEnd = candidateEnd;
				break;
			}
			search = candidateEnd;
		}
		if (closingStart === -1) return undefined;
		output += input.slice(openingStart, closingEnd);
		cursor = closingEnd;
	}
	return output;
}

export function normalizeAdviceForDedupe(input: string): string {
	const normalized = input.normalize("NFKC");
	const caseFolded = foldProseCaseOutsideCodeSpans(normalized);
	if (caseFolded === undefined) return normalized.replace(/\s+/g, " ").trim();
	return caseFolded
		.trim()
		.replace(/(?<=\S)[.,;:?!…]+$/gu, "")
		.trim();
}

export function normalizeMemoryTextForDedupe(input: string): string {
	return normalizeAdviceForDedupe(input);
}

export type AdviceDedupeIdentity =
	| (Pick<AcceptedReviewAdvice, "note"> &
			Partial<Pick<AcceptedReviewAdvice, "severity" | "findingKeyHash">> & {
				intent?: "review";
			})
	| Pick<AcceptedMemorySuggestion, "intent" | "memory">;

function findingKeyHash(input: string): string | undefined {
	const normalized = normalizeAdviceForDedupe(input);
	if (normalized.length === 0) return undefined;
	return createHash("sha256").update(`review-finding:${normalized}`).digest("hex");
}

export function adviceDedupeKey(advice: AdviceDedupeIdentity): string {
	const identity =
		advice.intent === "memory-suggestion"
			? JSON.stringify([
					"memory-suggestion",
					advice.memory.category,
					advice.memory.basis,
					normalizeMemoryTextForDedupe(advice.memory.text),
				])
			: advice.findingKeyHash === undefined
				? JSON.stringify(["review", normalizeAdviceForDedupe(advice.note)])
				: JSON.stringify(["review", "finding", advice.findingKeyHash]);
	return createHash("sha256").update(identity).digest("hex");
}

const SEVERITY_RANK = { nit: 0, concern: 1, blocker: 2 } satisfies Record<AdviceSeverity, number>;

export function isAdviceSeverity<T>(value: T): value is T & AdviceSeverity {
	return value === "nit" || value === "concern" || value === "blocker";
}

function isStrictlyHigherSeverity(candidate: AdviceSeverity, baseline: AdviceSeverity): boolean {
	return SEVERITY_RANK[candidate] > SEVERITY_RANK[baseline];
}

/** 64-bit SimHash over normalized-note tokens; identical notes produce identical signatures. */
export function noteSignature(input: string): bigint {
	const tokens = normalizeAdviceForDedupe(input)
		.split(/\s+/u)
		.filter((token) => token.length > 0);
	const weights = new Int32Array(64);
	for (const token of tokens) {
		const value = createHash("sha256").update(`note-token:${token}`).digest().readBigUInt64BE(0);
		for (let bit = 0; bit < 64; bit++) {
			const current = weights[bit] ?? 0;
			weights[bit] = current + ((value & (1n << BigInt(bit))) === 0n ? -1 : 1);
		}
	}
	let signature = 0n;
	for (let bit = 0; bit < 64; bit++) {
		if ((weights[bit] ?? 0) > 0) signature |= 1n << BigInt(bit);
	}
	return signature;
}

export function hammingDistance64(left: bigint, right: bigint): number {
	let difference = left ^ right;
	let distance = 0;
	while (difference !== 0n) {
		difference &= difference - 1n;
		distance++;
	}
	return distance;
}

export function noteSimilarity(left: bigint, right: bigint): number {
	return 1 - hammingDistance64(left, right) / 64;
}

export type AdviceDedupeTag = "possible-duplicate" | "re-raised";

export type DedupeDecision =
	| { outcome: "suppress" }
	| { outcome: "deliver"; tag?: AdviceDedupeTag };

export interface DedupePolicy {
	similarityRedeliveryThreshold: number;
	reRaiseMinTurns: number;
}

export interface PersistedDedupeKeyMetadata {
	severity: AdviceSeverity;
	/** 16 lowercase hex characters encoding the 64-bit SimHash signature. */
	signature: string;
	lastDeliveryTurn: number;
}

export interface PersistedDedupeEntry {
	hash: string;
	metadata?: PersistedDedupeKeyMetadata;
}

export interface AdviceDedupeEntryState {
	metadata?: {
		severity: AdviceSeverity;
		signature: bigint;
		lastDeliveryTurn: number;
	};
}

export interface AdviceDedupeSnapshot {
	key: string;
	entry: AdviceDedupeEntryState | undefined;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SIGNATURE_PATTERN = /^[a-f0-9]{16}$/u;

function metadataFor(
	advice: AdviceDedupeIdentity,
	turnNumber: number | undefined,
): AdviceDedupeEntryState["metadata"] {
	if (
		turnNumber === undefined ||
		advice.intent !== "review" ||
		advice.findingKeyHash === undefined ||
		advice.severity === undefined
	) {
		return undefined;
	}
	return {
		severity: advice.severity,
		signature: noteSignature(advice.note),
		lastDeliveryTurn: turnNumber,
	};
}

export class BoundedAdviceDedupe {
	private readonly entries = new Map<string, AdviceDedupeEntryState>();

	constructor(readonly capacity = 4_096) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError("Advice dedupe capacity must be a positive integer");
		}
	}

	has(advice: AdviceDedupeIdentity): boolean {
		return this.entries.has(adviceDedupeKey(advice));
	}

	/**
	 * Decides whether a note may deliver. A key without metadata keeps exact
	 * pre-Q5 suppress-always behavior with no similarity delivery and no re-raise.
	 */
	decide(advice: AdviceDedupeIdentity, turnNumber: number, policy: DedupePolicy): DedupeDecision {
		const entry = this.entries.get(adviceDedupeKey(advice));
		if (entry === undefined) return { outcome: "deliver" };
		if (advice.intent !== "review" || advice.findingKeyHash === undefined) {
			return { outcome: "suppress" };
		}
		const metadata = entry.metadata;
		if (metadata === undefined) return { outcome: "suppress" };
		const signature = noteSignature(advice.note);
		if (
			policy.reRaiseMinTurns > 0 &&
			advice.severity !== undefined &&
			isStrictlyHigherSeverity(advice.severity, metadata.severity) &&
			turnNumber - metadata.lastDeliveryTurn >= policy.reRaiseMinTurns
		) {
			return { outcome: "deliver", tag: "re-raised" };
		}
		if (
			policy.similarityRedeliveryThreshold > 0 &&
			noteSimilarity(signature, metadata.signature) < policy.similarityRedeliveryThreshold
		) {
			return { outcome: "deliver", tag: "possible-duplicate" };
		}
		return { outcome: "suppress" };
	}

	add(advice: AdviceDedupeIdentity, turnNumber?: number): boolean {
		const key = adviceDedupeKey(advice);
		const metadata = metadataFor(advice, turnNumber);
		const existing = this.entries.get(key);
		if (existing !== undefined) {
			if (metadata !== undefined && existing.metadata !== undefined) {
				existing.metadata = {
					severity: isStrictlyHigherSeverity(metadata.severity, existing.metadata.severity)
						? metadata.severity
						: existing.metadata.severity,
					signature: metadata.signature,
					lastDeliveryTurn: metadata.lastDeliveryTurn,
				};
			} else if (metadata !== undefined) {
				// Back-fill metadata onto an entry inserted without a turn (for example a
				// restored pending note emitted before its finding key carried metadata),
				// so the key gains similarity and re-raise behavior instead of staying
				// permanently metadata-free.
				existing.metadata = metadata;
			}
			return false;
		}
		this.entries.set(key, metadata === undefined ? {} : { metadata });
		if (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		return true;
	}

	delete(advice: AdviceDedupeIdentity): boolean {
		return this.entries.delete(adviceDedupeKey(advice));
	}

	/** Captures the entry state before an `add` so a failed delivery can restore it. */
	snapshotEntry(advice: AdviceDedupeIdentity): AdviceDedupeSnapshot {
		const key = adviceDedupeKey(advice);
		const entry = this.entries.get(key);
		return {
			key,
			entry:
				entry === undefined
					? undefined
					: entry.metadata === undefined
						? {}
						: { metadata: { ...entry.metadata } },
		};
	}

	/**
	 * Restores the captured pre-add entry state: deletes a newly inserted key or
	 * replaces the in-place metadata update, preserving insertion order.
	 */
	restoreEntry(snapshot: AdviceDedupeSnapshot): void {
		if (snapshot.entry === undefined) {
			this.entries.delete(snapshot.key);
			return;
		}
		this.entries.set(snapshot.key, snapshot.entry);
	}

	clear(): void {
		this.entries.clear();
	}

	exportNewestEntries(
		maximum: number,
		excludedKeys: ReadonlySet<string> = new Set(),
	): PersistedDedupeEntry[] {
		if (!Number.isInteger(maximum) || maximum < 0) {
			throw new RangeError("Advice dedupe export bound must be a non-negative integer");
		}
		if (maximum === 0) return [];
		const newest: PersistedDedupeEntry[] = [];
		for (const [key, entry] of [...this.entries].reverse()) {
			if (excludedKeys.has(key)) continue;
			const metadata = entry.metadata;
			newest.push(
				metadata === undefined
					? { hash: key }
					: {
							hash: key,
							metadata: {
								severity: metadata.severity,
								signature: metadata.signature.toString(16).padStart(16, "0"),
								lastDeliveryTurn: metadata.lastDeliveryTurn,
							},
						},
			);
			if (newest.length === maximum) break;
		}
		return newest.reverse();
	}

	restoreEntries(entries: readonly PersistedDedupeEntry[]): void {
		for (const entry of entries) {
			if (!HASH_PATTERN.test(entry.hash) || this.entries.has(entry.hash)) continue;
			const metadata = entry.metadata;
			if (
				metadata !== undefined &&
				(!isAdviceSeverity(metadata.severity) ||
					!SIGNATURE_PATTERN.test(metadata.signature) ||
					!Number.isSafeInteger(metadata.lastDeliveryTurn) ||
					metadata.lastDeliveryTurn < 1)
			) {
				continue;
			}
			this.entries.set(entry.hash, {
				...(metadata === undefined
					? {}
					: {
							metadata: {
								severity: metadata.severity,
								signature: BigInt(`0x${metadata.signature}`),
								lastDeliveryTurn: metadata.lastDeliveryTurn,
							},
						}),
			});
			if (this.entries.size > this.capacity) {
				const oldest = this.entries.keys().next().value;
				if (oldest !== undefined) this.entries.delete(oldest);
			}
		}
	}

	get size(): number {
		return this.entries.size;
	}
}

export function isContentFreeAdvice(note: string): boolean {
	const normalized = normalizeContentFreeAdvice(note);
	return normalized.length === 0 || CONTENT_FREE.has(normalized);
}

function truncateCharacters(
	input: string,
	maximumCharacters: number,
	maximumUtf16Units: number,
): string {
	const marker = Array.from(TRUNCATION_MARKER);
	while (marker.length > maximumCharacters || marker.join("").length > maximumUtf16Units) {
		marker.pop();
	}
	const markerText = marker.join("");
	const output: string[] = [];
	let utf16Units = 0;
	for (const character of input) {
		if (output.length + marker.length >= maximumCharacters) break;
		if (utf16Units + character.length + markerText.length > maximumUtf16Units) break;
		output.push(character);
		utf16Units += character.length;
	}
	return `${output.join("")}${markerText}`;
}

function boundNote(note: string, config: AdvisorConfig): AcceptedAdviceBase {
	const safeNote = redactSecrets(note).text;
	const originalCharacters = Array.from(safeNote).length;
	const originalEstimatedTokens = estimateTokens(safeNote);
	const maxCharacters = Math.min(
		config.limits.maxAdviceCharacters,
		HARD_LIMITS.maxAdviceCharacters,
	);
	const maxTokens = Math.min(config.limits.maxAdviceTokens, HARD_LIMITS.maxAdviceTokens);
	const truncated = originalCharacters > maxCharacters || originalEstimatedTokens > maxTokens;
	return {
		note: truncated ? truncateCharacters(safeNote, maxCharacters, maxTokens * 4) : safeNote,
		truncated,
		originalCharacters,
		originalEstimatedTokens,
		createdAt: Date.now(),
	};
}

export function boundAdvice(note: string, config: AdvisorConfig): AcceptedReviewAdvice {
	return { ...boundNote(note, config), intent: "review", severity: "concern" };
}

function suppressMemory(collector: AdviceCollector, kind: "policy" | "limit"): void {
	collector.suppressedCalls++;
	if (kind === "policy") collector.memoryPolicySuppressedCalls++;
	else collector.memoryLimitSuppressedCalls++;
}

function acceptMemorySuggestion(
	input: {
		note: string;
		memory: AcceptedMemorySuggestion["memory"];
	},
	config: AdvisorConfig,
	collector: AdviceCollector,
): AcceptedMemorySuggestion | undefined {
	const policy = collector.memoryPolicy;
	if (
		policy === undefined ||
		!policy.enabled ||
		!policy.capabilityAvailable ||
		input.note.trim().length === 0 ||
		input.memory.text.trim().length === 0 ||
		isContentFreeAdvice(input.note) ||
		isContentFreeAdvice(input.memory.text)
	) {
		suppressMemory(collector, "policy");
		return undefined;
	}

	const redactedNote = redactSecrets(input.note);
	const redactedMemory = redactSecrets(input.memory.text);
	if (redactedNote.redactions > 0 || redactedMemory.redactions > 0) {
		suppressMemory(collector, "policy");
		return undefined;
	}
	const proposedCharacters = Array.from(input.memory.text).length;
	const proposedTokens = estimateTokens(input.memory.text);
	const maximumCharacters = Math.min(
		config.memorySuggestions.maxProposedMemoryCharacters,
		HARD_LIMITS.maxProposedMemoryCharacters,
	);
	const maximumTokens = Math.min(
		config.memorySuggestions.maxProposedMemoryTokens,
		HARD_LIMITS.maxProposedMemoryTokens,
	);
	if (proposedCharacters > maximumCharacters || proposedTokens > maximumTokens) {
		suppressMemory(collector, "policy");
		return undefined;
	}
	const normalizedText = normalizeMemoryTextForDedupe(input.memory.text);
	if (policy.successfulMemoryTexts.has(normalizedText)) {
		suppressMemory(collector, "policy");
		return undefined;
	}
	if (
		policy.admittedCount >= config.memorySuggestions.sessionSuggestionCap ||
		(policy.lastDeliveredTurn !== undefined &&
			policy.turnNumber - policy.lastDeliveredTurn <
				config.memorySuggestions.minTurnsBetweenSuggestions) ||
		(policy.lastDeliveredAt !== undefined &&
			policy.now - policy.lastDeliveredAt < config.memorySuggestions.minIntervalMs)
	) {
		suppressMemory(collector, "limit");
		return undefined;
	}
	return {
		...boundNote(input.note, config),
		intent: "memory-suggestion",
		memory: { ...input.memory },
	};
}

export type AdviceDelivery = "active" | "deferred";
export type MemorySuggestionQueueState = "could-not-queue";

export function formatAdviceForDelivery(
	advice: AcceptedAdvice,
	delivery: AdviceDelivery,
	stale: boolean,
	queueState?: MemorySuggestionQueueState,
	restoredAfterResume = false,
	tag?: AdviceDedupeTag,
): string {
	if (advice.intent === "memory-suggestion") {
		const attributes = [
			`intent="${escapeXmlAttribute(advice.intent)}"`,
			`category="${escapeXmlAttribute(advice.memory.category)}"`,
			`basis="${escapeXmlAttribute(advice.memory.basis)}"`,
			`delivery="${escapeXmlAttribute(delivery)}"`,
			`stale="${escapeXmlAttribute(String(stale))}"`,
			...(restoredAfterResume ? [`restored-after-resume="true"`] : []),
			...(queueState === undefined ? [] : [`queue-state="${escapeXmlAttribute(queueState)}"`]),
		];
		const resumeWarning = restoredAfterResume
			? "This deferred suggestion was restored after resume and may be stale. "
			: "";
		const guidance =
			queueState === "could-not-queue"
				? `${resumeWarning}The compatible memory_suggest capability is no longer available. Do not attempt this tool call. Briefly tell the user the proposal could not be queued.`
				: `${resumeWarning}${stale ? "First verify that this still applies. " : ""}Verify or revise the proposed durable memory, then call memory_suggest with the chosen text, category, and status "pending" without asking for another confirmation. If the proposal is unsuitable, briefly explain why to the user.`;
		return `<advisor-note ${attributes.join(" ")}>\n<rationale>${escapeXmlText(advice.note)}</rationale>\n<proposed-memory>${escapeXmlText(advice.memory.text)}</proposed-memory>\n<guidance>${escapeXmlText(guidance)}</guidance>\n</advisor-note>`;
	}
	const guidance = stale
		? "Verify this still applies, then weigh it rather than obeying blindly."
		: "Weigh this rather than obeying blindly.";
	const attributes = [
		`intent="${escapeXmlAttribute("review")}"`,
		`severity="${escapeXmlAttribute(advice.severity)}"`,
		`delivery="${escapeXmlAttribute(delivery)}"`,
		`stale="${escapeXmlAttribute(String(stale))}"`,
		...(restoredAfterResume ? [`restored-after-resume="true"`] : []),
		...(tag === undefined ? [] : [`tag="${escapeXmlAttribute(tag)}"`]),
	];
	const resumeWarning = restoredAfterResume
		? "This deferred advice was restored after resume and may be stale. "
		: "";
	return `<advisor-note ${attributes.join(" ")}>\n<note>${escapeXmlText(advice.note)}</note>\n<guidance>${escapeXmlText(`${resumeWarning}${guidance}`)}</guidance>\n</advisor-note>`;
}

async function executeAdviseWireInput(
	id: string,
	params: AdviseWireInput,
	config: AdvisorConfig,
	collector: AdviceCollector,
	onExecutionStart?: (toolCallId: string) => void | Promise<void>,
) {
	await onExecutionStart?.(id);
	collector.validCalls++;
	const input = parseAdviseWireInput(params);
	if (input === undefined) {
		suppressMemory(collector, "policy");
	} else if (input.intent === "memory-suggestion") {
		if (collector.accepted?.intent === "review") {
			suppressMemory(collector, "policy");
		} else if (collector.accepted !== undefined) {
			collector.suppressedCalls++;
		} else {
			const accepted = acceptMemorySuggestion(input, config, collector);
			if (accepted !== undefined) collector.accepted = accepted;
		}
	} else if (isContentFreeAdvice(input.note)) {
		collector.suppressedCalls++;
	} else if (collector.accepted?.intent === "review") {
		collector.suppressedCalls++;
	} else {
		if (collector.accepted?.intent === "memory-suggestion") {
			suppressMemory(collector, "policy");
		}
		const semanticHash =
			input.findingKey === undefined ? undefined : findingKeyHash(input.findingKey);
		const displayLabel =
			input.findingKey === undefined ? undefined : boundedFindingLabel(input.findingKey);
		collector.accepted = {
			...boundAdvice(input.note, config),
			severity: input.severity ?? "concern",
			...(semanticHash === undefined ? {} : { findingKeyHash: semanticHash }),
			...(displayLabel === undefined ? {} : { findingKey: displayLabel }),
		};
	}
	return {
		content: [{ type: "text" as const, text: "Recorded." }],
		details: {},
		terminate: true,
	};
}

export function createAdviseTool(
	config: AdvisorConfig,
	collector: AdviceCollector,
	onExecutionStart?: (toolCallId: string) => void | Promise<void>,
): ToolDefinition<typeof ADVISE_WIRE_SCHEMA> {
	return {
		name: "advise",
		label: "advise",
		description: `Record at most one concise material review note or eligible durable Memory suggestion. Do not call this tool when the Executor is on track. ${MEMORY_ARGUMENT_GUIDANCE}`,
		parameters: ADVISE_WIRE_SCHEMA,
		prepareArguments(args) {
			if (!isAdviseWireInput(args)) {
				throw new Error("Advise arguments did not match the internal schema");
			}
			return args;
		},
		execute(id, params) {
			return executeAdviseWireInput(id, params, config, collector, onExecutionStart);
		},
	};
}

function isObjectRecord<T>(value: T): value is T & Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedOwnValue(
	input: Readonly<Record<string, unknown>>,
	key: string,
	fallback: unknown,
) {
	return Object.hasOwn(input, key) ? input[key] : fallback;
}

function isNullableEnum<T, const Values extends readonly string[]>(
	value: T,
	values: Values,
): value is T & (Values[number] | null) {
	return value === null || (typeof value === "string" && values.includes(value));
}

function isStrictSemanticArguments(input: Readonly<Record<string, unknown>>): boolean {
	const { note, intent, severity, findingKey, memory } = input;
	if (
		typeof note !== "string" ||
		!isNullableEnum(intent, ["review", "memory-suggestion"]) ||
		!isNullableEnum(severity, ["nit", "concern", "blocker"]) ||
		(findingKey !== null && typeof findingKey !== "string") ||
		(memory !== null && !isObjectRecord(memory)) ||
		!hasValidLocalStringBounds(input)
	) {
		return false;
	}
	if (memory === null) return true;
	return (
		(memory.text === null || typeof memory.text === "string") &&
		isNullableEnum(memory.category, MEMORY_SUGGESTION_CATEGORIES) &&
		isNullableEnum(memory.basis, MEMORY_SUGGESTION_BASES)
	);
}

function prepareStrictAdviseArguments(raw: unknown) {
	if (!isObjectRecord(raw)) {
		throw new Error("Advise arguments did not match the internal schema");
	}
	const rawMemory = selectedOwnValue(raw, "memory", null);
	const memory = isObjectRecord(rawMemory)
		? {
				text: selectedOwnValue(rawMemory, "text", null),
				category: selectedOwnValue(rawMemory, "category", null),
				basis: selectedOwnValue(rawMemory, "basis", null),
			}
		: rawMemory;
	const prepared = {
		note: selectedOwnValue(raw, "note", undefined),
		intent: selectedOwnValue(raw, "intent", null),
		severity: selectedOwnValue(raw, "severity", null),
		findingKey: selectedOwnValue(raw, "findingKey", null),
		memory,
	};
	if (!isStrictSemanticArguments(prepared)) {
		throw new Error("Advise arguments did not match the internal schema");
	}

	// TypeBox 1.1.38 compiles [object, null] property checks without a null guard, so a raw
	// null memory throws during compiled Pi validation. The local gate above is authoritative;
	// this equivalent encoding keeps Pi validation safe. Pinned by the TypeBox compile workaround
	// test in tests/unit/advise-strict.test.ts; when that test fails on an upgraded TypeBox,
	// this substitution and the pinned expectation can be removed together.
	return memory === null
		? { ...prepared, memory: { text: null, category: null, basis: null } }
		: prepared;
}

function normalizeStrictAdviseWireInput(input: unknown): AdviseWireInput {
	if (!isObjectRecord(input)) {
		throw new Error("Advise arguments did not match the internal schema");
	}
	const { note, intent, severity, findingKey, memory } = input;
	if (
		typeof note !== "string" ||
		!isNullableEnum(intent, ["review", "memory-suggestion"]) ||
		!isNullableEnum(severity, ["nit", "concern", "blocker"]) ||
		(findingKey !== null && typeof findingKey !== "string") ||
		(memory !== null && !isObjectRecord(memory)) ||
		!hasValidLocalStringBounds(input)
	) {
		throw new Error("Advise arguments did not match the internal schema");
	}

	let normalizedMemory: AdviseWireInput["memory"];
	if (memory !== null) {
		const { text, category, basis } = memory;
		if (
			(text !== null && typeof text !== "string") ||
			!isNullableEnum(category, MEMORY_SUGGESTION_CATEGORIES) ||
			!isNullableEnum(basis, MEMORY_SUGGESTION_BASES)
		) {
			throw new Error("Advise arguments did not match the internal schema");
		}
		if (text !== null || category !== null || basis !== null) {
			normalizedMemory = {
				...(text === null ? {} : { text }),
				...(category === null ? {} : { category }),
				...(basis === null ? {} : { basis }),
			};
		}
	}

	return {
		note,
		intent: intent ?? "review",
		...(severity === null ? {} : { severity }),
		...(findingKey === null ? {} : { findingKey }),
		...(normalizedMemory === undefined ? {} : { memory: normalizedMemory }),
	};
}

type StrictAdviseToolDefinition = ToolDefinition<typeof STRICT_ADVISE_WIRE_SCHEMA> & {
	constrainedSampling?: { type: "json_schema"; strict: "prefer" };
};

export function createStrictAdviseTool(
	config: AdvisorConfig,
	collector: AdviceCollector,
	onExecutionStart?: (toolCallId: string) => void | Promise<void>,
): StrictAdviseToolDefinition {
	return {
		name: "advise",
		label: "advise",
		description: `Record at most one concise material review note or eligible durable Memory suggestion. Do not call this tool when the Executor is on track. ${STRICT_MEMORY_ARGUMENT_GUIDANCE}`,
		parameters: STRICT_ADVISE_WIRE_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		prepareArguments(args) {
			return prepareStrictAdviseArguments(args);
		},
		execute(id, params) {
			return executeAdviseWireInput(
				id,
				normalizeStrictAdviseWireInput(params),
				config,
				collector,
				onExecutionStart,
			);
		},
	};
}
