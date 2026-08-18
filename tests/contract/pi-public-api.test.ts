import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
	AgentSession,
	calculateContextTokens,
	createAgentSession,
	DefaultResourceLoader,
	estimateTokens,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createSessionHarness } from "../fixtures/session-harness.js";
import { createPrimaryProvider } from "../fixtures/scripted-provider.js";

type RequiredExtensionApi = Pick<
	ExtensionAPI,
	| "registerTool"
	| "registerCommand"
	| "registerFlag"
	| "getFlag"
	| "getActiveTools"
	| "getAllTools"
	| "setActiveTools"
	| "sendMessage"
	| "appendEntry"
	| "registerMessageRenderer"
	| "registerEntryRenderer"
>;

type RequiredExtensionContext = Pick<
	ExtensionContext,
	"isIdle" | "hasPendingMessages" | "getContextUsage" | "isProjectTrusted"
>;

export function compileCheckedExtensionSurface(
	pi: RequiredExtensionApi & ExtensionAPI,
	ctx: RequiredExtensionContext,
): void {
	void ctx.isIdle();
	void ctx.hasPendingMessages();
	void ctx.getContextUsage();
	void ctx.isProjectTrusted();
	pi.on("before_agent_start", (event) => {
		void event.systemPromptOptions.contextFiles;
	});
	pi.on("turn_end", (event) => {
		void event;
	});
	pi.on("message_end", (event) => {
		void event;
	});
	pi.on("agent_settled", (event) => {
		void event;
	});
	pi.on("session_start", (event) => {
		void event;
	});
	pi.on("session_shutdown", (event) => {
		void event;
	});
	pi.on("session_compact", (event) => {
		void event;
	});
	pi.on("session_tree", (event) => {
		void event;
	});
}

function expectMethod<T extends object>(target: T, name: keyof T & string): void {
	expect(target[name]).toBeTypeOf("function");
}

describe("supported Pi public API contract", () => {
	it("exports the required SDK constructors and methods", () => {
		expect(createAgentSession).toBeTypeOf("function");
		expect(calculateContextTokens).toBeTypeOf("function");
		expect(estimateContextTokens).toBeTypeOf("function");
		expect(estimateTokens).toBeTypeOf("function");
		expect(DefaultResourceLoader).toBeTypeOf("function");
		expect(InMemoryCredentialStore).toBeTypeOf("function");
		expectMethod(ModelRuntime, "create");
		expectMethod(ModelRuntime.prototype, "setRuntimeApiKey");
		expectMethod(ModelRuntime.prototype, "registerProvider");
		expectMethod(ModelRuntime.prototype, "registerNativeProvider");
		expectMethod(ModelRuntime.prototype, "getProvider");
		expectMethod(ModelRuntime.prototype, "getAuth");
		expectMethod(SessionManager, "inMemory");
		expectMethod(SessionManager.prototype, "getBranch");
		expectMethod(SessionManager.prototype, "getEntries");
		expectMethod(SessionManager.prototype, "buildContextEntries");
		expectMethod(AgentSession.prototype, "prompt");
		expectMethod(AgentSession.prototype, "subscribe");
		expectMethod(AgentSession.prototype, "compact");
		expectMethod(AgentSession.prototype, "abortCompaction");
		expectMethod(AgentSession.prototype, "abort");
		expectMethod(AgentSession.prototype, "dispose");
		expectMethod(ModelRegistry.prototype, "find");
		expectMethod(ModelRegistry.prototype, "getAvailable");
		expectMethod(ModelRegistry.prototype, "getRegisteredProviderIds");
		expectMethod(ModelRegistry.prototype, "getRegisteredProviderConfig");
		expectMethod(ModelRegistry.prototype, "getRegisteredNativeProvider");
		expectMethod(ModelRegistry.prototype, "getProviderAuthStatus");
		expectMethod(ModelRegistry.prototype, "getApiKeyForProvider");
		expectMethod(ModelRegistry.prototype, "getApiKeyAndHeaders");
	});

	it("reports the complete configured built-in tool inventory", async () => {
		const harness = await createSessionHarness({ provider: createPrimaryProvider([]) });
		try {
			expect(
				harness.session
					.getAllTools()
					.map((tool) => tool.name)
					.sort(),
			).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
			expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		} finally {
			await harness.dispose();
		}
	});

	it("keeps custom entries outside model context while retaining them in branch state", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "visible", timestamp: 1 });
		const customId = manager.appendCustomEntry("pi-advisor-state", { epoch: 7 });
		const branch = manager.getBranch();
		const context = manager.buildSessionContext();

		expect(branch.some((entry) => entry.id === customId && entry.type === "custom")).toBe(true);
		expect(JSON.stringify(context.messages)).not.toContain("pi-advisor-state");
		expect(JSON.stringify(context.messages)).not.toContain("epoch");
	});
});
