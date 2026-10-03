import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	type AdvisorRuntime,
	type PersistedAdvisorRuntimeState,
} from "../../src/index.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import { runtimeInternals } from "../fixtures/runtime-internals.js";
import { createAdvisorProvider, createPrimaryProvider } from "../fixtures/scripted-provider.js";

describe.sequential("Pi 1.0 effective instructions after JSONL reopen", () => {
	it.each([
		["return", "deferred"],
		["force option", "deferred"],
		["legacy without fingerprint", "deferred"],
		["return", "review"],
		["force option", "review"],
		["legacy without fingerprint", "review"],
		["return", "queued"],
		["force option", "queued"],
		["legacy without fingerprint", "queued"],
	] as const)(
		"checks changed and unchanged %s instructions before recovered %s",
		async (kind, ownership) => {
			for (const changed of [false, true]) {
				const root = await mkdtemp(join(tmpdir(), "advisor-forced-reopen-"));
				const project = join(root, "project");
				const sessions = join(root, "sessions");
				await mkdir(project);
				await mkdir(sessions);
				let first: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
				let resumed: typeof first;
				let release: () => void = () => undefined;
				const late = new Promise<void>((resolve) => {
					release = resolve;
				});
				const note = "OLD-FORCED-DEFERRED-ADVICE";
				const oldPrompt = "OLD-FORCED-POLICY\nAPI_KEY=private-forced-policy";
				let currentPrompt = oldPrompt;
				const system: InlineExtension = {
					name: "reopen-forced-system",
					factory: (pi) => {
						pi.on("before_agent_start", (event) => {
							if (kind === "force option") {
								event.systemPromptOptions.forceSystemPrompt = currentPrompt;
								return;
							}
							return { systemPrompt: currentPrompt };
						});
					},
				};
				const advisor = createAdvisorProvider([
					{
						waitFor: late,
						content:
							ownership === "queued"
								? []
								: [
										{
											type: "toolCall",
											id: "late-before-close",
											name: "advise",
											arguments: { intent: "review", severity: "concern", note },
										},
									],
						stopReason: "toolUse",
					},
				]);
				const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
				config.defaultEnabled = true;
				config.model = `${advisor.model.provider}/${advisor.model.id}`;
				config.limits.minTurnsBetweenReviews = ownership === "queued" ? 2 : 0;
				config.limits.minIntervalMs = 0;
				let firstRuntime: AdvisorRuntime | undefined;
				let resumedRuntime: AdvisorRuntime | undefined;
				try {
					const manager = SessionManager.create(project, sessions);
					first = await createSessionHarness({
						cwd: project,
						sessionManager: manager,
						provider: createPrimaryProvider([
							{ content: [{ type: "text", text: "before close" }] },
							{ content: [{ type: "text", text: "queued before close" }] },
						]),
						advisorProvider: advisor,
						tools: [],
						mode: "rpc",
						extensions: [
							system,
							{
								name: "advisor-before-close",
								factory: createPiAdvisorExtension({
									config,
									hooks: {
										onRuntime: (value) => {
											firstRuntime = value;
										},
									},
								}),
							},
						],
					});
					await first.session.prompt("finish before the advice arrives");
					await expect.poll(() => advisor.activeRequests).toBe(1);
					if (ownership === "deferred") {
						release();
						await expect.poll(() => firstRuntime?.getStatus().deferredNotesPending).toBe(1);
						await firstRuntime?.shutdown();
					} else if (ownership === "queued") {
						release();
						await expect.poll(() => firstRuntime?.getStatus().reviewsCompleted).toBe(1);
						await first.session.prompt("queue the next review before closing");
						expect(firstRuntime?.getStatus().reviewRequests).toBe(1);
						await firstRuntime?.shutdown();
					} else {
						const stopping = firstRuntime?.shutdown();
						release();
						await stopping;
					}
					if (kind === "legacy without fingerprint") {
						const state = [...manager.getBranch()]
							.reverse()
							.find(
								(entry) =>
									entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
							);
						if (state?.type !== "custom") throw new Error("Expected saved state");
						// SAFETY: this is the state written by the runtime in this test.
						const legacy = structuredClone(state.data) as PersistedAdvisorRuntimeState;
						Reflect.deleteProperty(legacy, "effectiveSystemPromptHash");
						manager.appendCustomEntry(ADVISOR_RUNTIME_STATE_ENTRY_TYPE, legacy);
					}
					const file = manager.getSessionFile();
					if (file === undefined) throw new Error("Expected JSONL session");
					await first.dispose();
					first = undefined;
					currentPrompt = changed ? "NEW-FORCED-POLICY" : oldPrompt;
					const reopened = SessionManager.open(file, sessions, project);
					const primary = createPrimaryProvider([
						{ content: [{ type: "text", text: "after reopen" }] },
						{ content: [{ type: "text", text: "same prompt again" }] },
					]);
					const resumedAdvisor = createAdvisorProvider([
						{ content: [] },
						{ content: [] },
						{ content: [] },
					]);
					const resumedConfig = structuredClone(config);
					// Make queued work eligible now, before the first prepared primary prompt.
					resumedConfig.limits.minTurnsBetweenReviews = 0;
					resumed = await createSessionHarness({
						cwd: project,
						sessionManager: reopened,
						provider: primary,
						advisorProvider: resumedAdvisor,
						tools: [],
						mode: "rpc",
						extensions: [
							system,
							{
								name: "advisor-after-reopen",
								factory: createPiAdvisorExtension({
									config: resumedConfig,
									hooks: {
										onRuntime: (value) => {
											resumedRuntime = value;
										},
									},
								}),
							},
						],
					});
					expect(resumedRuntime?.getStatus().deferredNotesPending).toBe(
						ownership === "deferred" ? 1 : 0,
					);
					if (ownership === "review") {
						expect(resumedRuntime?.getStatus().restoredActiveReviewPending).toBe(true);
						expect(resumedAdvisor.requests).toHaveLength(0);
					}
					if (ownership === "queued") {
						expect(resumedRuntime?.getStatus().restoredQueuedReviewPending).toBe(true);
						expect(resumedAdvisor.requests).toHaveLength(0);
					}
					if (resumedRuntime === undefined) throw new Error("Expected resumed runtime");
					const ctx = runtimeInternals(resumedRuntime).hostContext;
					if (ctx === undefined) throw new Error("Expected host context");
					await resumedRuntime.enable(ctx, "session-command");
					expect(resumedAdvisor.requests).toHaveLength(0);
					const allowed = !changed && kind !== "legacy without fingerprint";
					const delivered = allowed && ownership === "deferred";
					const firstReviews = 1;
					await resumed.session.prompt("continue the reopened session");
					await expect.poll(() => resumedRuntime?.getStatus().reviewsCompleted).toBe(firstReviews);
					expect(JSON.stringify(primary.requests[0]?.context).includes(note)).toBe(delivered);
					if (ownership === "review") {
						expect(resumedRuntime.getStatus().restoredReplayCount).toBe(allowed ? 1 : 0);
						// The resumed user turn supersedes only a verified, started replay.
						expect(resumedRuntime.getStatus().reviewsSuperseded).toBe(allowed ? 1 : 0);
						expect(resumedAdvisor.requests).toHaveLength(allowed ? 2 : 1);
					}
					if (changed)
						expect(JSON.stringify(resumedAdvisor.requests)).not.toContain("OLD-FORCED-POLICY");
					expect(JSON.stringify(primary.requests[0]?.context)).toContain(
						changed ? "NEW-FORCED-POLICY" : "OLD-FORCED-POLICY",
					);
					expect(resumedRuntime.getStatus()).toMatchObject({
						notesDelivered: delivered ? 1 : 0,
						deferredNotesPending: 0,
						branchResets: allowed ? 0 : 1,
						failedReviews: 0,
					});
					await resumed.session.prompt("unchanged instructions must not replay");
					await expect
						.poll(() => resumedRuntime?.getStatus().reviewsCompleted)
						.toBe(firstReviews + 1);
					expect(resumedRuntime.getStatus()).toMatchObject({
						notesDelivered: delivered ? 1 : 0,
						branchResets: allowed ? 0 : 1,
					});
					if (ownership === "deferred") {
						const notes = reopened
							.getBranch()
							.filter(
								(entry) =>
									entry.type === "custom_message" && entry.customType === "pi-advisor-note",
							);
						expect(notes).toHaveLength(1);
						if (!allowed)
							expect(notes[0]).toMatchObject({
								content: [],
								display: false,
								details: { deliveryRevoked: true },
							});
					}
					expect(await readFile(file, "utf8")).not.toContain("private-forced-policy");
				} finally {
					release();
					await first?.dispose();
					await resumed?.dispose();
					await rm(root, { recursive: true, force: true });
				}
			}
		},
	);
});
