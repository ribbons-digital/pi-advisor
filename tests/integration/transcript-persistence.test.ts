import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	ADVISOR_TRANSCRIPT_ENTRY_TYPE,
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	MAX_INSPECTED_TRANSCRIPT_RECORDS,
	MAX_PERSISTED_TRANSCRIPT_RECORD_BYTES,
	parsePersistedAdvisorTranscriptRecord,
	type AdvisorConfig,
	type AdvisorRuntime,
} from "../../src/index.js";
import { isRecordValue } from "../../src/value-guards.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

interface TranscriptRecordProbe {
	kind?: unknown;
	reviewId?: unknown;
	outputBytes?: number;
}

function configFor(provider: ScriptedProvider, transcript?: boolean): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.defaultEnabled = true;
	config.model = `${provider.model.provider}/${provider.model.id}`;
	if (transcript !== undefined) config.persistence.transcript = transcript;
	return config;
}

function extensionFor(
	config: AdvisorConfig,
	onRuntime: (runtime: AdvisorRuntime) => void,
): InlineExtension {
	return {
		name: "pi-advisor-transcript-persistence-test",
		factory: createPiAdvisorExtension({ config, hooks: { onRuntime } }),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

function createBarrier() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function scriptedAssistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "pi-advisor-scripted",
		provider: "fixture",
		model: "fixture",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe.sequential("local redacted activity records", () => {
	it("does not append activity records with an explicit opt-out", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "ordinary answer" }] },
		]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor, false), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("explicit activity recording opt-out");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(
				harness.sessionManager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "custom" && entry.customType === ADVISOR_TRANSCRIPT_ENTRY_TYPE,
					),
			).toHaveLength(0);
			expect(runtime?.getStatus()).toMatchObject({
				transcriptPersistenceEnabled: false,
				transcriptRecordsPersisted: 0,
				transcriptPersistenceFailures: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("enables metadata-only activity records by default", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("default activity recording check");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const records = harness.sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === ADVISOR_TRANSCRIPT_ENTRY_TYPE,
				);
			expect(records).toHaveLength(2);
			expect(
				records.flatMap((entry) =>
					entry.type === "custom" ? [(entry.data as { kind: string }).kind] : [],
				),
			).toEqual(["review-start", "review-outcome"]);
			expect(runtime?.getStatus()).toMatchObject({
				transcriptPersistenceEnabled: true,
				transcriptRecordsPersisted: 2,
				transcriptPersistenceFailures: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("persists a bounded handled governor outcome when activity recording is enabled", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "persisted-governor-read",
						name: "read",
						arguments: { path: "README.md" },
					},
				],
				stopReason: "toolUse",
			},
		]);
		const config = configFor(advisor, true);
		config.limits.maxToolCallsPerUpdate = 0;
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(config, (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("persist handled governor exhaustion");
			await waitFor(() => runtime?.getStatus().governorSkippedReviews === 1);
			const sessionId = harness.sessionManager.getSessionId();
			const records = harness.sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === ADVISOR_TRANSCRIPT_ENTRY_TYPE,
				)
				.map((entry) =>
					entry.type === "custom"
						? parsePersistedAdvisorTranscriptRecord(entry.data, sessionId)
						: undefined,
				);
			const start = records.find(
				(record) => record?.version === 2 && record.kind === "review-start",
			);
			const attempt = records.find(
				(record) => record?.version === 2 && record.kind === "tool-attempt",
			);
			const outcome = records.find(
				(record) => record?.version === 2 && record.kind === "review-outcome",
			);
			expect(start).toBeDefined();
			expect(attempt).toMatchObject({
				ordinal: 1,
				toolName: "read",
				path: "README.md",
				completed: true,
			});
			expect(outcome).toMatchObject({
				outcome: "governor-skipped",
				reason: "Advisor tool-call limit reached",
				stopReason: "tool-call-limit",
			});
			expect(
				new Set(records.flatMap((record) => (record?.version === 2 ? [record.reviewId] : []))),
			).toEqual(new Set([start?.version === 2 ? start.reviewId : "missing"]));
			expect(runtime?.getStatus()).toMatchObject({
				failedReviews: 0,
				consecutiveFailures: 0,
				governorSkippedReviews: 1,
				lastGovernorOutcome: "Advisor tool-call limit reached",
			});
		} finally {
			await harness.dispose();
		}
	});

	it("records failed read-only tool metadata without its result body", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "missing-read",
						name: "read",
						arguments: { path: "missing-activity-file.txt" },
					},
				],
				stopReason: "toolUse",
			},
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
			await harness.session.prompt("inspect a missing file");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const attempt = harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" &&
					entry.customType === ADVISOR_TRANSCRIPT_ENTRY_TYPE &&
					isRecordValue<TranscriptRecordProbe>(entry.data) &&
					"kind" in entry.data &&
					entry.data.kind === "tool-attempt"
						? [entry.data]
						: [],
				)[0];
			expect(attempt).toMatchObject({
				toolName: "read",
				path: "missing-activity-file.txt",
				completed: true,
				isError: true,
			});
			expect(attempt?.outputBytes).toBeGreaterThan(0);
			expect(JSON.stringify(attempt)).not.toContain("ENOENT");
		} finally {
			await harness.dispose();
		}
	});

	it("keeps one review identifier and aggregate usage across a terminal retry failure", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "first provider failure", usage: { input: 5, output: 1, costUsd: 0.01 } },
			{ errorMessage: "second provider failure", usage: { input: 7, output: 2, costUsd: 0.02 } },
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
			await harness.session.prompt("record a retried failure");
			await waitFor(
				() =>
					runtime?.getStatus().failedReviews === 2 &&
					runtime.getStatus().retryAttempts === 1 &&
					advisor.activeRequests === 0,
			);
			const records = harness.sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === ADVISOR_TRANSCRIPT_ENTRY_TYPE,
				)
				.flatMap((entry) =>
					entry.type === "custom" && isRecordValue<TranscriptRecordProbe>(entry.data)
						? [entry.data]
						: [],
				);
			expect(records.map((record) => record.kind)).toEqual(["review-start", "review-outcome"]);
			expect(new Set(records.map((record) => record.reviewId)).size).toBe(1);
			expect(records[1]).toMatchObject({
				outcome: "failed",
				reason: "second provider failure",
				input: 12,
				output: 3,
				total: 15,
				costUsd: 0.03,
				stopReason: "error",
			});
			expect(runtime?.getStatus()).toMatchObject({ reviewRequests: 2, retryAttempts: 1 });
		} finally {
			await harness.dispose();
		}
	});

	it("keeps invalidated attempt records off the replacement branch", async () => {
		const advisorBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "original branch answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "invalidated-attempt-read",
						name: "read",
						arguments: { path: "does-not-exist.txt" },
					},
				],
				stopReason: "toolUse",
				usage: { input: 10, output: 2, costUsd: 0.01 },
				waitFor: advisorBarrier.promise,
			},
			{ content: [], usage: { input: 20, output: 3, costUsd: 0.02 } },
		]);
		const manager = SessionManager.inMemory();
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [extensionFor(configFor(advisor, true), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("create an attempt to invalidate");
			await waitFor(() => advisor.activeRequests === 1);
			const originalUser = manager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (originalUser === undefined) throw new Error("Expected original user entry");
			manager.branch(originalUser.id);
			manager.appendMessage(scriptedAssistant("replacement branch answer"));

			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().branchResets === 1);
			await waitFor(() => advisor.activeRequests === 0);

			const activeRecordKinds = manager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === ADVISOR_TRANSCRIPT_ENTRY_TYPE,
				)
				.map((entry) => {
					if (entry.type !== "custom" || !isRecordValue<TranscriptRecordProbe>(entry.data)) {
						return undefined;
					}
					return entry.data.kind;
				});
			expect(activeRecordKinds).not.toContain("tool-attempt");
			expect(activeRecordKinds).not.toContain("review-outcome");
			expect(runtime?.getStatus()).toMatchObject({
				reviewRequests: 1,
				reviewsCompleted: 0,
				usage: { input: 30, output: 5, total: 35, costUsd: 0.03 },
			});
		} finally {
			advisorBarrier.release();
			await harness.dispose();
		}
	});

	it("bounds restored activity inspection to the newest records", async () => {
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
		const manager = SessionManager.inMemory();
		const sessionId = manager.getSessionId();
		for (let index = 0; index < MAX_INSPECTED_TRANSCRIPT_RECORDS + 20; index++) {
			manager.appendCustomEntry(ADVISOR_TRANSCRIPT_ENTRY_TYPE, {
				version: 2,
				sessionId,
				savedAt: index + 1,
				reviewId: `review-${String(index)}`,
				kind: "review-start",
				entryCount: 1,
				truncated: false,
			});
		}
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			expect(runtime?.getStatus().transcriptRecordsPersisted).toBe(
				MAX_INSPECTED_TRANSCRIPT_RECORDS + 20,
			);
			const dump = runtime?.formatDiagnosticsDump() ?? "";
			expect(dump).toContain(`"availableRecordCount": ${String(MAX_INSPECTED_TRANSCRIPT_RECORDS)}`);
			expect(dump).toContain(
				`"reviewId": "review-${String(MAX_INSPECTED_TRANSCRIPT_RECORDS + 19)}"`,
			);
			expect(dump).not.toContain('"reviewId": "review-0"');
		} finally {
			await harness.dispose();
		}
	});

	it("stores only bounded redacted records outside model context when explicitly enabled", async () => {
		const primary = createPrimaryProvider([
			{
				content: [
					{ type: "thinking", thinking: "EXECUTOR-PRIVATE-REASONING-SENTINEL" },
					{
						type: "text",
						text: "Visible result with API_KEY=persistence-secret-value",
					},
				],
			},
			{ content: [{ type: "text", text: "Primary context remained isolated." }] },
		]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{ type: "thinking", thinking: "ADVISOR-PRIVATE-REASONING-SENTINEL" },
					{
						type: "toolCall",
						id: "persistence-read",
						name: "read",
						arguments: { path: "large-persisted-result.txt" },
					},
					{
						type: "toolCall",
						id: "persistence-read-repeat",
						name: "read",
						arguments: { path: "large-persisted-result.txt" },
					},
					{
						type: "toolCall",
						id: "persistence-find",
						name: "find",
						arguments: { path: ".", pattern: "API_KEY=persisted-target-secret-value" },
					},
				],
				stopReason: "toolUse",
				usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.01 },
			},
			{
				content: [
					{
						type: "toolCall",
						id: "persistence-advice",
						name: "advise",
						arguments: {
							note: "Verify the missing file before completion.",
							severity: "concern",
							intent: "review",
						},
					},
				],
				stopReason: "toolUse",
				usage: { input: 20, output: 3, costUsd: 0.02 },
			},
			{ content: [], usage: { input: 30, output: 4, costUsd: 0.03 } },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor, true), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
			setup: async (cwd) => {
				await writeFile(
					join(cwd, "large-persisted-result.txt"),
					`API_KEY=persisted-tool-secret-value\n${"large tool result line\n".repeat(8_000)}`,
				);
			},
		});
		try {
			await harness.session.prompt("persist a bounded review");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const sessionId = harness.sessionManager.getSessionId();
			const entries = harness.sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === ADVISOR_TRANSCRIPT_ENTRY_TYPE,
				);
			const records = entries.map((entry) => {
				if (entry.type !== "custom") throw new Error("Expected transcript custom entry");
				return parsePersistedAdvisorTranscriptRecord(entry.data, sessionId);
			});
			expect(records.every((record) => record?.version === 2)).toBe(true);
			const activities = records.flatMap((record) => (record?.version === 2 ? [record] : []));
			const serialized = JSON.stringify(activities);
			const starts = activities.filter((record) => record.kind === "review-start");
			const attempts = activities.filter((record) => record.kind === "tool-attempt");
			const outcomes = activities.filter((record) => record.kind === "review-outcome");
			expect(starts).toHaveLength(1);
			expect(attempts.map((attempt) => attempt.ordinal)).toEqual([1, 2, 3, 4]);
			expect(attempts.slice(0, 2).map((attempt) => attempt.path)).toEqual([
				"large-persisted-result.txt",
				"large-persisted-result.txt",
			]);
			expect(attempts[0]).toMatchObject({
				toolName: "read",
				internal: false,
				completed: true,
				isError: false,
			});
			expect(attempts[0]?.outputBytes).toBeGreaterThan(0);
			expect(attempts[0]?.outputLines).toBeGreaterThan(0);
			expect(attempts[2]).toMatchObject({
				toolName: "find",
				path: ".",
				pattern: "API_KEY=[REDACTED]",
			});
			expect(attempts[3]).toMatchObject({
				toolName: "advise",
				internal: true,
				completed: true,
				isError: false,
			});
			expect(attempts[3]).not.toHaveProperty("path");
			expect(attempts[3]).not.toHaveProperty("pattern");
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]).toMatchObject({
				outcome: "accepted",
				delivery: "deferred",
				stale: false,
				input: 30,
				output: 5,
				cacheRead: 3,
				cacheWrite: 4,
				total: 42,
				costUsd: 0.03,
				stopReason: "toolUse",
			});
			expect(new Set(activities.map((record) => record.reviewId)).size).toBe(1);
			for (const record of activities) {
				expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThanOrEqual(
					MAX_PERSISTED_TRANSCRIPT_RECORD_BYTES,
				);
			}
			expect(serialized).toContain('"kind":"review-start"');
			expect(serialized).toContain('"kind":"tool-attempt"');
			expect(serialized).toContain('"kind":"review-outcome"');
			expect(serialized).toContain("[REDACTED]");
			for (const prohibited of [
				"persistence-secret-value",
				"persisted-tool-secret-value",
				"persisted-target-secret-value",
				"large tool result line",
				"Verify the missing file before completion",
				"EXECUTOR-PRIVATE-REASONING-SENTINEL",
				"ADVISOR-PRIVATE-REASONING-SENTINEL",
				'"arguments"',
				'"advice"',
				'"text"',
			]) {
				expect(serialized).not.toContain(prohibited);
			}
			expect(runtime?.getStatus()).toMatchObject({
				transcriptPersistenceEnabled: true,
				transcriptRecordsPersisted: entries.length,
				transcriptPersistenceFailures: 0,
				reviewRequests: 1,
				reviewsCompleted: 1,
				usage: {
					input: 30,
					output: 5,
					cacheRead: 3,
					cacheWrite: 4,
					total: 42,
					costUsd: 0.03,
				},
			});
			const dump = runtime?.formatDiagnosticsDump() ?? "";
			expect(dump).toContain("activity-v2-metadata-only");
			expect(dump).toContain('"recordSchema": "activity-v2"');
			expect(dump).toContain('"newActivityRecordsMetadataOnly": true');
			expect(dump).toContain('"reasoningIncluded": false');
			expect(dump).toContain('"fileContentBodiesIncluded": false');
			expect(dump).not.toContain("Verify the missing file before completion");
			expect(dump).not.toContain("EXECUTOR-PRIVATE-REASONING-SENTINEL");
			expect(dump).not.toContain("ADVISOR-PRIVATE-REASONING-SENTINEL");
			await runtime?.disable();
			await harness.session.prompt("inspect primary context after persisted records");
			const primaryContext = JSON.stringify(primary.requests[1]?.context.messages);
			expect(primaryContext).not.toContain(ADVISOR_TRANSCRIPT_ENTRY_TYPE);
			expect(primaryContext).not.toContain("Verify the missing file before completion");
			expect(primaryContext).not.toContain("ADVISOR-PRIVATE-REASONING-SENTINEL");
		} finally {
			await harness.dispose();
		}
	});
});
