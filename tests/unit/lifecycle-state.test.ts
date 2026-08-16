import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	ADVISOR_RUNTIME_STATE_VERSION,
	adviceDedupeKey,
	BoundedAdviceDedupe,
	cursorAtTail,
	MAX_PERSISTED_DEDUPE_HASHES,
	parsePersistedAdvisorRuntimeState,
	validateCursor,
	type AcceptedAdvice,
	type PersistedAdvisorRuntimeState,
} from "../../src/index.js";

function advice(note: string): AcceptedAdvice {
	return {
		intent: "review",
		note,
		severity: "concern",
		truncated: false,
		originalCharacters: note.length,
		originalEstimatedTokens: Math.ceil(note.length / 4),
		createdAt: Date.now(),
	};
}

function stateFor(
	manager: SessionManager,
	version: typeof ADVISOR_RUNTIME_STATE_VERSION | 1 | 2 | 3 | 4 = ADVISOR_RUNTIME_STATE_VERSION,
): PersistedAdvisorRuntimeState {
	const state: Partial<PersistedAdvisorRuntimeState> = {
		version: ADVISOR_RUNTIME_STATE_VERSION,
		sessionId: manager.getSessionId(),
		savedAt: Date.now(),
		cursor: cursorAtTail(manager.getBranch()),
		activeDeliveries: [],
		deferredAdvice: [],
		dedupeHashes: [],
		memorySuggestions: {
			meaningfulTurnCount: 0,
			admittedCount: 0,
			deliveredCount: 0,
			sessionCapReached: false,
		},
		recentFindings: [],
		notesDelivered: 0,
	};
	if (version === 1 || version === 2) delete state.activeDeliveries;
	if (version !== ADVISOR_RUNTIME_STATE_VERSION) delete state.recentFindings;
	return state as PersistedAdvisorRuntimeState;
}

describe("Slice 3A lifecycle state primitives", () => {
	it("round-trips the optional review follow-up counter and defaults older states to zero", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const branch = manager.getBranch();
		const withCounter = { ...stateFor(manager), reviewFollowUpsTriggered: 5 };
		expect(parsePersistedAdvisorRuntimeState(withCounter, manager.getSessionId(), branch)).toEqual(
			withCounter,
		);
		const withoutCounter = parsePersistedAdvisorRuntimeState(
			stateFor(manager),
			manager.getSessionId(),
			branch,
		);
		expect(withoutCounter?.reviewFollowUpsTriggered).toBeUndefined();
		expect(
			parsePersistedAdvisorRuntimeState(
				{ ...stateFor(manager), reviewFollowUpsTriggered: -1 },
				manager.getSessionId(),
				branch,
			),
		).toBeUndefined();
		expect(
			parsePersistedAdvisorRuntimeState(
				{ ...stateFor(manager), reviewFollowUpsTriggered: 1.5 },
				manager.getSessionId(),
				branch,
			),
		).toBeUndefined();
	});

	it("distinguishes transcript shrink from same-length ancestry mismatch", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "original", timestamp: 2 });
		const original = cursorAtTail(manager.getBranch());

		manager.branch(root);
		expect(validateCursor(manager.getBranch(), original)).toBe("transcript-shrunk");
		manager.appendMessage({ role: "user", content: "alternate", timestamp: 3 });
		expect(manager.getBranch()).toHaveLength(original.expectedIndex);
		expect(validateCursor(manager.getBranch(), original)).toBe("ancestry-mismatch");
	});

	it("rejects wrong versions, wrong sessions, invalid cursors, and unbounded hashes", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const branch = manager.getBranch();
		const valid = stateFor(manager);
		expect(parsePersistedAdvisorRuntimeState(valid, manager.getSessionId(), branch)).toEqual(valid);
		expect(
			parsePersistedAdvisorRuntimeState({ ...valid, version: 6 }, manager.getSessionId(), branch),
		).toBeUndefined();
		expect(parsePersistedAdvisorRuntimeState(valid, "another-session", branch)).toBeUndefined();
		expect(
			parsePersistedAdvisorRuntimeState(undefined, manager.getSessionId(), branch),
		).toBeUndefined();
		expect(
			parsePersistedAdvisorRuntimeState(
				{ ...valid, unexpected: "field" },
				manager.getSessionId(),
				branch,
			),
		).toBeUndefined();
		expect(
			parsePersistedAdvisorRuntimeState(
				{
					...valid,
					memorySuggestions: {
						...valid.memorySuggestions,
						admittedCount: 1,
					},
				},
				manager.getSessionId(),
				branch,
			),
		).toBeUndefined();
		expect(
			parsePersistedAdvisorRuntimeState(
				{
					...valid,
					memorySuggestions: {
						...valid.memorySuggestions,
						deliveredCount: 1,
					},
				},
				manager.getSessionId(),
				branch,
			),
		).toBeUndefined();
		expect(
			parsePersistedAdvisorRuntimeState(
				{ ...valid, cursor: { lastEntryId: "missing", expectedIndex: 1 } },
				manager.getSessionId(),
				branch,
			),
		).toBeUndefined();
		expect(
			parsePersistedAdvisorRuntimeState(
				{
					...valid,
					dedupeHashes: Array.from({ length: MAX_PERSISTED_DEDUPE_HASHES + 1 }, (_, index) =>
						index.toString(16).padStart(64, "0"),
					),
				},
				manager.getSessionId(),
				branch,
			),
		).toBeUndefined();
	});

	it("versions semantic finding hashes and migrates strict version 1 state", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const branch = manager.getBranch();
		const legacyAdvice = advice("Verify the legacy cancellation defect.");
		const legacyBase = structuredClone(stateFor(manager, 1));
		const legacy = {
			...legacyBase,
			version: 1,
			deferredAdvice: [
				{
					advice: legacyAdvice,
					stale: true,
					branchWindow: cursorAtTail(branch),
					displayedInEntry: false,
				},
			],
			dedupeHashes: [adviceDedupeKey(legacyAdvice)],
			memorySuggestions: {
				meaningfulTurnCount: 2,
				admittedCount: 1,
				deliveredCount: 1,
				lastAdmittedTurn: 2,
				lastAdmittedAt: Date.now(),
				sessionCapReached: false,
			},
			notesDelivered: 3,
		};
		expect(parsePersistedAdvisorRuntimeState(legacy, manager.getSessionId(), branch)).toEqual({
			...legacy,
			version: ADVISOR_RUNTIME_STATE_VERSION,
			activeDeliveries: [],
			dedupeHashes: [],
			recentFindings: [],
		});

		const semanticAdvice = advice("Verify the concrete cancellation defect.");
		if (semanticAdvice.intent !== "review") throw new Error("Expected review advice fixture");
		semanticAdvice.findingKeyHash = "a".repeat(64);
		const current = {
			...stateFor(manager, 3),
			version: 3,
			deferredAdvice: [
				{
					advice: semanticAdvice,
					stale: true,
					branchWindow: cursorAtTail(branch),
					displayedInEntry: false,
				},
			],
			dedupeHashes: [adviceDedupeKey(semanticAdvice)],
		};
		expect(parsePersistedAdvisorRuntimeState(current, manager.getSessionId(), branch)).toEqual({
			...current,
			version: ADVISOR_RUNTIME_STATE_VERSION,
			dedupeHashes: [{ hash: adviceDedupeKey(semanticAdvice) }],
			recentFindings: [],
		});

		const invalidHash = structuredClone(current);
		if (invalidHash.deferredAdvice[0]?.advice.intent !== "review") {
			throw new Error("Expected persisted review advice fixture");
		}
		invalidHash.deferredAdvice[0].advice.findingKeyHash = "historical-workflow";
		expect(
			parsePersistedAdvisorRuntimeState(invalidHash, manager.getSessionId(), branch),
		).toBeUndefined();

		const mislabeledLegacy = { ...structuredClone(current), version: 1 };
		expect(
			parsePersistedAdvisorRuntimeState(mislabeledLegacy, manager.getSessionId(), branch),
		).toBeUndefined();
	});

	it("migrates strict version 2 state without inventing a review backlog", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const legacyBase = structuredClone(stateFor(manager, 2));
		const version2 = { ...legacyBase, version: 2 };
		expect(
			parsePersistedAdvisorRuntimeState(version2, manager.getSessionId(), manager.getBranch()),
		).toEqual({
			...version2,
			version: ADVISOR_RUNTIME_STATE_VERSION,
			activeDeliveries: [],
			recentFindings: [],
		});
	});

	it("rejects unredacted content in persisted review slots and active deliveries", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const valid = stateFor(manager);
		const window = cursorAtTail(manager.getBranch());
		const unredactedReview = {
			...valid,
			queuedReview: {
				text: "[Executor assistant]\nAPI_KEY=raw-review-secret",
				entryCount: 1,
				truncated: false,
				window,
				turnNumber: 1,
				successfulMemoryTexts: [],
			},
		};
		expect(
			parsePersistedAdvisorRuntimeState(
				unredactedReview,
				manager.getSessionId(),
				manager.getBranch(),
			),
		).toBeUndefined();

		const unsafeAdvice = advice("API_KEY=raw-delivery-secret");
		const unredactedDelivery = {
			advice: unsafeAdvice,
			stale: false,
			branchWindow: window,
			displayedInEntry: false,
			identity: adviceDedupeKey(unsafeAdvice),
			deliveryId: "unredacted-delivery",
			reviewId: "unredacted-review",
			turnNumber: 1,
		};
		expect(
			parsePersistedAdvisorRuntimeState(
				{ ...valid, activeDeliveries: [unredactedDelivery] },
				manager.getSessionId(),
				manager.getBranch(),
			),
		).toBeUndefined();
	});

	it("rejects escape-expanded review slots and active-delivery fields by serialized bytes", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const valid = stateFor(manager);
		const window = cursorAtTail(manager.getBranch());
		const escapeHeavy = `NEWEST-${`"\\\n\u0000`.repeat(260_000)}`;
		const oversizedReview = {
			...valid,
			queuedReview: {
				text: escapeHeavy,
				entryCount: 1,
				truncated: false,
				window,
				turnNumber: 1,
				successfulMemoryTexts: [],
			},
		};
		expect(Buffer.byteLength(JSON.stringify(oversizedReview.queuedReview), "utf8")).toBeGreaterThan(
			1_000_000,
		);
		expect(
			parsePersistedAdvisorRuntimeState(
				oversizedReview,
				manager.getSessionId(),
				manager.getBranch(),
			),
		).toBeUndefined();

		const deliveries = Array.from({ length: 300 }, (_, index) => {
			const note = `${String(index)}-${"\u0000".repeat(1_990)}`;
			const itemAdvice = advice(note);
			const identity = adviceDedupeKey(itemAdvice);
			return {
				advice: itemAdvice,
				stale: false,
				branchWindow: window,
				displayedInEntry: false,
				identity,
				deliveryId: `delivery-${String(index)}`,
				reviewId: `review-${String(index)}`,
				turnNumber: 1,
			};
		});
		expect(Buffer.byteLength(JSON.stringify(deliveries), "utf8")).toBeGreaterThan(1_000_000);
		expect(
			parsePersistedAdvisorRuntimeState(
				{ ...valid, activeDeliveries: deliveries },
				manager.getSessionId(),
				manager.getBranch(),
			),
		).toBeUndefined();
	});

	it("exports only the newest bounded dedupe hashes and restores them safely", () => {
		const dedupe = new BoundedAdviceDedupe(4);
		const notes = ["one", "two", "three", "four"].map(advice);
		for (const note of notes) dedupe.add(note);
		const first = notes[0];
		const second = notes[1];
		const third = notes[2];
		const fourth = notes[3];
		if (
			first === undefined ||
			second === undefined ||
			third === undefined ||
			fourth === undefined
		) {
			throw new Error("Expected all dedupe fixtures");
		}
		expect(dedupe.exportNewestEntries(0)).toEqual([]);
		expect(() => dedupe.exportNewestEntries(-1)).toThrow(RangeError);
		expect(() => dedupe.exportNewestEntries(1.5)).toThrow(RangeError);
		const newest = dedupe.exportNewestEntries(2);
		expect(newest).toHaveLength(2);
		const fourthKey = adviceDedupeKey(fourth);
		expect(dedupe.exportNewestEntries(2, new Set([fourthKey]))).toEqual([
			{ hash: adviceDedupeKey(second) },
			{ hash: adviceDedupeKey(third) },
		]);

		const restored = new BoundedAdviceDedupe(4);
		restored.restoreEntries([{ hash: "invalid" }, ...newest, ...newest]);
		expect(restored.size).toBe(2);
		expect(restored.has(first)).toBe(false);
		expect(restored.has(third)).toBe(true);
		expect(restored.has(fourth)).toBe(true);
	});
});

describe("Quality Slice Q5 dedupe metadata persistence", () => {
	it("round-trips version 4 dedupe metadata and rejects malformed entries", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const branch = manager.getBranch();
		const signature = "0123456789abcdef";
		const withMetadata = {
			...stateFor(manager),
			dedupeHashes: [
				{ hash: "a".repeat(64) },
				{
					hash: "b".repeat(64),
					metadata: { severity: "concern", signature, lastDeliveryTurn: 1 },
				},
			],
			memorySuggestions: {
				...stateFor(manager).memorySuggestions,
				meaningfulTurnCount: 1,
			},
		};
		expect(parsePersistedAdvisorRuntimeState(withMetadata, manager.getSessionId(), branch)).toEqual(
			withMetadata,
		);

		const entry = (hash: string, metadata: unknown) => ({ hash, metadata });
		const badSeverity = {
			...stateFor(manager),
			dedupeHashes: [entry("a".repeat(64), { severity: "urgent", signature, lastDeliveryTurn: 1 })],
		};
		expect(
			parsePersistedAdvisorRuntimeState(badSeverity, manager.getSessionId(), branch),
		).toBeUndefined();
		const badSignature = {
			...stateFor(manager),
			dedupeHashes: [
				entry("a".repeat(64), { severity: "concern", signature: "XYZ", lastDeliveryTurn: 1 }),
			],
		};
		expect(
			parsePersistedAdvisorRuntimeState(badSignature, manager.getSessionId(), branch),
		).toBeUndefined();
		const badTurn = {
			...stateFor(manager),
			dedupeHashes: [
				entry("a".repeat(64), { severity: "concern", signature, lastDeliveryTurn: 0 }),
			],
		};
		expect(
			parsePersistedAdvisorRuntimeState(badTurn, manager.getSessionId(), branch),
		).toBeUndefined();
		const missingTurn = {
			...stateFor(manager),
			dedupeHashes: [entry("a".repeat(64), { severity: "concern", signature })],
		};
		expect(
			parsePersistedAdvisorRuntimeState(missingTurn, manager.getSessionId(), branch),
		).toBeUndefined();
		const unknownMetadataKey = {
			...stateFor(manager),
			dedupeHashes: [
				entry("a".repeat(64), { severity: "concern", signature, lastDeliveryTurn: 1, extra: true }),
			],
		};
		expect(
			parsePersistedAdvisorRuntimeState(unknownMetadataKey, manager.getSessionId(), branch),
		).toBeUndefined();
		const duplicateHashes = {
			...stateFor(manager),
			dedupeHashes: [{ hash: "a".repeat(64) }, { hash: "a".repeat(64) }],
		};
		expect(
			parsePersistedAdvisorRuntimeState(duplicateHashes, manager.getSessionId(), branch),
		).toBeUndefined();
	});

	it("rejects metadata whose last delivery turn exceeds the meaningful turn count", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const branch = manager.getBranch();
		const state = {
			...stateFor(manager),
			dedupeHashes: [
				{
					hash: "a".repeat(64),
					metadata: { severity: "blocker", signature: "0123456789abcdef", lastDeliveryTurn: 2 },
				},
			],
			memorySuggestions: {
				...stateFor(manager).memorySuggestions,
				meaningfulTurnCount: 1,
			},
		};
		expect(
			parsePersistedAdvisorRuntimeState(state, manager.getSessionId(), branch),
		).toBeUndefined();
	});

	it("migrates strict version 2 dedupe hashes to metadata-free entries", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const branch = manager.getBranch();
		const base = stateFor(manager, 2);
		const version2 = {
			...base,
			version: 2,
			dedupeHashes: ["a".repeat(64), "b".repeat(64)],
		};
		expect(parsePersistedAdvisorRuntimeState(version2, manager.getSessionId(), branch)).toEqual({
			...version2,
			version: ADVISOR_RUNTIME_STATE_VERSION,
			activeDeliveries: [],
			dedupeHashes: [{ hash: "a".repeat(64) }, { hash: "b".repeat(64) }],
			recentFindings: [],
		});
	});
});

describe("Quality Slice Q5 dedupe tag persistence", () => {
	it("round-trips the optional dedupe tag on deferred advice and rejects invalid tags", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const branch = manager.getBranch();
		const taggedAdvice = advice("Verify the concrete cancellation defect.");
		if (taggedAdvice.intent !== "review") throw new Error("Expected review advice fixture");
		taggedAdvice.findingKeyHash = "a".repeat(64);
		const tagged = {
			...stateFor(manager),
			deferredAdvice: [
				{
					advice: taggedAdvice,
					stale: true,
					branchWindow: cursorAtTail(branch),
					displayedInEntry: false,
					tag: "re-raised",
				},
			],
		};
		expect(parsePersistedAdvisorRuntimeState(tagged, manager.getSessionId(), branch)).toEqual(
			tagged,
		);
		const invalidTag = {
			...tagged,
			deferredAdvice: [
				{
					advice: taggedAdvice,
					stale: true,
					branchWindow: cursorAtTail(branch),
					displayedInEntry: false,
					tag: "urgent",
				},
			],
		};
		expect(
			parsePersistedAdvisorRuntimeState(invalidTag, manager.getSessionId(), branch),
		).toBeUndefined();
	});

	it("accepts a valid tag and rejects an arbitrary tag value on an active delivery", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const branch = manager.getBranch();
		const taggedAdvice = advice("Verify the concrete cancellation defect.");
		if (taggedAdvice.intent !== "review") throw new Error("Expected review advice fixture");
		taggedAdvice.findingKeyHash = "a".repeat(64);
		const base = stateFor(manager);
		const delivery = {
			advice: taggedAdvice,
			stale: false,
			branchWindow: cursorAtTail(branch),
			displayedInEntry: false,
			identity: adviceDedupeKey(taggedAdvice),
			deliveryId: "tagged-delivery",
			reviewId: "tagged-review",
			turnNumber: 1,
		};
		const tagged = {
			...base,
			activeDeliveries: [delivery],
			memorySuggestions: {
				...base.memorySuggestions,
				meaningfulTurnCount: 1,
			},
		};
		expect(
			parsePersistedAdvisorRuntimeState(
				{ ...tagged, activeDeliveries: [{ ...delivery, tag: "re-raised" }] },
				manager.getSessionId(),
				branch,
			),
		).toEqual({
			...tagged,
			activeDeliveries: [{ ...delivery, tag: "re-raised" }],
		});
		expect(
			parsePersistedAdvisorRuntimeState(
				{ ...tagged, activeDeliveries: [{ ...delivery, tag: "urgent" }] },
				manager.getSessionId(),
				branch,
			),
		).toBeUndefined();
		expect(
			parsePersistedAdvisorRuntimeState(
				{ ...tagged, activeDeliveries: [{ ...delivery, tag: 7 }] },
				manager.getSessionId(),
				branch,
			),
		).toBeUndefined();
	});
});
