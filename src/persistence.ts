import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

import {
	adviceDedupeKey,
	type AcceptedAdvice,
	type AdviceDedupeTag,
	type AdviceSeverity,
	type PersistedDedupeEntry,
} from "./advice.js";
import { HARD_LIMITS } from "./config.js";
import { MAX_PENDING_ADVICE_ITEMS } from "./delivery.js";
import { isMemorySuggestionBasis, isMemorySuggestionCategory } from "./memory-suggestions.js";
import { MAX_MUTE_ENTRIES } from "./mutes.js";
import { containsTerminalControlCharacters, redactSecrets } from "./redaction.js";
import { cursorMatches, type AdvisorCursor } from "./transcript.js";

export const ADVISOR_RUNTIME_STATE_ENTRY_TYPE = "pi-advisor-runtime-state";
export const ADVISOR_RUNTIME_STATE_VERSION = 5 as const;
export const ADVISOR_TRANSCRIPT_ENTRY_TYPE = "pi-advisor-transcript-record";
export const ADVISOR_TRANSCRIPT_LEGACY_RECORD_VERSION = 1 as const;
export const ADVISOR_TRANSCRIPT_RECORD_VERSION = 2 as const;
export const MAX_PERSISTED_DEDUPE_HASHES = 128;
export const MAX_PERSISTED_RUNTIME_STATE_BYTES = 4 * 1_024 * 1_024;
export const MAX_PERSISTED_REVIEW_SLOT_BYTES = 1_000_000;
export const MAX_PERSISTED_ACTIVE_DELIVERIES_BYTES = 1_000_000;
export const MAX_PERSISTED_TRANSCRIPT_RECORD_BYTES = 256 * 1_024;
export const MAX_INSPECTED_TRANSCRIPT_RECORDS = 256;
export const MAX_PERSISTED_ACTIVITY_TARGET_BYTES = 4 * 1_024;

interface PersistedAdvisorTranscriptRecordBase<Version extends 1 | 2> {
	version: Version;
	sessionId: string;
	savedAt: number;
}

export type PersistedAdvisorTranscriptRecordV1 = PersistedAdvisorTranscriptRecordBase<
	typeof ADVISOR_TRANSCRIPT_LEGACY_RECORD_VERSION
> &
	(
		| { kind: "update"; text: string; entryCount: number; truncated: boolean }
		| { kind: "advisor-tool-call"; toolName: string; arguments: string }
		| { kind: "advisor-tool-result"; toolName: string; isError: boolean; text: string }
		| {
				kind: "usage";
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				total: number;
				costUsd: number;
				stopReason: string;
		  }
		| {
				kind: "accepted-advice";
				advice: AcceptedAdvice;
				delivery: "active" | "deferred";
				stale: boolean;
		  }
		| { kind: "failure"; reason: string; stopReason: string }
		| {
				kind: "governor-exhaustion";
				outcome: "Advisor tool-call limit reached";
				stopReason: "tool-call-limit";
		  }
		| {
				kind: "governor-exhaustion";
				outcome: "Advisor turn limit reached";
				stopReason: "turn-limit";
		  }
	);

interface PersistedAdvisorActivityBase extends PersistedAdvisorTranscriptRecordBase<
	typeof ADVISOR_TRANSCRIPT_RECORD_VERSION
> {
	reviewId: string;
}

export interface PersistedAdvisorReviewStart extends PersistedAdvisorActivityBase {
	kind: "review-start";
	entryCount: number;
	truncated: boolean;
}

export interface PersistedAdvisorToolAttempt extends PersistedAdvisorActivityBase {
	kind: "tool-attempt";
	ordinal: number;
	toolName: string;
	internal: boolean;
	path?: string;
	pattern?: string;
	completed: boolean;
	isError: boolean;
	outputBytes: number;
	outputLines: number;
}

interface PersistedAdvisorReviewOutcomeBase extends PersistedAdvisorActivityBase {
	kind: "review-outcome";
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	costUsd: number;
	stopReason: string;
}

export type PersistedAdvisorReviewOutcome = PersistedAdvisorReviewOutcomeBase &
	(
		| { outcome: "silent" }
		| { outcome: "accepted"; delivery: "active" | "deferred"; stale: boolean }
		| { outcome: "governor-skipped"; reason: string }
		| { outcome: "failed"; reason: string }
		| { outcome: "superseded" }
	);

export type PersistedAdvisorTranscriptRecordV2 =
	| PersistedAdvisorReviewStart
	| PersistedAdvisorToolAttempt
	| PersistedAdvisorReviewOutcome;

export type PersistedAdvisorTranscriptRecord =
	| PersistedAdvisorTranscriptRecordV1
	| PersistedAdvisorTranscriptRecordV2;

export interface PersistedDeferredAdvice {
	advice: AcceptedAdvice;
	stale: boolean;
	branchWindow: AdvisorCursor;
	displayedInEntry: boolean;
	restoredAfterResume?: boolean;
	reviewId?: string;
	tag?: AdviceDedupeTag;
}

export interface PersistedAdvisorReviewUpdate {
	text: string;
	entryCount: number;
	truncated: boolean;
	window: AdvisorCursor;
	turnNumber: number;
	/** Newest first. */
	successfulMemoryTexts: string[];
}

export interface PersistedAdvisorActiveReview extends PersistedAdvisorReviewUpdate {
	reviewId: string;
	restoredReplayCount: number;
}

export interface PersistedAdvisorActiveDelivery extends PersistedDeferredAdvice {
	identity: string;
	deliveryId: string;
	reviewId: string;
	turnNumber: number;
}

export interface PersistedMemorySuggestionState {
	meaningfulTurnCount: number;
	admittedCount: number;
	deliveredCount: number;
	lastAdmittedTurn?: number;
	lastAdmittedAt?: number;
	sessionCapReached: boolean;
}

export interface PersistedRecentFinding {
	hash: string;
	label: string;
}

export interface PersistedAdvisorRuntimeState {
	version: typeof ADVISOR_RUNTIME_STATE_VERSION;
	sessionId: string;
	savedAt: number;
	cursor: AdvisorCursor;
	activeReview?: PersistedAdvisorActiveReview;
	queuedReview?: PersistedAdvisorReviewUpdate;
	lastReviewSubmittedTurn?: number;
	lastReviewSubmittedAt?: number;
	activeDeliveries: PersistedAdvisorActiveDelivery[];
	deferredAdvice: PersistedDeferredAdvice[];
	dedupeHashes: PersistedDedupeEntry[];
	/** Oldest first; at most 128 delivered findings that carried a findingKey (Q6-A1). */
	recentFindings: PersistedRecentFinding[];
	memorySuggestions: PersistedMemorySuggestionState;
	reviewFollowUpsTriggered?: number;
	notesDelivered: number;
}

interface UnvalidatedPersistedRecord {
	version?: number;
	sessionId?: string;
	savedAt?: number;
	kind?: string;
	reviewId?: string;
	expectedIndex?: number;
	lastEntryId?: string;
	intent?: string;
	note?: string;
	severity?: string;
	findingKeyHash?: string;
	findingKey?: string;
	truncated?: boolean;
	originalCharacters?: number;
	originalEstimatedTokens?: number;
	createdAt?: number;
	memory?: unknown;
	text?: string;
	category?: string;
	basis?: string;
	hash?: string;
	metadata?: unknown;
	signature?: string;
	lastDeliveryTurn?: number;
	label?: string;
	advice?: UnvalidatedPersistedRecord;
	stale?: boolean;
	branchWindow?: UnvalidatedPersistedRecord;
	displayedInEntry?: boolean;
	restoredAfterResume?: unknown;
	tag?: string;
	entryCount?: number;
	window?: UnvalidatedPersistedRecord;
	turnNumber?: number;
	successfulMemoryTexts?: string[];
	restoredReplayCount?: number;
	identity?: string;
	deliveryId?: string;
	meaningfulTurnCount?: number;
	admittedCount?: number;
	deliveredCount?: number;
	lastAdmittedTurn?: number;
	lastAdmittedAt?: number;
	sessionCapReached?: boolean;
	cursor?: UnvalidatedPersistedRecord;
	activeReview?: UnvalidatedPersistedRecord;
	queuedReview?: UnvalidatedPersistedRecord;
	lastReviewSubmittedTurn?: number;
	lastReviewSubmittedAt?: number;
	activeDeliveries?: UnvalidatedPersistedRecord[];
	deferredAdvice?: UnvalidatedPersistedRecord[];
	dedupeHashes?: (string | UnvalidatedPersistedRecord)[];
	recentFindings?: UnvalidatedPersistedRecord[];
	memorySuggestions?: UnvalidatedPersistedRecord;
	reviewFollowUpsTriggered?: number;
	notesDelivered?: number;
	toolName?: string;
	arguments?: string;
	isError?: boolean;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
	costUsd?: number;
	stopReason?: string;
	delivery?: string;
	reason?: string;
	outcome?: string;
	ordinal?: number;
	internal?: boolean;
	path?: string;
	pattern?: string;
	completed?: boolean;
	outputBytes?: number;
	outputLines?: number;
}

const PersistedRecordSchema = Type.Object({}, { additionalProperties: true });
const PersistedStringSchema = Type.String();
const PersistedBooleanSchema = Type.Boolean();
const PersistedNumberSchema = Type.Number();

function isPersistedRecord<T>(value: T): value is T & UnvalidatedPersistedRecord {
	return Check(PersistedRecordSchema, value);
}

function isPersistedString<T>(value: T): value is T & string {
	return Check(PersistedStringSchema, value);
}

function isPersistedBoolean<T>(value: T): value is T & boolean {
	return Check(PersistedBooleanSchema, value);
}

function isPersistedNumber<T>(value: T): value is T & number {
	return Check(PersistedNumberSchema, value);
}

function hasOnlyKeys(value: UnvalidatedPersistedRecord, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteInteger<T>(value: T, minimum = 0): value is T & number {
	return isPersistedNumber(value) && Number.isSafeInteger(value) && value >= minimum;
}

function isTimestamp<T>(value: T): value is T & number {
	return isFiniteInteger(value) && value <= 8_640_000_000_000_000;
}

function isFiniteNonNegative<T>(value: T): value is T & number {
	return isPersistedNumber(value) && Number.isFinite(value) && value >= 0;
}

function isSafePersistedText<T>(value: T): value is T & string {
	return (
		isPersistedString(value) &&
		value.length <= MAX_PERSISTED_TRANSCRIPT_RECORD_BYTES * 2 &&
		redactSecrets(value).text === value
	);
}

function isBoundedName<T>(value: T): value is T & string {
	return isPersistedString(value) && value.length > 0 && value.length <= 256;
}

function isCursor<T>(value: T): value is T & AdvisorCursor {
	if (!isPersistedRecord(value)) return false;
	const cursor = value;
	return (
		hasOnlyKeys(cursor, ["expectedIndex", "lastEntryId"]) &&
		isFiniteInteger(cursor.expectedIndex) &&
		(cursor.lastEntryId === undefined ||
			(isPersistedString(cursor.lastEntryId) &&
				cursor.lastEntryId.length > 0 &&
				cursor.lastEntryId.length <= 128)) &&
		(cursor.expectedIndex === 0) === (cursor.lastEntryId === undefined)
	);
}

function isBoundedSafeText<T>(value: T, maximumCharacters: number): value is T & string {
	if (!isPersistedString(value) || value.length > maximumCharacters * 2) return false;
	if (Array.from(value).length > maximumCharacters) return false;
	return redactSecrets(value).text === value;
}

function isAdviceSeverity<T>(value: T): value is T & AdviceSeverity {
	return value === "nit" || value === "concern" || value === "blocker";
}

type FindingKeyMetadataMode = "none" | "hash" | "hash-label";

function isAcceptedAdvice<T>(
	value: T,
	findingKeyMetadata: FindingKeyMetadataMode,
): value is T & AcceptedAdvice {
	if (!isPersistedRecord(value)) return false;
	const advice = value;
	if (
		!isBoundedSafeText(advice.note, HARD_LIMITS.maxAdviceCharacters) ||
		!isPersistedBoolean(advice.truncated) ||
		!isFiniteInteger(advice.originalCharacters) ||
		!isFiniteInteger(advice.originalEstimatedTokens) ||
		!isTimestamp(advice.createdAt)
	) {
		return false;
	}
	if (advice.intent === "review") {
		return (
			hasOnlyKeys(advice, [
				"intent",
				"note",
				"severity",
				...(findingKeyMetadata !== "none" ? ["findingKeyHash"] : []),
				...(findingKeyMetadata === "hash-label" ? ["findingKey"] : []),
				"truncated",
				"originalCharacters",
				"originalEstimatedTokens",
				"createdAt",
			]) &&
			isAdviceSeverity(advice.severity) &&
			(findingKeyMetadata === "none" ||
				advice.findingKeyHash === undefined ||
				(isPersistedString(advice.findingKeyHash) &&
					/^[a-f0-9]{64}$/u.test(advice.findingKeyHash))) &&
			(findingKeyMetadata !== "hash-label" ||
				advice.findingKey === undefined ||
				(isPersistedString(advice.findingKey) &&
					Array.from(advice.findingKey).length > 0 &&
					Array.from(advice.findingKey).length <= 128 &&
					redactSecrets(advice.findingKey).text === advice.findingKey))
		);
	}
	if (advice.intent !== "memory-suggestion" || !isPersistedRecord(advice.memory)) {
		return false;
	}
	const memory = advice.memory;
	return (
		hasOnlyKeys(advice, [
			"intent",
			"note",
			"memory",
			"truncated",
			"originalCharacters",
			"originalEstimatedTokens",
			"createdAt",
		]) &&
		hasOnlyKeys(memory, ["text", "category", "basis"]) &&
		isBoundedSafeText(memory.text, HARD_LIMITS.maxProposedMemoryCharacters) &&
		isMemorySuggestionCategory(memory.category) &&
		isMemorySuggestionBasis(memory.basis)
	);
}

function isBoundedId<T>(value: T): value is T & string {
	return isPersistedString(value) && value.length > 0 && value.length <= 128;
}

function serializedBytes(value: unknown): number | undefined {
	try {
		const serialized = JSON.stringify(value);
		return isPersistedString(serialized) ? Buffer.byteLength(serialized, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

function isPersistedDedupeEntry<T>(value: T): value is T & PersistedDedupeEntry {
	if (!isPersistedRecord(value)) return false;
	const entry = value;
	if (!hasOnlyKeys(entry, ["hash", "metadata"])) return false;
	if (!isPersistedString(entry.hash) || !/^[a-f0-9]{64}$/u.test(entry.hash)) return false;
	if (entry.metadata === undefined) return true;
	if (!isPersistedRecord(entry.metadata)) return false;
	const metadata = entry.metadata;
	return (
		hasOnlyKeys(metadata, ["severity", "signature", "lastDeliveryTurn"]) &&
		isAdviceSeverity(metadata.severity) &&
		isPersistedString(metadata.signature) &&
		/^[a-f0-9]{16}$/u.test(metadata.signature) &&
		isFiniteInteger(metadata.lastDeliveryTurn, 1)
	);
}

function isLegacyDedupeHashes<T>(value: T): value is T & string[] {
	if (!Array.isArray(value) || value.length > MAX_PERSISTED_DEDUPE_HASHES) return false;
	const hashes: unknown[] = value;
	return (
		hashes.every((hash) => isPersistedString(hash) && /^[a-f0-9]{64}$/u.test(hash)) &&
		new Set(hashes).size === hashes.length
	);
}

function isPersistedRecentFinding<T>(value: T): value is T & PersistedRecentFinding {
	if (!isPersistedRecord(value)) return false;
	const entry = value;
	return (
		hasOnlyKeys(entry, ["hash", "label"]) &&
		isPersistedString(entry.hash) &&
		/^[a-f0-9]{64}$/u.test(entry.hash) &&
		isPersistedString(entry.label) &&
		Array.from(entry.label).length > 0 &&
		isBoundedSafeText(entry.label, MAX_PERSISTED_RECENT_FINDING_LABEL_CHARACTERS) &&
		!containsTerminalControlCharacters(entry.label)
	);
}

export const MAX_PERSISTED_RECENT_FINDINGS = MAX_MUTE_ENTRIES;
export const MAX_PERSISTED_RECENT_FINDING_LABEL_CHARACTERS = 128;

function isPersistedDeferredAdvice<T>(
	value: T,
	findingKeyMetadata: FindingKeyMetadataMode,
	allowReviewId = false,
): value is T & PersistedDeferredAdvice {
	if (!isPersistedRecord(value)) return false;
	const pending = value;
	return (
		hasOnlyKeys(pending, [
			"advice",
			"stale",
			"branchWindow",
			"displayedInEntry",
			"restoredAfterResume",
			"tag",
			...(allowReviewId ? ["reviewId"] : []),
		]) &&
		isAcceptedAdvice(pending.advice, findingKeyMetadata) &&
		isPersistedBoolean(pending.stale) &&
		isCursor(pending.branchWindow) &&
		isPersistedBoolean(pending.displayedInEntry) &&
		(pending.restoredAfterResume === undefined || pending.restoredAfterResume === true) &&
		(!allowReviewId || pending.reviewId === undefined || isBoundedId(pending.reviewId)) &&
		(pending.tag === undefined ||
			pending.tag === "possible-duplicate" ||
			pending.tag === "re-raised")
	);
}

function isPersistedReviewUpdate<T>(
	value: T,
	branch: SessionEntry[],
	active: boolean,
): value is T & PersistedAdvisorReviewUpdate {
	if (!isPersistedRecord(value)) return false;
	const update = value;
	const allowed = [
		"text",
		"entryCount",
		"truncated",
		"window",
		"turnNumber",
		"successfulMemoryTexts",
		...(active ? ["reviewId", "restoredReplayCount"] : []),
	];
	const bytes = serializedBytes(value);
	return (
		hasOnlyKeys(update, allowed) &&
		bytes !== undefined &&
		bytes <= MAX_PERSISTED_REVIEW_SLOT_BYTES &&
		isPersistedString(update.text) &&
		redactSecrets(update.text).text === update.text &&
		isFiniteInteger(update.entryCount) &&
		isPersistedBoolean(update.truncated) &&
		isCursor(update.window) &&
		cursorMatches(branch, update.window) &&
		isFiniteInteger(update.turnNumber, 1) &&
		Array.isArray(update.successfulMemoryTexts) &&
		update.successfulMemoryTexts.length <= MAX_PENDING_ADVICE_ITEMS &&
		update.successfulMemoryTexts.every(
			(text) =>
				isPersistedString(text) &&
				redactSecrets(text).text === text &&
				Buffer.byteLength(text, "utf8") <= HARD_LIMITS.maxPendingTranscriptBytes,
		) &&
		new Set(update.successfulMemoryTexts).size === update.successfulMemoryTexts.length &&
		(!active ||
			(isBoundedId(update.reviewId) &&
				isFiniteInteger(update.restoredReplayCount, 0) &&
				update.restoredReplayCount <= 2))
	);
}

function persistedReviewTurn(value: unknown): number | undefined {
	if (!isPersistedRecord(value)) return undefined;
	const turnNumber = value.turnNumber;
	return isPersistedNumber(turnNumber) ? turnNumber : undefined;
}

function isPersistedActiveDelivery<T>(
	value: T,
	branch: SessionEntry[],
	findingKeyMetadata: FindingKeyMetadataMode,
): value is T & PersistedAdvisorActiveDelivery {
	if (!isPersistedRecord(value)) return false;
	const delivery = value;
	return (
		hasOnlyKeys(delivery, [
			"advice",
			"stale",
			"branchWindow",
			"displayedInEntry",
			"restoredAfterResume",
			"reviewId",
			"identity",
			"deliveryId",
			"turnNumber",
			"tag",
		]) &&
		isAcceptedAdvice(delivery.advice, findingKeyMetadata) &&
		isPersistedBoolean(delivery.stale) &&
		isCursor(delivery.branchWindow) &&
		cursorMatches(branch, delivery.branchWindow) &&
		isPersistedBoolean(delivery.displayedInEntry) &&
		(delivery.restoredAfterResume === undefined || delivery.restoredAfterResume === true) &&
		isBoundedId(delivery.reviewId) &&
		isPersistedString(delivery.identity) &&
		/^[a-f0-9]{64}$/u.test(delivery.identity) &&
		delivery.identity === adviceDedupeKey(delivery.advice) &&
		isBoundedId(delivery.deliveryId) &&
		isFiniteInteger(delivery.turnNumber, 1) &&
		(delivery.tag === undefined ||
			delivery.tag === "possible-duplicate" ||
			delivery.tag === "re-raised")
	);
}

function isMemoryState<T>(value: T): value is T & PersistedMemorySuggestionState {
	if (!isPersistedRecord(value)) return false;
	const state = value;
	if (
		!hasOnlyKeys(state, [
			"meaningfulTurnCount",
			"admittedCount",
			"deliveredCount",
			"lastAdmittedTurn",
			"lastAdmittedAt",
			"sessionCapReached",
		]) ||
		!isFiniteInteger(state.meaningfulTurnCount) ||
		!isFiniteInteger(state.admittedCount) ||
		!isFiniteInteger(state.deliveredCount) ||
		(state.lastAdmittedTurn !== undefined && !isFiniteInteger(state.lastAdmittedTurn)) ||
		(state.lastAdmittedAt !== undefined && !isTimestamp(state.lastAdmittedAt)) ||
		!isPersistedBoolean(state.sessionCapReached)
	) {
		return false;
	}
	return (
		state.deliveredCount <= state.admittedCount &&
		state.admittedCount <= state.meaningfulTurnCount &&
		(state.lastAdmittedTurn === undefined) === (state.admittedCount === 0) &&
		(state.lastAdmittedAt === undefined) === (state.admittedCount === 0) &&
		(state.lastAdmittedTurn === undefined || state.lastAdmittedTurn <= state.meaningfulTurnCount)
	);
}

export function parsePersistedAdvisorRuntimeState(
	value: unknown,
	expectedSessionId: string,
	branch: SessionEntry[],
): PersistedAdvisorRuntimeState | undefined {
	let serialized: unknown;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return undefined;
	}
	if (
		!isPersistedString(serialized) ||
		Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_RUNTIME_STATE_BYTES ||
		!isPersistedRecord(value)
	) {
		return undefined;
	}
	const state = value;
	const version = state.version;
	if (
		version !== 1 &&
		version !== 2 &&
		version !== 3 &&
		version !== 4 &&
		version !== ADVISOR_RUNTIME_STATE_VERSION
	) {
		return undefined;
	}
	const legacy = version === 1 || version === 2;
	const allowReviewId = version === 3 || version === 4 || version === ADVISOR_RUNTIME_STATE_VERSION;
	const findingKeyMetadata: FindingKeyMetadataMode =
		version === 1 ? "none" : version === ADVISOR_RUNTIME_STATE_VERSION ? "hash-label" : "hash";
	const allowedKeys = legacy
		? [
				"version",
				"sessionId",
				"savedAt",
				"cursor",
				"deferredAdvice",
				"dedupeHashes",
				"memorySuggestions",
				"notesDelivered",
			]
		: [
				"version",
				"sessionId",
				"savedAt",
				"cursor",
				"activeReview",
				"queuedReview",
				"lastReviewSubmittedTurn",
				"lastReviewSubmittedAt",
				"activeDeliveries",
				"deferredAdvice",
				"dedupeHashes",
				...(version === ADVISOR_RUNTIME_STATE_VERSION ? ["recentFindings"] : []),
				"memorySuggestions",
				"reviewFollowUpsTriggered",
				"notesDelivered",
			];
	if (
		!hasOnlyKeys(state, allowedKeys) ||
		state.sessionId !== expectedSessionId ||
		!isPersistedString(state.sessionId) ||
		state.sessionId.length === 0 ||
		state.sessionId.length > 128 ||
		!isTimestamp(state.savedAt) ||
		!isCursor(state.cursor) ||
		!cursorMatches(branch, state.cursor) ||
		!Array.isArray(state.deferredAdvice) ||
		state.deferredAdvice.length > MAX_PENDING_ADVICE_ITEMS ||
		!state.deferredAdvice.every((pending) =>
			isPersistedDeferredAdvice(pending, findingKeyMetadata, allowReviewId),
		) ||
		!Array.isArray(state.dedupeHashes) ||
		state.dedupeHashes.length > MAX_PERSISTED_DEDUPE_HASHES ||
		(version === 4 || version === ADVISOR_RUNTIME_STATE_VERSION
			? !state.dedupeHashes.every(isPersistedDedupeEntry) ||
				new Set(state.dedupeHashes.map((entry) => entry.hash)).size !== state.dedupeHashes.length
			: !isLegacyDedupeHashes(state.dedupeHashes)) ||
		(version === ADVISOR_RUNTIME_STATE_VERSION &&
			(!Array.isArray(state.recentFindings) ||
				state.recentFindings.length > MAX_MUTE_ENTRIES ||
				!state.recentFindings.every(isPersistedRecentFinding) ||
				new Set(state.recentFindings.map((entry) => entry.hash)).size !==
					state.recentFindings.length)) ||
		!isMemoryState(state.memorySuggestions) ||
		(state.reviewFollowUpsTriggered !== undefined &&
			!isFiniteInteger(state.reviewFollowUpsTriggered)) ||
		!isFiniteInteger(state.notesDelivered)
	) {
		return undefined;
	}
	if (!legacy) {
		const activeReviewValid =
			state.activeReview === undefined || isPersistedReviewUpdate(state.activeReview, branch, true);
		const queuedReviewValid =
			state.queuedReview === undefined ||
			isPersistedReviewUpdate(state.queuedReview, branch, false);
		const deliveriesBytes = serializedBytes(state.activeDeliveries);
		if (
			!activeReviewValid ||
			!queuedReviewValid ||
			(state.lastReviewSubmittedTurn !== undefined &&
				!isFiniteInteger(state.lastReviewSubmittedTurn, 1)) ||
			(state.lastReviewSubmittedAt !== undefined && !isTimestamp(state.lastReviewSubmittedAt)) ||
			!Array.isArray(state.activeDeliveries) ||
			state.activeDeliveries.length > MAX_PENDING_ADVICE_ITEMS ||
			deliveriesBytes === undefined ||
			deliveriesBytes > MAX_PERSISTED_ACTIVE_DELIVERIES_BYTES ||
			!state.activeDeliveries.every((delivery) =>
				isPersistedActiveDelivery(delivery, branch, findingKeyMetadata),
			)
		) {
			return undefined;
		}
		// SAFETY: every() above accepted only PersistedAdvisorActiveDelivery values.
		const deliveries = state.activeDeliveries as PersistedAdvisorActiveDelivery[];
		const activeReviewTurn = persistedReviewTurn(state.activeReview);
		const queuedReviewTurn = persistedReviewTurn(state.queuedReview);
		const meaningfulTurnCount = state.memorySuggestions.meaningfulTurnCount;
		// SAFETY: versions 4 and 5 validate every dedupe entry above before metadata access.
		if (
			new Set(deliveries.map((delivery) => delivery.identity)).size !== deliveries.length ||
			new Set(deliveries.map((delivery) => delivery.deliveryId)).size !== deliveries.length ||
			(state.lastReviewSubmittedTurn === undefined) !==
				(state.lastReviewSubmittedAt === undefined) ||
			(state.lastReviewSubmittedTurn !== undefined &&
				state.lastReviewSubmittedTurn > meaningfulTurnCount) ||
			(activeReviewTurn !== undefined && activeReviewTurn > meaningfulTurnCount) ||
			(queuedReviewTurn !== undefined && queuedReviewTurn > meaningfulTurnCount) ||
			(activeReviewTurn !== undefined &&
				queuedReviewTurn !== undefined &&
				queuedReviewTurn < activeReviewTurn) ||
			deliveries.some((delivery) => delivery.turnNumber > meaningfulTurnCount) ||
			((version === 4 || version === ADVISOR_RUNTIME_STATE_VERSION) &&
				(state.dedupeHashes as PersistedDedupeEntry[]).some(
					(entry) =>
						entry.metadata !== undefined && entry.metadata.lastDeliveryTurn > meaningfulTurnCount,
				))
		) {
			return undefined;
		}
		const current = structuredClone(value);
		// SAFETY: the complete version-specific runtime state was validated above; cloning preserves it.
		return {
			...(current as Omit<
				PersistedAdvisorRuntimeState,
				"version" | "dedupeHashes" | "recentFindings"
			>),
			version: ADVISOR_RUNTIME_STATE_VERSION,
			dedupeHashes:
				version === 3
					? (state.dedupeHashes as string[]).map((hash) => ({ hash }))
					: (structuredClone(state.dedupeHashes) as PersistedDedupeEntry[]),
			recentFindings:
				version === ADVISOR_RUNTIME_STATE_VERSION
					? (structuredClone(state.recentFindings) as PersistedRecentFinding[])
					: [],
		};
	}
	const migrated = structuredClone(value);
	// SAFETY: legacy versions 1 and 2 were fully validated above before migration to version 5.
	return {
		...(migrated as Omit<
			PersistedAdvisorRuntimeState,
			"version" | "activeDeliveries" | "dedupeHashes" | "recentFindings"
		>),
		version: ADVISOR_RUNTIME_STATE_VERSION,
		activeDeliveries: [],
		dedupeHashes:
			version === 1 ? [] : (migrated.dedupeHashes as string[]).map((hash) => ({ hash })),
		recentFindings: [],
	};
}

function hasValidTranscriptBase(
	record: UnvalidatedPersistedRecord,
	expectedSessionId: string,
): boolean {
	return (
		record.sessionId === expectedSessionId &&
		isPersistedString(record.sessionId) &&
		record.sessionId.length > 0 &&
		record.sessionId.length <= 128 &&
		isTimestamp(record.savedAt)
	);
}

function isActivityTarget<T>(value: T): value is T & string {
	return (
		isPersistedString(value) &&
		Buffer.byteLength(value, "utf8") <= MAX_PERSISTED_ACTIVITY_TARGET_BYTES &&
		redactSecrets(value).text === value
	);
}

function hasValidToolTargets(record: UnvalidatedPersistedRecord): boolean {
	const path = record.path;
	const pattern = record.pattern;
	if (record.internal === true) {
		return record.toolName === "advise" && path === undefined && pattern === undefined;
	}
	if (record.toolName === "advise") return false;
	switch (record.toolName) {
		case "read":
		case "ls":
			return isActivityTarget(path) && pattern === undefined;
		case "find":
		case "grep":
			return isActivityTarget(path) && isActivityTarget(pattern);
		default:
			return path === undefined && pattern === undefined;
	}
}

function parseLegacyTranscriptRecord(
	value: unknown,
	record: UnvalidatedPersistedRecord,
): PersistedAdvisorTranscriptRecordV1 | undefined {
	let valid = false;
	switch (record.kind) {
		case "update":
			valid =
				hasOnlyKeys(record, [
					"version",
					"sessionId",
					"savedAt",
					"kind",
					"text",
					"entryCount",
					"truncated",
				]) &&
				isSafePersistedText(record.text) &&
				isFiniteInteger(record.entryCount) &&
				isPersistedBoolean(record.truncated);
			break;
		case "advisor-tool-call":
			valid =
				hasOnlyKeys(record, ["version", "sessionId", "savedAt", "kind", "toolName", "arguments"]) &&
				isBoundedName(record.toolName) &&
				isSafePersistedText(record.arguments);
			break;
		case "advisor-tool-result":
			valid =
				hasOnlyKeys(record, [
					"version",
					"sessionId",
					"savedAt",
					"kind",
					"toolName",
					"isError",
					"text",
				]) &&
				isBoundedName(record.toolName) &&
				isPersistedBoolean(record.isError) &&
				isSafePersistedText(record.text);
			break;
		case "usage":
			valid =
				hasOnlyKeys(record, [
					"version",
					"sessionId",
					"savedAt",
					"kind",
					"input",
					"output",
					"cacheRead",
					"cacheWrite",
					"total",
					"costUsd",
					"stopReason",
				]) &&
				isFiniteNonNegative(record.input) &&
				isFiniteNonNegative(record.output) &&
				isFiniteNonNegative(record.cacheRead) &&
				isFiniteNonNegative(record.cacheWrite) &&
				isFiniteNonNegative(record.total) &&
				isFiniteNonNegative(record.costUsd) &&
				isSafePersistedText(record.stopReason);
			break;
		case "accepted-advice":
			valid =
				hasOnlyKeys(record, [
					"version",
					"sessionId",
					"savedAt",
					"kind",
					"advice",
					"delivery",
					"stale",
				]) &&
				isAcceptedAdvice(record.advice, "none") &&
				(record.delivery === "active" || record.delivery === "deferred") &&
				isPersistedBoolean(record.stale);
			break;
		case "failure":
			valid =
				hasOnlyKeys(record, ["version", "sessionId", "savedAt", "kind", "reason", "stopReason"]) &&
				isSafePersistedText(record.reason) &&
				isSafePersistedText(record.stopReason);
			break;
		case "governor-exhaustion":
			valid =
				hasOnlyKeys(record, ["version", "sessionId", "savedAt", "kind", "outcome", "stopReason"]) &&
				((record.outcome === "Advisor tool-call limit reached" &&
					record.stopReason === "tool-call-limit") ||
					(record.outcome === "Advisor turn limit reached" && record.stopReason === "turn-limit"));
			break;
	}
	// SAFETY: each accepted legacy kind passed its complete key and value validation above.
	return valid ? (structuredClone(value) as PersistedAdvisorTranscriptRecordV1) : undefined;
}

function parseActivityTranscriptRecord(
	value: unknown,
	record: UnvalidatedPersistedRecord,
): PersistedAdvisorTranscriptRecordV2 | undefined {
	if (!isBoundedName(record.reviewId) || record.reviewId.length > 128) return undefined;
	let valid = false;
	switch (record.kind) {
		case "review-start":
			valid =
				hasOnlyKeys(record, [
					"version",
					"sessionId",
					"savedAt",
					"reviewId",
					"kind",
					"entryCount",
					"truncated",
				]) &&
				isFiniteInteger(record.entryCount) &&
				isPersistedBoolean(record.truncated);
			break;
		case "tool-attempt": {
			valid =
				hasOnlyKeys(record, [
					"version",
					"sessionId",
					"savedAt",
					"reviewId",
					"kind",
					"ordinal",
					"toolName",
					"internal",
					"path",
					"pattern",
					"completed",
					"isError",
					"outputBytes",
					"outputLines",
				]) &&
				isFiniteInteger(record.ordinal, 1) &&
				isBoundedName(record.toolName) &&
				isPersistedBoolean(record.internal) &&
				isPersistedBoolean(record.completed) &&
				isPersistedBoolean(record.isError) &&
				isFiniteInteger(record.outputBytes) &&
				isFiniteInteger(record.outputLines) &&
				hasValidToolTargets(record);
			if (
				valid &&
				record.completed === false &&
				(record.isError !== false || record.outputBytes !== 0 || record.outputLines !== 0)
			) {
				valid = false;
			}
			break;
		}
		case "review-outcome": {
			const commonKeys = [
				"version",
				"sessionId",
				"savedAt",
				"reviewId",
				"kind",
				"outcome",
				"input",
				"output",
				"cacheRead",
				"cacheWrite",
				"total",
				"costUsd",
				"stopReason",
			] as const;
			const validUsage =
				isFiniteNonNegative(record.input) &&
				isFiniteNonNegative(record.output) &&
				isFiniteNonNegative(record.cacheRead) &&
				isFiniteNonNegative(record.cacheWrite) &&
				isFiniteNonNegative(record.total) &&
				isFiniteNonNegative(record.costUsd) &&
				isSafePersistedText(record.stopReason);
			if (record.outcome === "silent" || record.outcome === "superseded") {
				valid = hasOnlyKeys(record, commonKeys) && validUsage;
			} else if (record.outcome === "accepted") {
				valid =
					hasOnlyKeys(record, [...commonKeys, "delivery", "stale"]) &&
					validUsage &&
					(record.delivery === "active" || record.delivery === "deferred") &&
					isPersistedBoolean(record.stale);
			} else if (record.outcome === "governor-skipped" || record.outcome === "failed") {
				valid =
					hasOnlyKeys(record, [...commonKeys, "reason"]) &&
					validUsage &&
					isSafePersistedText(record.reason);
			}
			break;
		}
	}
	// SAFETY: each accepted activity kind passed its complete key and value validation above.
	return valid ? (structuredClone(value) as PersistedAdvisorTranscriptRecordV2) : undefined;
}

export function parsePersistedAdvisorTranscriptRecord(
	value: unknown,
	expectedSessionId: string,
): PersistedAdvisorTranscriptRecord | undefined {
	let serialized: unknown;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return undefined;
	}
	if (
		!isPersistedString(serialized) ||
		Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_TRANSCRIPT_RECORD_BYTES ||
		!isPersistedRecord(value)
	) {
		return undefined;
	}
	const record = value;
	if (!hasValidTranscriptBase(record, expectedSessionId)) return undefined;
	if (record.version === ADVISOR_TRANSCRIPT_LEGACY_RECORD_VERSION) {
		return parseLegacyTranscriptRecord(value, record);
	}
	if (record.version === ADVISOR_TRANSCRIPT_RECORD_VERSION) {
		return parseActivityTranscriptRecord(value, record);
	}
	return undefined;
}

export function deferredAdviceIdentity(pending: PersistedDeferredAdvice): string {
	return adviceDedupeKey(pending.advice);
}
