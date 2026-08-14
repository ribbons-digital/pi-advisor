import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { setRuntimeApiKeyWithoutNetwork } from "../../src/compatibility/model-runtime.js";
import {
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	type AdvisorRuntime,
} from "../../src/index.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	registerScriptedProvider,
} from "../fixtures/scripted-provider.js";

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

function acceptedAdvice(note: string) {
	return {
		content: [
			{
				type: "toolCall" as const,
				id: "replacement-advice",
				name: "advise",
				arguments: { note, severity: "concern", intent: "review" },
			},
		],
		stopReason: "toolUse" as const,
	};
}

describe("Pi 0.81.1 session replacement spike", () => {
	it("shuts down the old extension instance before rebinding a replacement session", async () => {
		const lifecycle: string[] = [];
		let root: string | undefined;
		let runtime: AgentSessionRuntime | undefined;

		try {
			root = await mkdtemp(join(tmpdir(), "pi-advisor-runtime-"));
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			await mkdir(cwd, { recursive: true });
			await mkdir(agentDir, { recursive: true });

			let instanceCount = 0;
			const extension: InlineExtension = {
				name: "replacement-spike",
				factory: (pi) => {
					const instance = ++instanceCount;
					pi.on("session_start", (event) => {
						lifecycle.push(`start:${String(instance)}:${event.reason}`);
					});
					pi.on("session_shutdown", (event) => {
						lifecycle.push(`shutdown:${String(instance)}:${event.reason}`);
					});
				},
			};
			const provider = createPrimaryProvider([
				{ content: [{ type: "text", text: "old session" }] },
				{ content: [{ type: "text", text: "new session" }] },
			]);
			const modelRuntime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			registerScriptedProvider(modelRuntime, provider);
			await setRuntimeApiKeyWithoutNetwork(modelRuntime, provider.model.provider, "scripted-key");
			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			});
			const createRuntime: CreateAgentSessionRuntimeFactory = async ({
				cwd: runtimeCwd,
				sessionManager,
				sessionStartEvent,
			}) => {
				const services = await createAgentSessionServices({
					cwd: runtimeCwd,
					agentDir,
					modelRuntime,
					settingsManager,
					resourceLoaderOptions: {
						extensionFactories: [extension],
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						systemPromptOverride: () => "Replacement spike.",
						appendSystemPromptOverride: () => [],
					},
				});
				return {
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
						model: provider.model,
						thinkingLevel: "off",
						tools: [],
					})),
					services,
					diagnostics: services.diagnostics,
				};
			};

			runtime = await createAgentSessionRuntime(createRuntime, {
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
			});
			runtime.setRebindSession((session) => session.bindExtensions({ mode: "json" }));
			await runtime.session.bindExtensions({ mode: "json" });

			const oldSession = runtime.session;
			const oldSessionId = oldSession.sessionId;
			await oldSession.prompt("old prompt");

			let replacementSessionId = "";
			const replacement = await runtime.newSession({
				withSession: async (ctx) => {
					replacementSessionId = ctx.sessionManager.getSessionId();
					await ctx.sendUserMessage("new prompt");
				},
			});

			expect(replacement.cancelled).toBe(false);
			expect(replacementSessionId).not.toBe(oldSessionId);
			expect(runtime.session.sessionId).toBe(replacementSessionId);
			expect(lifecycle.slice(0, 3)).toEqual(["start:1:startup", "shutdown:1:new", "start:2:new"]);
			expect(runtime.session).not.toBe(oldSession);
			expect(
				runtime.session.messages.some((message) => JSON.stringify(message).includes("old prompt")),
			).toBe(false);
		} finally {
			if (runtime !== undefined) await runtime.dispose();
			if (root !== undefined) await rm(root, { recursive: true, force: true });
		}

		expect(lifecycle).toEqual([
			"start:1:startup",
			"shutdown:1:new",
			"start:2:new",
			"shutdown:2:quit",
		]);
	});

	it("does not deliver old-session deferred advice after runtime replacement", async () => {
		const oldNote = "Never carry this queued old-session advice into the replacement session.";
		let root: string | undefined;
		let runtime: AgentSessionRuntime | undefined;
		const advisorRuntimes: AdvisorRuntime[] = [];

		try {
			root = await mkdtemp(join(tmpdir(), "pi-advisor-replacement-isolation-"));
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			await mkdir(cwd, { recursive: true });
			await mkdir(agentDir, { recursive: true });

			const primary = createPrimaryProvider([
				{ content: [{ type: "text", text: "old session answer" }] },
				{ content: [{ type: "text", text: "replacement session answer" }] },
			]);
			const advisor = createAdvisorProvider([
				{ ...acceptedAdvice(oldNote), delayMs: 25 },
				{ content: [] },
			]);
			const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
			config.defaultEnabled = true;
			config.model = `${advisor.model.provider}/${advisor.model.id}`;
			const advisorExtension: InlineExtension = {
				name: "replacement-advisor",
				factory: createPiAdvisorExtension({
					config,
					hooks: { onRuntime: (value) => advisorRuntimes.push(value) },
				}),
			};

			const modelRuntime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			registerScriptedProvider(modelRuntime, primary);
			registerScriptedProvider(modelRuntime, advisor);
			await setRuntimeApiKeyWithoutNetwork(modelRuntime, primary.model.provider, "scripted-key");
			await setRuntimeApiKeyWithoutNetwork(
				modelRuntime,
				advisor.model.provider,
				"scripted-advisor-key",
			);
			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			});
			const createRuntime: CreateAgentSessionRuntimeFactory = async ({
				cwd: runtimeCwd,
				sessionManager,
				sessionStartEvent,
			}) => {
				const services = await createAgentSessionServices({
					cwd: runtimeCwd,
					agentDir,
					modelRuntime,
					settingsManager,
					resourceLoaderOptions: {
						extensionFactories: [advisorExtension],
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						systemPromptOverride: () => "Replacement isolation test.",
						appendSystemPromptOverride: () => [],
					},
				});
				return {
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
						model: primary.model,
						thinkingLevel: "off",
						tools: [],
					})),
					services,
					diagnostics: services.diagnostics,
				};
			};

			runtime = await createAgentSessionRuntime(createRuntime, {
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
			});
			runtime.setRebindSession((session) => session.bindExtensions({ mode: "rpc" }));
			await runtime.session.bindExtensions({ mode: "rpc" });
			await runtime.session.prompt("queue advice in the old session");
			await waitFor(() => advisorRuntimes[0]?.getStatus().deferredNotesPending === 1);

			const oldSessionId = runtime.session.sessionId;
			let replacementSessionId = "";
			const replacement = await runtime.newSession({
				withSession: async (ctx) => {
					replacementSessionId = ctx.sessionManager.getSessionId();
					await ctx.sendUserMessage("start the replacement session");
				},
			});

			expect(replacement.cancelled).toBe(false);
			expect(replacementSessionId).not.toBe(oldSessionId);
			expect(advisorRuntimes).toHaveLength(2);
			expect(advisorRuntimes[1]?.getStatus()).toMatchObject({
				deferredNotesPending: 0,
				notesDelivered: 0,
			});
			expect(JSON.stringify(primary.requests[1]?.context)).not.toContain(oldNote);
			expect(JSON.stringify(runtime.session.messages)).not.toContain(oldNote);
		} finally {
			if (runtime !== undefined) await runtime.dispose();
			if (root !== undefined) await rm(root, { recursive: true, force: true });
		}
	});
});
