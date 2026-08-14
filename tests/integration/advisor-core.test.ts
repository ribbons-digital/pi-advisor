import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";

import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	createPiAdvisorExtension,
	createProtectedAdvisorTools,
	DEFAULT_ADVISOR_CONFIG,
	formatAdvisorFooterStatus,
	ProtectedPathPolicy,
	shouldAnimateAdvisorFooter,
	type AdvisorConfig,
	type AdvisorRuntime,
	type AdvisorRuntimeStatus,
} from "../../src/index.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

function configFor(
	provider: ScriptedProvider,
	overrides: Partial<AdvisorConfig> = {},
): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	return {
		...config,
		...overrides,
		defaultEnabled: overrides.defaultEnabled ?? true,
		model: `${provider.model.provider}/${provider.model.id}`,
	};
}

function advisorExtension(
	config: AdvisorConfig,
	onRuntime: (runtime: AdvisorRuntime) => void,
	onStatus?: (status: AdvisorRuntimeStatus) => void,
): InlineExtension {
	return {
		name: "pi-advisor-under-test",
		factory: createPiAdvisorExtension({
			config,
			hooks: {
				onRuntime,
				...(onStatus === undefined ? {} : { onStatus }),
			},
		}),
	};
}

function createBarrier(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

function toolText(
	result:
		| Awaited<ReturnType<ReturnType<typeof createProtectedAdvisorTools>[number]["execute"]>>
		| undefined,
): string {
	if (result === undefined) return "";
	return result.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

describe.sequential("Slice 1 automatic Advisor core", () => {
	it("reviews a normal Executor turn without an Executor tool call and records silence", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "primary answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ content: [{ type: "text", text: "private silent review" }] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review this ordinary turn");
			await waitFor(
				() => advisor.requests.length === 1 && runtime?.getStatus().reviewsCompleted === 1,
			);
			expect(advisor.requests[0]?.context.messages).toEqual(
				expect.arrayContaining([expect.objectContaining({ role: "user" })]),
			);
			expect(advisor.requests[0]?.options?.reasoning).toBe("high");
			expect(JSON.stringify(harness.session.messages)).not.toContain("private silent review");
			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				reviewsCompleted: 1,
				silentReviews: 1,
				failedReviews: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("publishes reviewing status while a nested review is in flight", async () => {
		const advisorBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "primary answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				waitFor: advisorBarrier.promise,
				content: [{ type: "text", text: "private silent review" }],
			},
		]);
		let runtime: AdvisorRuntime | undefined;
		const published: AdvisorRuntimeStatus[] = [];
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				advisorExtension(
					configFor(advisor),
					(value) => (runtime = value),
					(status) => {
						published.push(status);
					},
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			const turn = harness.session.prompt("review this ordinary turn");
			await waitFor(() => advisor.activeRequests === 1);
			const inFlight = published.find((status) => status.reviewing);
			if (inFlight === undefined)
				throw new Error("Expected reviewing status while Advisor is in flight");
			expect(inFlight).toMatchObject({
				enabled: true,
				active: true,
				paused: false,
				reviewing: true,
			});
			expect(formatAdvisorFooterStatus(inFlight)).toMatch(/^Advisor reviewing(?: \(.+\))?$/u);
			expect(shouldAnimateAdvisorFooter(inFlight, "tui")).toBe(true);
			expect(shouldAnimateAdvisorFooter(inFlight, "rpc")).toBe(false);
			advisorBarrier.release();
			await turn;
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus().reviewing).toBe(false);
		} finally {
			advisorBarrier.release();
			await harness.dispose();
		}
	});

	it("reports the configured model while Advisor is disabled", async () => {
		const primary = createPrimaryProvider([]);
		let runtime: AdvisorRuntime | undefined;
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.model = "configured-provider/configured-model";
		const harness = await createSessionHarness({
			provider: primary,
			extensions: [advisorExtension(config, (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			expect(runtime?.getStatus()).toMatchObject({
				enabled: false,
				active: false,
				model: "configured-provider/configured-model",
			});
		} finally {
			await harness.dispose();
		}
	});

	it("keeps a missing configured model inactive without constructing a fallback session", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		let runtime: AdvisorRuntime | undefined;
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.defaultEnabled = true;
		config.model = "missing-provider/missing-model";
		const harness = await createSessionHarness({
			provider: primary,
			extensions: [advisorExtension(config, (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			expect(runtime?.getStatus()).toMatchObject({ enabled: true, active: false });
			expect(runtime?.getStatus().inactiveReason).toContain("No fallback was selected");
			expect(runtime?.getStatus().nestedExtensionCount).toBeUndefined();
			await harness.session.prompt("continue without Advisor");
			expect(primary.requests).toHaveLength(1);
		} finally {
			await harness.dispose();
		}
	});

	it("fails inactive without a nested request when provider parity cannot be proven", async () => {
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(configFor(advisor), (value) => (runtime = value))],
			beforeBind: (modelRuntime) => {
				const original = modelRuntime.getProviderAuthStatus.bind(modelRuntime);
				modelRuntime.getProviderAuthStatus = (providerId) => {
					const status = original(providerId);
					return providerId === advisor.model.provider
						? { ...status, configured: true, source: "stored" }
						: status;
				};
			},
			tools: [],
			mode: "rpc",
		});
		try {
			expect(runtime?.getStatus()).toMatchObject({ enabled: true, active: false });
			expect(runtime?.getStatus().inactiveReason).toContain(
				"ModelRuntime parity mismatch: authentication source",
			);
			expect(runtime?.getStatus().inactiveReason).toContain("No fallback was selected");
			expect(runtime?.getStatus().nestedExtensionCount).toBeUndefined();
			expect(advisor.requests).toHaveLength(0);
		} finally {
			await harness.dispose();
		}
	});

	it("disables recursive resources and exposes only read-only tools plus advise", async () => {
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			expect(runtime?.getStatus().nestedExtensionCount).toBe(0);
			expect(runtime?.getStatus().nestedActiveTools.sort()).toEqual([
				"advise",
				"find",
				"grep",
				"ls",
				"read",
			]);
			expect(runtime?.getStatus().nestedActiveTools).not.toEqual(
				expect.arrayContaining(["bash", "edit", "write"]),
			);
		} finally {
			await harness.dispose();
		}
	});

	it("coalesces rapid Executor turns without concurrent Advisor prompts", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
			{ content: [{ type: "text", text: "third answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ delayMs: 100, content: [{ type: "text", text: "silent first" }] },
			{ content: [{ type: "text", text: "silent coalesced" }] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first user turn");
			await harness.session.prompt("second user turn");
			await harness.session.prompt("third user turn");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(advisor.maxConcurrentRequests).toBe(1);
			expect(advisor.requests).toHaveLength(2);
			const coalesced = JSON.stringify(advisor.requests[1]?.context);
			expect(coalesced).toContain("second user turn");
			expect(coalesced).toContain("third user turn");
			expect(runtime?.getStatus().backlog).toBe(false);
		} finally {
			await harness.dispose();
		}
	});

	it("invalidates delayed advice after an obvious branch mismatch and resets nested context", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "branch answer" }] }]);
		const advisor = createAdvisorProvider([
			{
				delayMs: 100,
				content: [
					{
						type: "toolCall",
						id: "advise-old-branch",
						name: "advise",
						arguments: { note: "This belongs only to the abandoned branch." },
					},
				],
				stopReason: "toolUse",
			},
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("create branch to abandon");
			await waitFor(() => advisor.activeRequests === 1);
			const firstEntry = harness.sessionManager.getBranch()[0];
			if (firstEntry === undefined) throw new Error("Expected a branch entry");
			harness.sessionManager.branch(firstEntry.id);
			await waitFor(() => runtime?.getStatus().branchResets === 1);
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(
				"This belongs only to the abandoned branch.",
			);
			expect(runtime?.getStatus().notesDelivered).toBe(0);
			expect(runtime?.getNestedMessageCount()).toBe(0);
		} finally {
			await harness.dispose();
		}
	});

	it("applies the User default only to TUI and RPC while allowing explicit JSON session activation", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "json",
		});
		try {
			expect(runtime?.getStatus()).toMatchObject({ enabled: false, active: false });
			await harness.session.prompt("/advisor on");
			expect(runtime?.getStatus()).toMatchObject({ enabled: true, active: true });
			await harness.session.prompt("review after explicit JSON activation");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(advisor.requests).toHaveLength(1);
		} finally {
			await harness.dispose();
		}
	});

	it("blocks protected paths across read, grep, find, and ls, including symlink aliases", async () => {
		const primary = createPrimaryProvider([]);
		const harness = await createSessionHarness({
			provider: primary,
			tools: [],
			setup: async (cwd) => {
				await mkdir(join(cwd, "safe"), { recursive: true });
				await mkdir(join(cwd, "protected-real"), { recursive: true });
				await writeFile(join(cwd, ".env"), "TOKEN=super-secret-value\nneedle hidden");
				await writeFile(join(cwd, "visible-root.txt"), "visible root entry");
				await writeFile(join(cwd, "safe", "visible.txt"), "needle visible");
				await writeFile(join(cwd, "safe", "context.txt"), "before\nneedle context\nafter");
				await writeFile(join(cwd, "safe", "large.txt"), `needle ${"x".repeat(1_000_001)}`);
				await writeFile(join(cwd, "protected-real", "hidden.txt"), "additional-secret-value");
				await symlink(join(cwd, ".env"), join(cwd, "safe", "alias.txt"));
				await symlink(join(cwd, "protected-real"), join(cwd, "protected-alias"));
			},
		});
		try {
			const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
			config.security.additionalProtectedPaths = ["protected-alias"];
			const rootPolicy = new ProtectedPathPolicy(harness.cwd, {
				additionalProtectedPaths: [parse(harness.cwd).root],
				protectedPathExceptions: [],
			});
			expect(await rootPolicy.allows("safe/visible.txt")).toBe(false);
			const tools = createProtectedAdvisorTools(harness.cwd, config);
			const ctx = {} as ExtensionContext;
			const execute = async (name: string, args: Record<string, unknown>) => {
				const tool = tools.find((candidate) => candidate.name === name);
				if (tool === undefined) throw new Error(`Missing ${name} tool`);
				return tool.execute(`call-${name}`, args, undefined, undefined, ctx);
			};
			const read = await execute("read", { path: ".env" });
			const grep = await execute("grep", {
				path: ".",
				pattern: "needle",
				literal: true,
				context: 1,
			});
			const find = await execute("find", { path: ".", pattern: "*" });
			const ls = await execute("ls", { path: "." });
			const alias = await execute("read", { path: "safe/alias.txt" });
			const additionalTarget = await execute("read", { path: "protected-real/hidden.txt" });
			for (const result of [read, grep, find, ls, alias, additionalTarget]) {
				const output = toolText(result);
				expect(output).not.toContain("super-secret-value");
				expect(output).not.toContain(".env");
				expect(output).not.toContain("alias.txt");
				expect(output).not.toContain("additional-secret-value");
				expect(output).not.toContain("protected-real");
			}
			expect(toolText(grep)).toContain("safe/visible.txt");
			expect(toolText(grep)).not.toContain("safe/large.txt");
			expect(toolText(grep)).not.toContain(harness.cwd);
			const invalidPattern = await execute("grep", { path: ".", pattern: "(" });
			expect(toolText(invalidPattern)).toMatch(
				/Invalid or unsupported grep pattern|Regex grep is unavailable/,
			);
			const boundedLs = await execute("ls", { path: ".", limit: 1 });
			expect((boundedLs.details as Record<string, unknown>).entryLimitReached).toBe(true);

			config.security.protectedPathExceptions = [".env"];
			const exceptionRead = createProtectedAdvisorTools(harness.cwd, config).find(
				(tool) => tool.name === "read",
			);
			if (exceptionRead === undefined) throw new Error("Missing exception read tool");
			const exceptionResult = await exceptionRead.execute(
				"exception-read",
				{ path: ".env" },
				undefined,
				undefined,
				ctx,
			);
			expect(toolText(exceptionResult)).toContain("super-secret-value");
		} finally {
			await harness.dispose();
		}
	});
});
