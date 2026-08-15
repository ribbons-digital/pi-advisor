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

function stateFor(manager: SessionManager): PersistedAdvisorRuntimeState {
	return {
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
		notesDelivered: 0,
	};
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
			parsePersistedAdvisorRuntimeState({ ...valid, version: 4 }, manager.getSessionId(), branch),
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
		const legacyBase = structuredClone(stateFor(manager));
		Reflect.deleteProperty(legacyBase, "activeDeliveries");
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
		});

		const semanticAdvice = advice("Verify the concrete cancellation defect.");
		if (semanticAdvice.intent !== "review") throw new Error("Expected review advice fixture");
		semanticAdvice.findingKeyHash = "a".repeat(64);
		const current = {
			...stateFor(manager),
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
		expect(parsePersistedAdvisorRuntimeState(current, manager.getSessionId(), branch)).toEqual(
			current,
		);

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
		const legacyBase = structuredClone(stateFor(manager));
		Reflect.deleteProperty(legacyBase, "activeDeliveries");
		const version2 = { ...legacyBase, version: 2 };
		expect(
			parsePersistedAdvisorRuntimeState(version2, manager.getSessionId(), manager.getBranch()),
		).toEqual({
			...version2,
			version: ADVISOR_RUNTIME_STATE_VERSION,
			activeDeliveries: [],
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
		expect(dedupe.exportNewestKeys(0)).toEqual([]);
		expect(() => dedupe.exportNewestKeys(-1)).toThrow(RangeError);
		expect(() => dedupe.exportNewestKeys(1.5)).toThrow(RangeError);
		const newest = dedupe.exportNewestKeys(2);
		expect(newest).toHaveLength(2);
		const fourthKey = adviceDedupeKey(fourth);
		expect(dedupe.exportNewestKeys(2, new Set([fourthKey]))).toEqual([
			adviceDedupeKey(second),
			adviceDedupeKey(third),
		]);

		const restored = new BoundedAdviceDedupe(4);
		restored.restoreKeys(["invalid", ...newest, ...newest]);
		expect(restored.size).toBe(2);
		expect(restored.has(first)).toBe(false);
		expect(restored.has(third)).toBe(true);
		expect(restored.has(fourth)).toBe(true);
	});
});
