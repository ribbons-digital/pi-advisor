import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	SessionManager,
	defineTool,
	type ExtensionAPI,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
	ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
	ADVISOR_RUNTIME_STATE_VERSION,
	createPiAdvisorExtension,
	cursorAtTail,
	DEFAULT_ADVISOR_CONFIG,
	MUTES_FILE_NAME,
	MuteStore,
	normalizeAdviceForDedupe,
	type AdvisorConfig,
	type AdvisorRuntime,
	type PersistedAdvisorRuntimeState,
} from "../../src/index.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

const KEY_A = "defect-mute-alpha";
const NOTE_A = "The migration rollback path drops pending state on failure.";
const NOTE_A_PARAPHRASE = "The migration rollback path loses the pending state when it fails.";
const COLLISION_KEY_A = "collision-key-12947";
const COLLISION_KEY_B = "collision-key-84690";

function findingHash(findingKey: string): string {
	return createHash("sha256")
		.update(`review-finding:${normalizeAdviceForDedupe(findingKey)}`)
		.digest("hex");
}

function configFor(
	provider: ScriptedProvider,
	mutate?: (config: AdvisorConfig) => void,
): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.defaultEnabled = true;
	config.model = `${provider.model.provider}/${provider.model.id}`;
	// Keep every note deferred so delivery lands in the next primary request
	// instead of triggering idle follow-up turns that change review pacing.
	config.delivery.activeIdleSeverities = [];
	mutate?.(config);
	return config;
}

function extensionFor(
	config: AdvisorConfig,
	onRuntime: (runtime: AdvisorRuntime) => void,
): InlineExtension {
	return {
		name: "pi-advisor-mutes-test",
		factory: createPiAdvisorExtension({
			config,
			hooks: { onRuntime },
		}),
	};
}

function reviewAdvice(
	note: string,
	findingKey: string,
	severity: "nit" | "concern" | "blocker" = "concern",
	id = "q6-advice",
) {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "advise",
				arguments: { note, findingKey, severity, intent: "review" },
			},
		],
		stopReason: "toolUse" as const,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

function createBarrier(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function latestRuntimeState(manager: SessionManager): PersistedAdvisorRuntimeState | undefined {
	const latest = [...manager.getBranch()]
		.reverse()
		.find(
			(entry) => entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
		);
	return latest?.type === "custom" ? (latest.data as PersistedAdvisorRuntimeState) : undefined;
}

describe.sequential("Quality Slice Q6 mutes (F13, Q6-D2, Q6-A1)", () => {
	it("mutes a delivered finding by its 8-hex ID and suppresses similarity and escalation redelivery", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "one" }] },
			{ content: [{ type: "text", text: "two" }] },
			{ content: [{ type: "text", text: "three" }] },
			{ content: [{ type: "text", text: "four" }] },
		]);
		const advisor = createAdvisorProvider([
			reviewAdvice(NOTE_A, KEY_A, "concern"),
			reviewAdvice(NOTE_A_PARAPHRASE, KEY_A, "concern"),
			reviewAdvice(NOTE_A, KEY_A, "blocker"),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.dedupe.reRaiseMinTurns = 2;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
			setup: (_cwd, agentDir) => {
				process.env.PI_CODING_AGENT_DIR = agentDir;
			},
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);

			const hashA = findingHash(KEY_A);
			const shortId = hashA.slice(0, 8);
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 0,
				notesSuppressed: 0,
				lastNoteSeverity: "concern",
				lastNoteFindingKey: KEY_A,
			});
			expect(runtime?.resolveMuteTarget(shortId)).toEqual({
				kind: "match",
				hash: hashA,
				label: KEY_A,
			});

			// Mute before any later review so the suppression path is exercised
			// deterministically, then let the deferred note materialize.
			const muted = await runtime?.muteFinding(hashA, KEY_A);
			expect(muted).toEqual({ ok: true, message: `Muted ${shortId} (${KEY_A}).` });
			expect(runtime?.muteList()).toEqual([{ id: shortId, label: KEY_A }]);
			const mutesPath = join(harness.agentDir, MUTES_FILE_NAME);
			const mutesFile = await readFile(mutesPath, "utf8");
			expect(mutesFile).toContain(shortId);
			expect(mutesFile).toContain(KEY_A);

			// The muted finding beats the queued delivery, Q5 similarity delivery,
			// and escalation re-raise. Each prompt waits for its review to settle so
			// the scripted provider is never raced by supersession or retry churn.
			await harness.session.prompt("deliver deferred note");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 0);
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			await harness.session.prompt("review two");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 3);
			await harness.session.prompt("review three");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 4);
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 0,
				notesSuppressed: 0,
				mutedSuppressions: 3,
			});
			const context = JSON.stringify(primary.requests[3]?.context);
			expect(context).not.toContain(NOTE_A_PARAPHRASE);
			expect(context).not.toContain('tag=\\"possible-duplicate\\"');
			expect(context).not.toContain('tag=\\"re-raised\\"');

			// The v5 runtime state persists the recent-findings entry.
			const state = latestRuntimeState(harness.sessionManager);
			expect(state?.recentFindings).toContainEqual({ hash: hashA, label: KEY_A });
		} finally {
			await harness.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("fails closed on zero matches and forced prefix collisions, then resolves a longer prefix", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "one" }] },
			{ content: [{ type: "text", text: "two" }] },
			{ content: [{ type: "text", text: "three" }] },
		]);
		const advisor = createAdvisorProvider([
			reviewAdvice(NOTE_A, COLLISION_KEY_A),
			reviewAdvice(NOTE_A_PARAPHRASE, COLLISION_KEY_B),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("review two");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);

			const hashA = findingHash(COLLISION_KEY_A);
			const hashB = findingHash(COLLISION_KEY_B);
			expect(hashA.slice(0, 8)).toBe(hashB.slice(0, 8));
			expect(hashA).not.toBe(hashB);

			// Zero matches fail closed with no write.
			expect(runtime?.resolveMuteTarget("f".repeat(8))).toEqual({ kind: "unknown" });

			// A forced 8-hex collision fails closed and lists both labels.
			const collision = runtime?.resolveMuteTarget(hashA.slice(0, 8));
			expect(collision?.kind).toBe("collision");
			if (collision?.kind !== "collision") throw new Error("Expected collision");
			expect(collision.matches.map((match) => match.label).sort()).toEqual([
				COLLISION_KEY_A,
				COLLISION_KEY_B,
			]);

			// A longer prefix resolves exactly one finding.
			expect(runtime?.resolveMuteTarget(hashA.slice(0, 12))).toEqual({
				kind: "match",
				hash: hashA,
				label: COLLISION_KEY_A,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("unmutes by prefix, updates the mutes file, and restores delivery", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "one" }] },
			{ content: [{ type: "text", text: "two" }] },
			{ content: [{ type: "text", text: "three" }] },
			{ content: [{ type: "text", text: "four" }] },
		]);
		const advisor = createAdvisorProvider([
			reviewAdvice(NOTE_A, KEY_A, "concern"),
			{ content: [] },
			reviewAdvice(NOTE_A, KEY_A, "blocker"),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.dedupe.reRaiseMinTurns = 1;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
			setup: (_cwd, agentDir) => {
				process.env.PI_CODING_AGENT_DIR = agentDir;
			},
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const hashA = findingHash(KEY_A);
			await runtime?.muteFinding(hashA, KEY_A);
			expect(runtime?.muteList()).toHaveLength(1);

			// A longer unmute prefix resolves the single muted entry.
			const result = await runtime?.unmuteFinding(hashA.slice(0, 16));
			expect(result).toEqual({ ok: true, message: `Unmuted ${hashA.slice(0, 8)} (${KEY_A}).` });
			expect(runtime?.muteList()).toEqual([]);
			const mutesFile = await readFile(join(harness.agentDir, MUTES_FILE_NAME), "utf8");
			expect(mutesFile).not.toContain(KEY_A);

			// With the mute gone, the escalation re-raise delivers again.
			await harness.session.prompt("review two");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			await harness.session.prompt("review three");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 3);
			await harness.session.prompt("review four");
			await waitFor(() => (runtime?.getStatus().notesDelivered ?? 0) >= 2);
			const context = JSON.stringify(primary.requests[3]?.context);
			expect(context).toContain('tag=\\"re-raised\\"');
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 2, mutedSuppressions: 0 });
		} finally {
			await harness.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("fails closed on a malformed mutes file and never overwrites it until repaired", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "one" }] }]);
		const advisor = createAdvisorProvider([reviewAdvice(NOTE_A, KEY_A)]);
		let runtime: AdvisorRuntime | undefined;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const MALFORMED = "not: [valid\n  - yaml: {";
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
			setup: async (_cwd, agentDir) => {
				process.env.PI_CODING_AGENT_DIR = agentDir;
				await writeFile(join(agentDir, MUTES_FILE_NAME), MALFORMED, "utf8");
			},
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const hashA = findingHash(KEY_A);

			// The load failed at session start; a mute must fail closed without
			// touching the malformed file.
			const rejected = await runtime?.muteFinding(hashA, KEY_A);
			expect(rejected?.ok).toBe(false);
			expect(rejected?.message).toContain("malformed");
			expect(rejected?.message).toContain("not modified");
			expect(await readFile(join(harness.agentDir, MUTES_FILE_NAME), "utf8")).toBe(MALFORMED);

			// Repair the file with an existing mute; the next mute loads the real
			// entries and appends instead of replacing them.
			const existing = { id: "b".repeat(64), label: "existing-mute" };
			await writeFile(join(harness.agentDir, MUTES_FILE_NAME), JSON.stringify([existing]), "utf8");
			const accepted = await runtime?.muteFinding(hashA, KEY_A);
			expect(accepted?.ok).toBe(true);
			const repaired = await readFile(join(harness.agentDir, MUTES_FILE_NAME), "utf8");
			expect(repaired).toContain("existing-mute");
			expect(repaired).toContain(KEY_A);
			expect(runtime?.muteList()).toHaveLength(2);
		} finally {
			await harness.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("merges a concurrent session's mutes instead of clobbering them", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "one" }] }]);
		const advisor = createAdvisorProvider([reviewAdvice(NOTE_A, KEY_A)]);
		let runtime: AdvisorRuntime | undefined;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
			setup: (_cwd, agentDir) => {
				process.env.PI_CODING_AGENT_DIR = agentDir;
			},
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const hashA = findingHash(KEY_A);
			await runtime?.muteFinding(hashA, KEY_A);

			// A concurrent Pi session reloads the file, adds its own mute, and
			// saves on top of the fresh content.
			const concurrentLoad = await MuteStore.load(join(harness.agentDir, MUTES_FILE_NAME));
			concurrentLoad.store.mute("c".repeat(64), "concurrent-mute");
			await concurrentLoad.store.save(concurrentLoad.fingerprint);

			// Our unmute must reload the file, apply on top of the fresh entries,
			// and preserve the concurrent mute.
			const result = await runtime?.unmuteFinding(hashA.slice(0, 8));
			expect(result?.ok).toBe(true);
			const after = await MuteStore.load(join(harness.agentDir, MUTES_FILE_NAME));
			expect(after.store.list().map((entry) => entry.label)).toEqual(["concurrent-mute"]);
		} finally {
			await harness.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("suggests actionable longer prefixes on a mute collision", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "one" }] }]);
		const advisor = createAdvisorProvider([reviewAdvice(NOTE_A, COLLISION_KEY_A)]);
		let runtime: AdvisorRuntime | undefined;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
			setup: (_cwd, agentDir) => {
				process.env.PI_CODING_AGENT_DIR = agentDir;
			},
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const hashA = findingHash(COLLISION_KEY_A);
			const hashB = findingHash(COLLISION_KEY_B);
			// Both colliding findings are muted so the unmute prefix resolution
			// reports the collision with actionable longer prefixes.
			await runtime?.muteFinding(hashA, COLLISION_KEY_A);
			await runtime?.muteFinding(hashB, COLLISION_KEY_B);
			const result = await runtime?.unmuteFinding(hashA.slice(0, 8));
			expect(result?.ok).toBe(false);
			expect(result?.message).toContain("Use one of these longer prefixes");
			expect(result?.message).toContain(hashA.slice(0, 9));
			expect(result?.message).toContain(hashB.slice(0, 9));
			expect(result?.message).toContain(COLLISION_KEY_A);
			expect(result?.message).toContain(COLLISION_KEY_B);
		} finally {
			await harness.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("drops a queued deferred note at materialization when the finding is muted after queueing", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "one" }] },
			{ content: [{ type: "text", text: "two" }] },
			{ content: [{ type: "text", text: "three" }] },
			{ content: [{ type: "text", text: "four" }] },
		]);
		const advisor = createAdvisorProvider([
			reviewAdvice(NOTE_A, KEY_A),
			{ content: [] },
			reviewAdvice(NOTE_A, KEY_A),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
			setup: (_cwd, agentDir) => {
				process.env.PI_CODING_AGENT_DIR = agentDir;
			},
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);

			// Mute after the note is already queued as deferred advice.
			const hashA = findingHash(KEY_A);
			const muted = await runtime?.muteFinding(hashA, KEY_A);
			expect(muted?.ok).toBe(true);

			// The next user turn materializes the deferred queue; the muted note
			// must be dropped without entering model context or the delivered count.
			await harness.session.prompt("deliver deferred note");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 0);
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 0,
				mutedSuppressions: 1,
			});
			const context = JSON.stringify(primary.requests[1]?.context);
			expect(context).not.toContain(NOTE_A);

			// After an unmute, the same finding must deliver again: the dropped
			// note never entered the Executor, so its admission-time dedupe key
			// was removed and cannot suppress the fresh review.
			await runtime?.unmuteFinding(hashA.slice(0, 8));
			await harness.session.prompt("review again");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 3);
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 0, mutedSuppressions: 1 });
			await harness.session.prompt("deliver again");
			await waitFor(() => (runtime?.getStatus().notesDelivered ?? 0) >= 1);
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 1, mutedSuppressions: 1 });
			const redelivered = JSON.stringify(primary.requests[3]?.context);
			expect(redelivered).toContain(NOTE_A);
		} finally {
			await harness.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("drops restored-after-resume deferred advice when its finding is muted", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const hashA = findingHash(KEY_A);
		const branch = manager.getBranch();
		const state: PersistedAdvisorRuntimeState = {
			version: ADVISOR_RUNTIME_STATE_VERSION,
			sessionId: manager.getSessionId(),
			savedAt: Date.now(),
			cursor: cursorAtTail(branch),
			activeDeliveries: [],
			deferredAdvice: [
				{
					advice: {
						intent: "review",
						note: NOTE_A,
						severity: "concern",
						findingKeyHash: hashA,
						findingKey: KEY_A,
						truncated: false,
						originalCharacters: NOTE_A.length,
						originalEstimatedTokens: Math.ceil(NOTE_A.length / 4),
						createdAt: Date.now(),
					},
					stale: false,
					branchWindow: cursorAtTail(branch),
					displayedInEntry: false,
				},
			],
			dedupeHashes: [],
			recentFindings: [],
			memorySuggestions: {
				meaningfulTurnCount: 0,
				admittedCount: 0,
				deliveredCount: 0,
				sessionCapReached: false,
			},
			notesDelivered: 0,
		};
		manager.appendCustomEntry(ADVISOR_RUNTIME_STATE_ENTRY_TYPE, state);

		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "resumed" }] }]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const harness = await createSessionHarness({
			sessionManager: manager,
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
			setup: async (_cwd, agentDir) => {
				process.env.PI_CODING_AGENT_DIR = agentDir;
				await writeFile(
					join(agentDir, MUTES_FILE_NAME),
					JSON.stringify([{ id: hashA, label: KEY_A }]),
					"utf8",
				);
			},
		});
		try {
			await harness.session.prompt("resumed session");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 0);
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 0,
				mutedSuppressions: 1,
			});
			const context = JSON.stringify(primary.requests[0]?.context);
			expect(context).not.toContain(NOTE_A);
		} finally {
			await harness.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("does not record a finding whose active delivery failed", async () => {
		const releaseTurn = createBarrier();
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-mute", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{ waitFor: releaseTurn.promise, content: [{ type: "text", text: "finished" }] },
		]);
		const advisor = createAdvisorProvider([reviewAdvice(NOTE_A, KEY_A), { content: [] }]);
		const hold = defineTool({
			name: "hold",
			label: "hold",
			description: "Keep the Executor busy so advice dispatches as active steering.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
		});
		let runtime: AdvisorRuntime | undefined;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [hold],
			tools: ["hold"],
			mode: "rpc",
			setup: (_cwd, agentDir) => {
				process.env.PI_CODING_AGENT_DIR = agentDir;
			},
		});
		try {
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			const extensionApi = Reflect.get(activeRuntime, "pi") as ExtensionAPI;
			const sendMessage = vi.spyOn(extensionApi, "sendMessage").mockImplementation(() => {
				throw new Error("scripted active delivery failure");
			});
			try {
				const turn = harness.session.prompt("start failing active delivery");
				// The primary turn stays in flight (its second response is held), so
				// the review dispatches active steering and the send fails.
				await waitFor(() => activeRuntime.getStatus().deliveryFailures === 1);
				releaseTurn.release();
				await turn.catch(() => undefined);
				const hashA = findingHash(KEY_A);
				// The failed send never committed, so the finding is not
				// mute-resolvable and no last note is surfaced.
				expect(activeRuntime.resolveMuteTarget(hashA.slice(0, 8))).toEqual({ kind: "unknown" });
				const status = activeRuntime.getStatus();
				expect(status.lastNoteSeverity).toBeUndefined();
				expect(status.lastNoteCreatedAt).toBeUndefined();
				expect(status.activeNotesPending).toBe(0);
				expect(status.mutedSuppressions).toBe(0);
			} finally {
				sendMessage.mockRestore();
			}
		} finally {
			await harness.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("restores the recent-findings index on a compatible resume so mute IDs resolve", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const hashA = findingHash(KEY_A);
		const state: PersistedAdvisorRuntimeState = {
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
			recentFindings: [{ hash: hashA, label: KEY_A }],
			notesDelivered: 1,
		};
		manager.appendCustomEntry(ADVISOR_RUNTIME_STATE_ENTRY_TYPE, state);

		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "first" }] }]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			sessionManager: manager,
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("resumed");
			await waitFor(() => runtime !== undefined);
			expect(runtime?.resolveMuteTarget(hashA.slice(0, 8))).toEqual({
				kind: "match",
				hash: hashA,
				label: KEY_A,
			});
		} finally {
			await harness.dispose();
		}
	});
});
