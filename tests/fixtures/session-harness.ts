import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { setRuntimeApiKeyWithoutNetwork } from "../../src/compatibility/model-runtime.js";
import { registerScriptedProvider, type ScriptedProvider } from "./scripted-provider.js";

export interface SessionHarnessOptions {
	provider: ScriptedProvider;
	advisorProvider?: ScriptedProvider;
	extensions?: InlineExtension[];
	customTools?: ToolDefinition[];
	sessionManager?: SessionManager;
	tools?: string[];
	mode?: "tui" | "rpc" | "json" | "print";
	setup?(cwd: string, agentDir: string): Promise<void> | void;
	beforeBind?(modelRuntime: ModelRuntime): Promise<void> | void;
}

export interface SessionHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	modelRuntime: ModelRuntime;
	cwd: string;
	agentDir: string;
	dispose(): Promise<void>;
}

export async function createSessionHarness(
	options: SessionHarnessOptions,
): Promise<SessionHarness> {
	const root = await mkdtemp(join(tmpdir(), "pi-advisor-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	let session: AgentSession | undefined;

	try {
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await options.setup?.(cwd, agentDir);

		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		registerScriptedProvider(modelRuntime, options.provider);
		await setRuntimeApiKeyWithoutNetwork(
			modelRuntime,
			options.provider.model.provider,
			"scripted-key",
		);
		if (options.advisorProvider !== undefined) {
			registerScriptedProvider(modelRuntime, options.advisorProvider);
			await setRuntimeApiKeyWithoutNetwork(
				modelRuntime,
				options.advisorProvider.model.provider,
				"scripted-advisor-key",
			);
		}
		await options.beforeBind?.(modelRuntime);

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			...(options.extensions === undefined ? {} : { extensionFactories: options.extensions }),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "Scripted Pi Advisor test session.",
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();

		const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: options.provider.model,
			thinkingLevel: "off",
			resourceLoader,
			sessionManager,
			settingsManager,
			...(options.customTools === undefined ? {} : { customTools: options.customTools }),
			...(options.tools === undefined ? {} : { tools: options.tools }),
		}));
		await session.bindExtensions({ mode: options.mode ?? "json" });

		let disposed = false;
		return {
			session,
			sessionManager,
			modelRuntime,
			cwd,
			agentDir,
			async dispose() {
				if (disposed) return;
				disposed = true;
				session?.dispose();
				await rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		session?.dispose();
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
