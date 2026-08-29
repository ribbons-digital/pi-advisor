import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	configureAdvisor,
	DEFAULT_ADVISOR_CONFIG,
	hasAdvisorCommandCollision,
	HARD_LIMITS,
	loadAdvisorConfiguration,
	MAX_WATCHDOG_MARKDOWN_BYTES,
	MAX_WATCHDOG_YAML_BYTES,
	mergeProjectConfiguration,
	normalizeAdvisorConfig,
	type AdvisorConfig,
	type AdvisorRuntime,
	pickAdvisorInteractiveConfiguration,
	pickAdvisorModelAndEffort,
	pickAdvisorTools,
	publishConfigurationWarnings,
	saveUserConfigurationAtomic,
	serializeUserConfiguration,
} from "../../src/index.js";

const roots: string[] = [];

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-advisor-watchdog-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	return { root, agentDir, cwd };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type CommandUiStub = Partial<{
	select: ExtensionCommandContext["ui"]["select"];
	custom: ExtensionCommandContext["ui"]["custom"];
	editor: ExtensionCommandContext["ui"]["editor"];
	confirm: ExtensionCommandContext["ui"]["confirm"];
	notify: ExtensionCommandContext["ui"]["notify"];
}>;

interface CommandContextStub {
	hasUI: boolean;
	cwd?: string;
	isProjectTrusted?: () => boolean;
	modelRegistry?: { getAvailable: () => readonly unknown[] };
	ui: CommandUiStub;
}

function commandUi(ui: CommandUiStub): ExtensionCommandContext["ui"] {
	// SAFETY: tests provide only the UI methods exercised by each command path.
	return ui as ExtensionCommandContext["ui"];
}

function commandContext(ctx: CommandContextStub): ExtensionCommandContext {
	// SAFETY: tests provide only the command-context fields exercised by the called function.
	return ctx as ExtensionCommandContext;
}

function configureRuntime(
	applyConfiguration: AdvisorRuntime["applyConfiguration"],
): AdvisorRuntime {
	// SAFETY: configureAdvisor exercises only applyConfiguration on this runtime test double.
	return { applyConfiguration } as AdvisorRuntime;
}

function availableModel(
	provider: string,
	id: string,
	overrides: Partial<Model<Api>> = {},
): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
		...overrides,
	};
}

describe("WATCHDOG configuration", () => {
	it("detects Pi-assigned coexistence command suffixes without false positives", () => {
		expect(hasAdvisorCommandCollision([{ name: "advisor:1" }, { name: "advisor:2" }])).toBe(true);
		expect(hasAdvisorCommandCollision([{ name: "advisor" }, { name: "other" }])).toBe(false);
	});

	it("derives normal and opt-in reasoning levels from the selected Pi model", async () => {
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("alpha/model-a")
			.mockResolvedValueOnce("max");
		const result = await pickAdvisorModelAndEffort({
			mode: "rpc",
			// SAFETY: this picker test double implements the only registry method used here.
			modelRegistry: {
				getAvailable: () => [
					availableModel("zeta", "model-z"),
					availableModel("alpha", "model-a", {
						thinkingLevelMap: { minimal: null, high: null, xhigh: "xhigh", max: "max" },
					}),
				],
			} as ExtensionCommandContext["modelRegistry"],
			ui: commandUi({ select, notify: vi.fn() }),
		});
		expect(result).toEqual({ model: "alpha/model-a", effort: "max" });
		expect(select.mock.calls[0]?.[1]).toEqual(["alpha/model-a", "zeta/model-z"]);
		expect(select.mock.calls[1]?.[1]).toEqual(["off", "low", "medium", "xhigh", "max"]);
	});

	it("offers only off for a non-reasoning model", async () => {
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("alpha/plain")
			.mockResolvedValueOnce("off");
		const result = await pickAdvisorModelAndEffort({
			mode: "rpc",
			// SAFETY: this picker test double implements the only registry method used here.
			modelRegistry: {
				getAvailable: () => [availableModel("alpha", "plain", { reasoning: false })],
			} as ExtensionCommandContext["modelRegistry"],
			ui: commandUi({ select, notify: vi.fn() }),
		});
		expect(result).toEqual({ model: "alpha/plain", effort: "off" });
		expect(select.mock.calls[1]?.[1]).toEqual(["off"]);
	});

	it("prioritizes a supported current effort and explains independent Executor reasoning", async () => {
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("alpha/model-a")
			.mockResolvedValueOnce("high");
		const notify = vi.fn();
		const result = await pickAdvisorModelAndEffort(
			{
				mode: "rpc",
				thinkingLevel: "low",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: {
					getAvailable: () => [availableModel("alpha", "model-a")],
				} as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({ select, notify }),
			},
			{ model: "other/old", effort: "high" },
		);
		expect(result).toEqual({ model: "alpha/model-a", effort: "high" });
		expect(select.mock.calls[1]?.[1]).toEqual(["high", "off", "minimal", "low", "medium"]);
		expect(select.mock.calls[1]?.[0]).toContain("current Executor reasoning: low");
		expect(select.mock.calls[1]?.[0]).toContain("Advisor selection is independent");
		expect(notify).not.toHaveBeenCalled();
	});

	it("warns when current effort is unsupported and does not offer it", async () => {
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("alpha/model-a")
			.mockResolvedValueOnce("medium");
		const notify = vi.fn();
		await pickAdvisorModelAndEffort(
			{
				mode: "rpc",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: {
					getAvailable: () => [
						availableModel("alpha", "model-a", { thinkingLevelMap: { high: null } }),
					],
				} as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({ select, notify }),
			},
			{ model: "other/old", effort: "high" },
		);
		expect(select.mock.calls[1]?.[1]).toEqual(["off", "minimal", "low", "medium"]);
		expect(select.mock.calls[1]?.[0]).toBe("Select Advisor reasoning level");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("not supported"), "warning");
	});

	it("preserves TUI search and cancellation at both picker steps", async () => {
		const model = availableModel("alpha", "model-a", { name: "Alpha" });
		const custom = vi.fn().mockResolvedValue("alpha/model-a");
		const select = vi.fn().mockResolvedValue("high");
		const result = await pickAdvisorModelAndEffort(
			{
				mode: "tui",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: { getAvailable: () => [model] } as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({ custom, select, notify: vi.fn() }),
			},
			{ model: "alpha/model-a", effort: "high" },
		);
		expect(result).toEqual({ model: "alpha/model-a", effort: "high" });
		expect(custom).toHaveBeenCalledOnce();
		expect(select).toHaveBeenCalledOnce();

		const cancelModel = vi.fn().mockResolvedValue(undefined);
		expect(
			await pickAdvisorModelAndEffort({
				mode: "tui",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: { getAvailable: () => [model] } as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({
					custom: cancelModel,
					select,
					notify: vi.fn(),
				}),
			}),
		).toBeUndefined();
		const cancelEffort = vi
			.fn()
			.mockResolvedValueOnce("alpha/model-a")
			.mockResolvedValueOnce(undefined);
		expect(
			await pickAdvisorModelAndEffort({
				mode: "rpc",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: { getAvailable: () => [model] } as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({ select: cancelEffort, notify: vi.fn() }),
			}),
		).toBeUndefined();
	});

	it("selects only approved read-only tools", async () => {
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("[x] grep - search file contents")
			.mockResolvedValueOnce("[ ] ls - list directories")
			.mockResolvedValueOnce("Done - use 3 read-only tools");
		const tools = await pickAdvisorTools({ ui: commandUi({ select }) }, ["read", "grep", "find"]);
		expect(tools).toEqual(["read", "find", "ls"]);
		expect(
			select.mock.calls.flatMap((call) => call[1]).some((choice) => choice.includes("bash")),
		).toBe(false);
	});

	it("opens the RPC instructions editor only after Add is selected", async () => {
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("Model and reasoning: not configured (high)")
			.mockResolvedValueOnce("fixture/advisor")
			.mockResolvedValueOnce("high")
			.mockResolvedValueOnce("Read-only tools: read, grep, find, ls")
			.mockResolvedValueOnce("Done - use 4 read-only tools")
			.mockResolvedValueOnce("Instructions: none")
			.mockResolvedValueOnce("Add custom instructions")
			.mockResolvedValueOnce("Apply and save configuration");
		const editor = vi.fn().mockResolvedValue("Focus on migration safety.");
		const configured = await pickAdvisorInteractiveConfiguration(
			{
				mode: "rpc",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: {
					getAvailable: () => [{ provider: "fixture", id: "advisor" }],
				} as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({ select, editor, notify: vi.fn() }),
			},
			structuredClone(DEFAULT_ADVISOR_CONFIG),
		);
		expect(configured).toMatchObject({
			model: "fixture/advisor",
			effort: "high",
			tools: ["read", "grep", "find", "ls"],
			instructions: "Focus on migration safety.",
		});
		expect(select.mock.calls).toContainEqual([
			"Choose optional User Advisor instructions for this configuration",
			["Continue without custom instructions", "Add custom instructions"],
		]);
		expect(select).toHaveBeenLastCalledWith(
			"Configure Advisor (edit one section, then Apply)",
			expect.arrayContaining(["Apply and save configuration", "Cancel"]),
		);
		expect(editor).toHaveBeenCalledWith(expect.stringContaining("Configuration step: add"), "");
	});

	it("normalizes whitespace-only editor input to no instructions", async () => {
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("Model and reasoning: not configured (high)")
			.mockResolvedValueOnce("fixture/advisor")
			.mockResolvedValueOnce("high")
			.mockResolvedValueOnce("Read-only tools: read, grep, find, ls")
			.mockResolvedValueOnce("Done - use 4 read-only tools")
			.mockResolvedValueOnce("Instructions: none")
			.mockResolvedValueOnce("Add custom instructions")
			.mockResolvedValueOnce("Apply and save configuration");
		const configured = await pickAdvisorInteractiveConfiguration(
			{
				mode: "rpc",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: {
					getAvailable: () => [{ provider: "fixture", id: "advisor" }],
				} as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({
					select,
					editor: vi.fn().mockResolvedValue(" \n\t "),
					notify: vi.fn(),
				}),
			},
			structuredClone(DEFAULT_ADVISOR_CONFIG),
		);
		expect(configured?.instructions).toBe("");
	});

	it("lets the TUI continue without instructions without opening an editor", async () => {
		const custom = vi.fn().mockResolvedValue("fixture/advisor");
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("Model and reasoning: not configured (high)")
			.mockResolvedValueOnce("high")
			.mockResolvedValueOnce("Read-only tools: read, grep, find, ls")
			.mockResolvedValueOnce("Done - use 4 read-only tools")
			.mockResolvedValueOnce("Instructions: none")
			.mockResolvedValueOnce("Continue without custom instructions")
			.mockResolvedValueOnce("Apply and save configuration");
		const editor = vi.fn();
		const configured = await pickAdvisorInteractiveConfiguration(
			{
				mode: "tui",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: {
					getAvailable: () => [{ provider: "fixture", id: "advisor" }],
				} as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({ custom, select, editor, notify: vi.fn() }),
			},
			structuredClone(DEFAULT_ADVISOR_CONFIG),
		);
		expect(configured?.instructions).toBe("");
		expect(editor).not.toHaveBeenCalled();
		expect(select.mock.calls).toContainEqual([
			"Choose optional User Advisor instructions for this configuration",
			["Continue without custom instructions", "Add custom instructions"],
		]);
	});

	it("offers deliberate keep, edit, and clear choices for existing instructions", async () => {
		const cases = [
			{ choice: "Keep current instructions", expected: "Current focus.", opensEditor: false },
			{ choice: "Edit instructions", expected: "Updated focus.", opensEditor: true },
			{ choice: "Clear instructions", expected: "", opensEditor: false },
		];
		for (const testCase of cases) {
			const select = vi
				.fn<ExtensionCommandContext["ui"]["select"]>()
				.mockResolvedValueOnce("Model and reasoning: not configured (high)")
				.mockResolvedValueOnce("fixture/advisor")
				.mockResolvedValueOnce("high")
				.mockResolvedValueOnce("Read-only tools: read, grep, find, ls")
				.mockResolvedValueOnce("Done - use 4 read-only tools")
				.mockResolvedValueOnce("Instructions: set")
				.mockResolvedValueOnce(testCase.choice)
				.mockResolvedValueOnce("Apply and save configuration");
			const editor = vi.fn().mockResolvedValue("Updated focus.");
			const current = structuredClone(DEFAULT_ADVISOR_CONFIG);
			current.instructions = "Current focus.";
			const configured = await pickAdvisorInteractiveConfiguration(
				{
					mode: "rpc",
					// SAFETY: this picker test double implements the only registry method used here.
					modelRegistry: {
						getAvailable: () => [{ provider: "fixture", id: "advisor" }],
					} as ExtensionCommandContext["modelRegistry"],
					ui: commandUi({ select, editor, notify: vi.fn() }),
				},
				current,
			);
			expect(configured?.instructions).toBe(testCase.expected);
			expect(select.mock.calls).toContainEqual([
				"Choose optional User Advisor instructions for this configuration",
				["Keep current instructions", "Edit instructions", "Clear instructions"],
			]);
			if (testCase.opensEditor) {
				expect(editor).toHaveBeenCalledWith(
					expect.stringContaining("Configuration step: edit"),
					"Current focus.",
				);
			} else {
				expect(editor).not.toHaveBeenCalled();
			}
		}
	});

	it("completes configuration and atomic apply without a live nested Advisor runtime", async () => {
		const { agentDir, cwd } = await fixture();
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("Model and reasoning: not configured (high)")
			.mockResolvedValueOnce("fixture/advisor")
			.mockResolvedValueOnce("low")
			.mockResolvedValueOnce("Read-only tools: read, grep, find, ls")
			.mockResolvedValueOnce("[x] ls - list directories")
			.mockResolvedValueOnce("Done - use 3 read-only tools")
			.mockResolvedValueOnce("Instructions: none")
			.mockResolvedValueOnce("Add custom instructions")
			.mockResolvedValueOnce("Apply and save configuration");
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const applyConfiguration = vi.fn().mockResolvedValue(undefined);
		const ctx = commandContext({
			hasUI: true,
			cwd,
			isProjectTrusted: () => false,
			modelRegistry: {
				getAvailable: () => [{ provider: "fixture", id: "advisor" }],
			},
			ui: commandUi({
				select,
				editor: vi.fn().mockResolvedValue("Review public API compatibility."),
				confirm,
				notify,
			}),
		});
		try {
			await configureAdvisor(
				ctx,
				configureRuntime(applyConfiguration),
				structuredClone(DEFAULT_ADVISOR_CONFIG),
			);
			const saved = await readFile(join(agentDir, "WATCHDOG.yml"), "utf8");
			expect(saved).toContain("model: fixture/advisor");
			expect(saved).toContain("effort: low");
			expect(saved).toContain("Review public API compatibility.");
			expect(saved).not.toContain("  - ls");
			expect(applyConfiguration).toHaveBeenCalledOnce();
			expect(applyConfiguration.mock.calls[0]?.[0]).toMatchObject({
				model: "fixture/advisor",
				effort: "low",
				tools: ["read", "grep", "find"],
				instructions: "Review public API compatibility.",
			});
			expect(confirm).toHaveBeenCalledWith(
				"Apply Advisor configuration?",
				expect.stringContaining("Instructions: set"),
			);
			expect(notify).toHaveBeenLastCalledWith(
				expect.stringContaining("docs/configuration.md"),
				"info",
			);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("continues directly from no instructions to confirmation and atomic apply", async () => {
		const { agentDir, cwd } = await fixture();
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("Model and reasoning: not configured (high)")
			.mockResolvedValueOnce("fixture/advisor")
			.mockResolvedValueOnce("medium")
			.mockResolvedValueOnce("Read-only tools: read, grep, find, ls")
			.mockResolvedValueOnce("Done - use 4 read-only tools")
			.mockResolvedValueOnce("Instructions: none")
			.mockResolvedValueOnce("Continue without custom instructions")
			.mockResolvedValueOnce("Apply and save configuration");
		const editor = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const applyConfiguration = vi.fn().mockResolvedValue(undefined);
		const ctx = commandContext({
			hasUI: true,
			cwd,
			isProjectTrusted: () => false,
			modelRegistry: {
				getAvailable: () => [{ provider: "fixture", id: "advisor" }],
			},
			ui: commandUi({ select, editor, confirm, notify: vi.fn() }),
		});
		try {
			await configureAdvisor(
				ctx,
				configureRuntime(applyConfiguration),
				structuredClone(DEFAULT_ADVISOR_CONFIG),
			);
			const saved = await readFile(join(agentDir, "WATCHDOG.yml"), "utf8");
			expect(editor).not.toHaveBeenCalled();
			expect(confirm).toHaveBeenCalledOnce();
			expect(saved).toContain('instructions: ""');
			expect(applyConfiguration).toHaveBeenCalledOnce();
			expect(applyConfiguration.mock.calls[0]?.[0]).toMatchObject({ instructions: "" });
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("keeps persisted configuration and runtime unchanged when instructions or confirmation is cancelled", async () => {
		const scenarios = [
			{
				name: "instructions choice",
				selections: [
					"Model and reasoning: not configured (high)",
					"fixture/advisor",
					"medium",
					"Read-only tools: read, grep, find, ls",
					"Done - use 4 read-only tools",
					"Instructions: none",
					undefined,
					"Cancel",
				],
				editorResult: "unused",
				confirmResult: true,
				expectedConfirmCalls: 0,
			},
			{
				name: "instructions editor",
				selections: [
					"Model and reasoning: not configured (high)",
					"fixture/advisor",
					"medium",
					"Read-only tools: read, grep, find, ls",
					"Done - use 4 read-only tools",
					"Instructions: none",
					"Add custom instructions",
					"Cancel",
				],
				editorResult: undefined,
				confirmResult: true,
				expectedConfirmCalls: 0,
			},
			{
				name: "final confirmation",
				selections: [
					"Model and reasoning: not configured (high)",
					"fixture/advisor",
					"medium",
					"Read-only tools: read, grep, find, ls",
					"Done - use 4 read-only tools",
					"Instructions: none",
					"Continue without custom instructions",
					"Apply and save configuration",
				],
				editorResult: "unused",
				confirmResult: false,
				expectedConfirmCalls: 1,
			},
		];
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			for (const scenario of scenarios) {
				const { agentDir, cwd } = await fixture();
				process.env.PI_CODING_AGENT_DIR = agentDir;
				const priorYaml = [
					"version: 1",
					"model: fixture/advisor",
					"effort: medium",
					"instructions: ''",
					"",
				].join("\n");
				const path = join(agentDir, "WATCHDOG.yml");
				await writeFile(path, priorYaml);
				const pendingSelections = [...scenario.selections];
				const select = vi.fn(() => Promise.resolve(pendingSelections.shift()));
				const editor = vi.fn().mockResolvedValue(scenario.editorResult);
				const confirm = vi.fn().mockResolvedValue(scenario.confirmResult);
				const applyConfiguration = vi.fn().mockResolvedValue(undefined);
				const ctx = commandContext({
					hasUI: true,
					cwd,
					isProjectTrusted: () => false,
					modelRegistry: {
						getAvailable: () => [{ provider: "fixture", id: "advisor" }],
					},
					ui: commandUi({ select, editor, confirm, notify: vi.fn() }),
				});
				await configureAdvisor(
					ctx,
					configureRuntime(applyConfiguration),
					structuredClone(DEFAULT_ADVISOR_CONFIG),
				);
				expect(await readFile(path, "utf8"), scenario.name).toBe(priorYaml);
				expect(applyConfiguration, scenario.name).not.toHaveBeenCalled();
				expect(confirm, scenario.name).toHaveBeenCalledTimes(scenario.expectedConfirmCalls);
			}
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("loads a versioned partial User schema over approved defaults", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			[
				"version: 1",
				"defaultEnabled: true",
				"model: fixture/advisor",
				"effort: low",
				"tools: [read, grep]",
				"limits:",
				"  sessionCostSoftCapUsd: 2",
			].join("\n"),
		);

		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(loaded.warnings).toEqual([]);
		expect(loaded.userConfig).toMatchObject({
			version: 1,
			defaultEnabled: true,
			model: "fixture/advisor",
			effort: "low",
			tools: ["read", "grep"],
		});
		expect(loaded.userConfig.limits).toMatchObject({
			sessionCostSoftCapUsd: 2,
			maxAdviceCharacters: DEFAULT_ADVISOR_CONFIG.limits.maxAdviceCharacters,
		});
	});

	it("loads and serializes default-off cumulative caps", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "limits:", "  sessionTokenSoftCap: off", "  sessionCostSoftCapUsd: off"].join(
				"\n",
			),
		);
		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(loaded.warnings).toEqual([]);
		expect(loaded.userConfig.limits).toMatchObject({
			sessionTokenSoftCap: "off",
			sessionCostSoftCapUsd: "off",
		});

		const savedPath = join(agentDir, "saved.yml");
		await saveUserConfigurationAtomic(savedPath, loaded.userConfig);
		const saved = await readFile(savedPath, "utf8");
		expect(saved).toContain("sessionTokenSoftCap: off");
		expect(saved).toContain("sessionCostSoftCapUsd: off");
		expect(saved).not.toMatch(/(?:Infinity|NaN)/u);
	});

	it("merges cumulative caps with off treated as unbounded only for comparison", () => {
		const userOff = structuredClone(DEFAULT_ADVISOR_CONFIG);
		const projectFinite = mergeProjectConfiguration(userOff, {
			limits: { sessionTokenSoftCap: 100, sessionCostSoftCapUsd: 2 },
		});
		expect(projectFinite.limits).toMatchObject({
			sessionTokenSoftCap: 100,
			sessionCostSoftCapUsd: 2,
		});

		const userFinite = structuredClone(DEFAULT_ADVISOR_CONFIG);
		userFinite.limits.sessionTokenSoftCap = 100;
		userFinite.limits.sessionCostSoftCapUsd = 2;
		expect(
			mergeProjectConfiguration(userFinite, {
				limits: { sessionTokenSoftCap: "off", sessionCostSoftCapUsd: "off" },
			}).limits,
		).toMatchObject({ sessionTokenSoftCap: 100, sessionCostSoftCapUsd: 2 });
		expect(
			mergeProjectConfiguration(userFinite, {
				limits: { sessionTokenSoftCap: 200, sessionCostSoftCapUsd: 1 },
			}).limits,
		).toMatchObject({ sessionTokenSoftCap: 100, sessionCostSoftCapUsd: 1 });
	});

	it("rejects non-positive cumulative caps with path-specific value-free warnings", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "limits:", "  sessionTokenSoftCap: 0", "  sessionCostSoftCapUsd: 0"].join(
				"\n",
			),
		);
		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(loaded.warnings.map((warning) => warning.path)).toEqual(
			expect.arrayContaining(["limits.sessionTokenSoftCap", "limits.sessionCostSoftCapUsd"]),
		);
		for (const warning of loaded.warnings) {
			expect(warning.message).not.toContain("configured value");
		}
		expect(loaded.effectiveConfig.limits).toMatchObject({
			sessionTokenSoftCap: "off",
			sessionCostSoftCapUsd: "off",
		});
	});

	it("uses release defaults without rewriting fields omitted from a durable User file", async () => {
		const { agentDir, cwd } = await fixture();
		const userYaml = join(agentDir, "WATCHDOG.yml");
		const original = "version: 1\nmodel: fixture/advisor\n";
		await writeFile(userYaml, original);
		const fallback = structuredClone(DEFAULT_ADVISOR_CONFIG);
		fallback.defaultEnabled = true;
		fallback.effort = "max";
		fallback.tools = ["ls"];
		fallback.limits.sessionCostSoftCapUsd = 99;

		const loaded = await loadAdvisorConfiguration({
			agentDir,
			cwd,
			projectTrusted: false,
			fallbackUserConfig: fallback,
		});
		expect(loaded.userConfig).toMatchObject({
			model: "fixture/advisor",
			defaultEnabled: DEFAULT_ADVISOR_CONFIG.defaultEnabled,
			effort: DEFAULT_ADVISOR_CONFIG.effort,
			tools: DEFAULT_ADVISOR_CONFIG.tools,
			limits: {
				sessionCostSoftCapUsd: DEFAULT_ADVISOR_CONFIG.limits.sessionCostSoftCapUsd,
			},
			persistence: { transcript: true },
		});
		expect(await readFile(userYaml, "utf8")).toBe(original);
	});

	it("fails malformed or mutating User configuration safely inactive", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			"version: 1\ndefaultEnabled: true\nmodel: fixture/advisor\ntools: [read, bash]\n",
		);
		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(loaded.effectiveConfig.defaultEnabled).toBe(false);
		expect(loaded.effectiveConfig.model).toBeUndefined();
		expect(loaded.effectiveConfig.persistence.transcript).toBe(false);
		expect(loaded.warnings.some((warning) => warning.path.includes("tools"))).toBe(true);

		await writeFile(join(agentDir, "WATCHDOG.yml"), "version: [broken\n");
		const malformed = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(malformed.effectiveConfig.defaultEnabled).toBe(false);
		expect(malformed.effectiveConfig.persistence.transcript).toBe(false);
		expect(malformed.warnings[0]?.message).toContain("malformed YAML");
	});

	it("keeps the local activity record off when User configuration cannot be read", async () => {
		const { agentDir, cwd } = await fixture();
		await mkdir(join(agentDir, "WATCHDOG.yml"));
		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(loaded.effectiveConfig).toMatchObject({
			defaultEnabled: false,
			persistence: { transcript: false },
		});
		expect(loaded.warnings[0]?.message).toContain("could not be read");
	});

	it("loads delivery.activeIdleSeverities with the approved release default and nit rejection", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(join(agentDir, "WATCHDOG.yml"), ["version: 1"].join("\n"));
		const defaults = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(defaults.warnings).toEqual([]);
		expect(defaults.userConfig.delivery).toEqual({ activeIdleSeverities: ["blocker"] });

		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "delivery:", "  activeIdleSeverities: [concern, blocker]"].join("\n"),
		);
		const widened = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(widened.warnings).toEqual([]);
		expect(widened.userConfig.delivery).toEqual({
			activeIdleSeverities: ["concern", "blocker"],
		});

		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "delivery:", "  activeIdleSeverities: [nit]"].join("\n"),
		);
		const rejected = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(
			rejected.warnings.some(({ path }) => path.startsWith("delivery.activeIdleSeverities")),
		).toBe(true);
	});

	it("merges trusted Project delivery configuration only by removing severities", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "delivery:", "  activeIdleSeverities: [concern, blocker]"].join("\n"),
		);
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			["version: 1", "delivery:", "  activeIdleSeverities: [blocker]"].join("\n"),
		);
		const narrowed = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(narrowed.effectiveConfig.delivery).toEqual({ activeIdleSeverities: ["blocker"] });

		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "delivery:", "  activeIdleSeverities: [blocker]"].join("\n"),
		);
		const cannotAdd = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(cannotAdd.effectiveConfig.delivery).toEqual({ activeIdleSeverities: ["blocker"] });
	});

	it("loads review defaults and rejects out-of-range adaptive cadence fields", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(join(agentDir, "WATCHDOG.yml"), ["version: 1"].join("\n"));
		const defaults = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(defaults.warnings).toEqual([]);
		expect(defaults.userConfig.review).toEqual({
			skipNonMaterialTurns: false,
			adaptiveCadence: {
				enabled: false,
				silentReviewsBeforeBackOff: 3,
				backOffTurnStep: 1,
				maxMinTurnsBetweenReviews: 4,
			},
		});

		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			[
				"version: 1",
				"review:",
				"  skipNonMaterialTurns: true",
				"  adaptiveCadence:",
				"    enabled: true",
				"    silentReviewsBeforeBackOff: 8",
				"    backOffTurnStep: 2",
				"    maxMinTurnsBetweenReviews: 6",
			].join("\n"),
		);
		const custom = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(custom.warnings).toEqual([]);
		expect(custom.userConfig.review).toEqual({
			skipNonMaterialTurns: true,
			adaptiveCadence: {
				enabled: true,
				silentReviewsBeforeBackOff: 8,
				backOffTurnStep: 2,
				maxMinTurnsBetweenReviews: 6,
			},
		});

		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "review:", "  adaptiveCadence:", "    silentReviewsBeforeBackOff: 0"].join(
				"\n",
			),
		);
		const rejected = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(
			rejected.warnings.some(({ path }) =>
				path.startsWith("review.adaptiveCadence.silentReviewsBeforeBackOff"),
			),
		).toBe(true);
	});

	it("merges trusted Project review configuration only in cost-reducing directions", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			[
				"version: 1",
				"review:",
				"  skipNonMaterialTurns: true",
				"  adaptiveCadence:",
				"    enabled: true",
				"    silentReviewsBeforeBackOff: 3",
				"    backOffTurnStep: 2",
				"    maxMinTurnsBetweenReviews: 8",
			].join("\n"),
		);
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			[
				"version: 1",
				"review:",
				"  skipNonMaterialTurns: false",
				"  adaptiveCadence:",
				"    enabled: false",
				"    silentReviewsBeforeBackOff: 10",
				"    backOffTurnStep: 8",
				"    maxMinTurnsBetweenReviews: 4",
			].join("\n"),
		);
		const hostile = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(hostile.effectiveConfig.review).toEqual({
			skipNonMaterialTurns: true,
			adaptiveCadence: {
				enabled: true,
				silentReviewsBeforeBackOff: 3,
				backOffTurnStep: 2,
				maxMinTurnsBetweenReviews: 8,
			},
		});
		expect(hostile.warnings.map((warning) => warning.path)).toEqual(
			expect.arrayContaining([
				"review.skipNonMaterialTurns",
				"review.adaptiveCadence.enabled",
				"review.adaptiveCadence.backOffTurnStep",
			]),
		);

		await writeFile(join(agentDir, "WATCHDOG.yml"), ["version: 1"].join("\n"));
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			[
				"version: 1",
				"review:",
				"  skipNonMaterialTurns: true",
				"  adaptiveCadence:",
				"    enabled: true",
				"    silentReviewsBeforeBackOff: 1",
				"    maxMinTurnsBetweenReviews: 6",
			].join("\n"),
		);
		const narrowed = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(narrowed.effectiveConfig.review).toEqual({
			skipNonMaterialTurns: true,
			adaptiveCadence: {
				enabled: true,
				silentReviewsBeforeBackOff: 1,
				backOffTurnStep: 1,
				maxMinTurnsBetweenReviews: 6,
			},
		});
	});

	it("preserves unknown top-level User fields across a configure save round-trip", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			[
				"version: 1",
				"defaultEnabled: true",
				"model: fixture/advisor",
				"futureKnob: keep-me",
				"anotherFuture:",
				"  nested: [1, 2]",
			].join("\n"),
		);
		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(loaded.warnings.some(({ path }) => path === "futureKnob")).toBe(true);
		expect(loaded.userUnknownTopLevel).toEqual({
			futureKnob: "keep-me",
			anotherFuture: { nested: [1, 2] },
		});

		const savedPath = join(agentDir, "saved.yml");
		await saveUserConfigurationAtomic(savedPath, loaded.userConfig, loaded.userUnknownTopLevel);
		const saved = await readFile(savedPath, "utf8");
		expect(saved).toContain("futureKnob: keep-me");
		expect(saved).toContain("anotherFuture:");
		expect(saved).toContain("nested:");

		await writeFile(agentDir + "/WATCHDOG.yml", saved);
		const reloaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(reloaded.userUnknownTopLevel).toEqual({
			futureKnob: "keep-me",
			anotherFuture: { nested: [1, 2] },
		});
		expect(reloaded.userConfig.defaultEnabled).toBe(true);
	});

	it("drops unknown top-level User fields that exceed the preservation byte limit", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", `hugeFuture: "${"x".repeat(70_000)}"`].join("\n"),
		);
		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(loaded.userUnknownTopLevel).toBeUndefined();
		expect(loaded.warnings.some(({ message }) => message.includes("preservation limit"))).toBe(
			true,
		);
	});

	it("drops preserved unknown fields when the merged save would exceed the YAML limit", () => {
		const serialized = serializeUserConfiguration(DEFAULT_ADVISOR_CONFIG, {
			futureKnob: "keep-me",
			hugeFuture: "x".repeat(MAX_WATCHDOG_YAML_BYTES),
		});
		expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_WATCHDOG_YAML_BYTES);
		expect(serialized).not.toContain("hugeFuture");
		expect(serialized).not.toContain("futureKnob");
	});

	it("ignores Project files when trust is inactive", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(join(agentDir, "WATCHDOG.yml"), "version: 1\nmodel: fixture/advisor\n");
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			"version: 1\ntools: [read]\ninstructions: Project focus\n",
		);
		await writeFile(join(cwd, ".pi", "WATCHDOG.md"), "PROJECT-MARKDOWN-SENTINEL");
		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(loaded.effectiveConfig.tools).toEqual(DEFAULT_ADVISOR_CONFIG.tools);
		expect(loaded.projectInstructions).toBe("");
		expect(loaded.warnings).toEqual([]);
	});

	it("merges trusted Project configuration only toward narrower policy", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			[
				"version: 1",
				"defaultEnabled: true",
				"model: fixture/advisor",
				"effort: high",
				"tools: [read, grep, find]",
				"limits:",
				"  maxToolCallsPerUpdate: 8",
				"  minTurnsBetweenReviews: 2",
				"security:",
				"  protectedPathExceptions: [allowed.txt]",
				"memorySuggestions:",
				"  enabled: false",
			].join("\n"),
		);
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			[
				"version: 1",
				"defaultEnabled: true",
				"model: attacker/model",
				"effort: max",
				"tools: [grep, ls]",
				"instructions: Focus on project invariants.",
				"context:",
				"  maxFraction: 0.5",
				"  reserveTokens: 12000",
				"limits:",
				"  maxToolCallsPerUpdate: 4",
				"  minTurnsBetweenReviews: 5",
				"security:",
				"  additionalProtectedPaths: [private]",
				"  protectedPathExceptions: [stolen.txt]",
				"persistence:",
				"  transcript: true",
				"memorySuggestions:",
				"  enabled: true",
			].join("\n"),
		);
		await writeFile(join(cwd, ".pi", "WATCHDOG.md"), "Also inspect migration ordering.");

		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(loaded.effectiveConfig).toMatchObject({
			defaultEnabled: true,
			model: "fixture/advisor",
			effort: "high",
			tools: ["grep"],
			context: { maxFraction: 0.5, reserveTokens: 12_000 },
			limits: { maxToolCallsPerUpdate: 4, minTurnsBetweenReviews: 5 },
			security: {
				additionalProtectedPaths: ["private"],
				protectedPathExceptions: ["allowed.txt"],
			},
			memorySuggestions: { enabled: false },
			persistence: { transcript: true },
		});
		expect(loaded.projectInstructions).toContain("Focus on project invariants.");
		expect(loaded.projectInstructions).toContain("Also inspect migration ordering.");
		expect(loaded.warnings.map((warning) => warning.path)).toEqual(
			expect.arrayContaining([
				"defaultEnabled",
				"model",
				"effort",
				"security.protectedPathExceptions",
				"persistence",
			]),
		);
	});

	it.each(['"true"', "null"])(
		"warns when Project memorySuggestions.enabled is a non-false value (%s)",
		async (enabled) => {
			const { agentDir, cwd } = await fixture();
			await writeFile(join(agentDir, "WATCHDOG.yml"), "version: 1\n");
			await writeFile(
				join(cwd, ".pi", "WATCHDOG.yml"),
				`version: 1\nmemorySuggestions:\n  enabled: ${enabled}\n`,
			);

			const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
			expect(loaded.warnings).toContainEqual({
				source: "project",
				path: "memorySuggestions.enabled",
				message:
					"Project field memorySuggestions.enabled cannot re-enable User-disabled behavior and was ignored.",
			});
			expect(loaded.effectiveConfig.memorySuggestions.enabled).toBe(
				DEFAULT_ADVISOR_CONFIG.memorySuggestions.enabled,
			);
		},
	);

	it("adds User and trusted Project protected paths while preserving User-only exact exceptions", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			[
				"version: 1",
				"security:",
				"  additionalProtectedPaths: [user-private]",
				"  protectedPathExceptions: [user-private/allowed.txt]",
			].join("\n"),
		);
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			[
				"version: 1",
				"security:",
				"  additionalProtectedPaths: [project-private]",
				"  protectedPathExceptions: [project-private/stolen.txt]",
			].join("\n"),
		);

		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(loaded.effectiveConfig.security).toEqual({
			additionalProtectedPaths: ["user-private", "project-private"],
			protectedPathExceptions: ["user-private/allowed.txt"],
		});
		expect(loaded.warnings.map((warning) => warning.path)).toContain(
			"security.protectedPathExceptions",
		);
	});

	it("redacts and bounds WATCHDOG markdown before use", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(join(agentDir, "WATCHDOG.yml"), "version: 1\n");
		await writeFile(
			join(agentDir, "WATCHDOG.md"),
			`API_KEY=super-secret-value\n${"x".repeat(MAX_WATCHDOG_MARKDOWN_BYTES + 100)}`,
		);
		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(loaded.effectiveConfig.instructions).toContain("[REDACTED]");
		expect(loaded.effectiveConfig.instructions).not.toContain("super-secret-value");
		expect(Buffer.byteLength(loaded.effectiveConfig.instructions, "utf8")).toBeLessThanOrEqual(
			MAX_WATCHDOG_MARKDOWN_BYTES,
		);
		expect(loaded.warnings.some((warning) => warning.message.includes("truncated"))).toBe(true);
	});

	it("atomically replaces valid configuration without leaving temporary files", async () => {
		const { agentDir } = await fixture();
		const path = join(agentDir, "WATCHDOG.yml");
		await writeFile(path, "version: 1\nmodel: old/model\n");
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.model = "new/model";
		await saveUserConfigurationAtomic(path, config);
		expect(await readFile(path, "utf8")).toContain("model: new/model");
		expect((await readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("preserves the prior valid file when an atomic save cannot create its temporary file", async () => {
		if (process.platform === "win32") return;
		const { agentDir } = await fixture();
		const path = join(agentDir, "WATCHDOG.yml");
		const prior = "version: 1\nmodel: old/model\n";
		await writeFile(path, prior);
		await chmod(agentDir, 0o500);
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.model = "new/model";
		try {
			await expect(saveUserConfigurationAtomic(path, config)).rejects.toThrow();
			expect(await readFile(path, "utf8")).toBe(prior);
		} finally {
			await chmod(agentDir, 0o700);
		}
	});
});

describe("Quality Slice Q5 dedupe configuration", () => {
	it("loads dedupe defaults and rejects out-of-range values", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(join(agentDir, "WATCHDOG.yml"), ["version: 1"].join("\n"));
		const defaults = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(defaults.warnings).toEqual([]);
		expect(defaults.userConfig.dedupe).toEqual({
			similarityRedeliveryThreshold: 0.5,
			reRaiseMinTurns: 4,
		});

		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			[
				"version: 1",
				"dedupe:",
				"  similarityRedeliveryThreshold: 0.25",
				"  reRaiseMinTurns: 8",
			].join("\n"),
		);
		const custom = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(custom.warnings).toEqual([]);
		expect(custom.userConfig.dedupe).toEqual({
			similarityRedeliveryThreshold: 0.25,
			reRaiseMinTurns: 8,
		});

		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "dedupe:", "  similarityRedeliveryThreshold: 1.5"].join("\n"),
		);
		const rejected = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(
			rejected.warnings.some(({ path }) => path.startsWith("dedupe.similarityRedeliveryThreshold")),
		).toBe(true);

		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "dedupe:", "  reRaiseMinTurns: 65"].join("\n"),
		);
		const rejectedTurns = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: false });
		expect(
			rejectedTurns.warnings.some(({ path }) => path.startsWith("dedupe.reRaiseMinTurns")),
		).toBe(true);
	});

	it("clamps dedupe values to hard limits and floors turn counts", () => {
		expect(
			normalizeAdvisorConfig({
				...structuredClone(DEFAULT_ADVISOR_CONFIG),
				dedupe: { similarityRedeliveryThreshold: 2, reRaiseMinTurns: 100 },
			}).dedupe,
		).toEqual({ similarityRedeliveryThreshold: 1, reRaiseMinTurns: HARD_LIMITS.reRaiseMinTurns });
		expect(
			normalizeAdvisorConfig({
				...structuredClone(DEFAULT_ADVISOR_CONFIG),
				dedupe: { similarityRedeliveryThreshold: -1, reRaiseMinTurns: 2.5 },
			}).dedupe,
		).toEqual({ similarityRedeliveryThreshold: 0, reRaiseMinTurns: 2 });
	});

	it("merges trusted Project dedupe configuration only in redelivery-reducing directions", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			[
				"version: 1",
				"dedupe:",
				"  similarityRedeliveryThreshold: 0.5",
				"  reRaiseMinTurns: 4",
			].join("\n"),
		);
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			[
				"version: 1",
				"dedupe:",
				"  similarityRedeliveryThreshold: 0.9",
				"  reRaiseMinTurns: 1",
			].join("\n"),
		);
		const hostile = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(hostile.effectiveConfig.dedupe).toEqual({
			similarityRedeliveryThreshold: 0.5,
			reRaiseMinTurns: 4,
		});

		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			[
				"version: 1",
				"dedupe:",
				"  similarityRedeliveryThreshold: 0.1",
				"  reRaiseMinTurns: 12",
			].join("\n"),
		);
		const narrowed = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(narrowed.effectiveConfig.dedupe).toEqual({
			similarityRedeliveryThreshold: 0.1,
			reRaiseMinTurns: 12,
		});
	});

	it("lets Project dedupe configuration zero re-raise but never re-enable redelivery", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(join(agentDir, "WATCHDOG.yml"), ["version: 1"].join("\n"));
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			["version: 1", "dedupe:", "  reRaiseMinTurns: 0"].join("\n"),
		);
		const narrowed = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(narrowed.effectiveConfig.dedupe).toEqual({
			similarityRedeliveryThreshold: 0.5,
			reRaiseMinTurns: 0,
		});

		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			["version: 1", "dedupe:", "  reRaiseMinTurns: 0"].join("\n"),
		);
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			["version: 1", "dedupe:", "  reRaiseMinTurns: 8"].join("\n"),
		);
		const staysDisabled = await loadAdvisorConfiguration({
			agentDir,
			cwd,
			projectTrusted: true,
		});
		expect(staysDisabled.effectiveConfig.dedupe).toEqual({
			similarityRedeliveryThreshold: 0.5,
			reRaiseMinTurns: 0,
		});
	});
});

describe("Quality Slice Q6 batched configuration warnings (F14)", () => {
	it("publishes one combined notify with one line per warning", () => {
		const notify = vi.fn();
		const ctx = commandContext({
			hasUI: true,
			ui: commandUi({ notify }),
		});
		publishConfigurationWarnings(ctx, [
			{ source: "user", path: "~/.pi/agent/WATCHDOG.yml", message: "first warning" },
			{ source: "project", path: ".pi/WATCHDOG.yml", message: "second warning" },
			{ source: "user", path: "~/.pi/agent/WATCHDOG.yml", message: "third warning" },
		]);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("first warning\nsecond warning\nthird warning", "warning");
	});

	it("stays silent without a UI and without warnings", () => {
		const notify = vi.fn();
		const ctx = commandContext({
			hasUI: false,
			ui: commandUi({ notify }),
		});
		publishConfigurationWarnings(ctx, [{ source: "user", path: "x", message: "ignored" }]);
		expect(notify).not.toHaveBeenCalled();
		const withUi = commandContext({ hasUI: true, ui: commandUi({ notify }) });
		publishConfigurationWarnings(withUi, []);
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("Quality Slice Q6 configure menu model gate (F12)", () => {
	it("refuses Apply without a model, notifies, and loops back to the menu", async () => {
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("Apply and save configuration")
			.mockResolvedValueOnce("Cancel");
		const notify = vi.fn();
		const configured = await pickAdvisorInteractiveConfiguration(
			{
				mode: "rpc",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: {
					getAvailable: () => [{ provider: "fixture", id: "advisor" }],
				} as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({ select, editor: vi.fn(), notify }),
			},
			structuredClone(DEFAULT_ADVISOR_CONFIG),
		);
		expect(configured).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Select an Advisor model first"),
			"warning",
		);
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("applies normally once a model is selected in the menu", async () => {
		const select = vi
			.fn<ExtensionCommandContext["ui"]["select"]>()
			.mockResolvedValueOnce("Model and reasoning: not configured (high)")
			.mockResolvedValueOnce("fixture/advisor")
			.mockResolvedValueOnce("high")
			.mockResolvedValueOnce("Apply and save configuration");
		const configured = await pickAdvisorInteractiveConfiguration(
			{
				mode: "rpc",
				// SAFETY: this picker test double implements the only registry method used here.
				modelRegistry: {
					getAvailable: () => [{ provider: "fixture", id: "advisor" }],
				} as ExtensionCommandContext["modelRegistry"],
				ui: commandUi({
					select,
					editor: vi.fn(),
					notify: vi.fn(),
				}),
			},
			structuredClone(DEFAULT_ADVISOR_CONFIG),
		);
		expect(configured).toMatchObject({ model: "fixture/advisor", effort: "high" });
		expect(select).toHaveBeenCalledTimes(4);
	});
});

describe("Quality Slice Q6 legacy programmatic configuration (verified defect fix)", () => {
	it("normalizes a legacy programmatic config missing every post-original group", () => {
		const legacy: Partial<AdvisorConfig> = structuredClone(DEFAULT_ADVISOR_CONFIG);
		// A config built against the original shape lacks every group added
		// later: delivery (Q3), review (Q4), dedupe (Q5), and the later
		// memorySuggestions and persistence groups; deleting the original groups
		// too proves the merge-over-defaults fallback is complete.
		delete legacy.tools;
		delete legacy.context;
		delete legacy.limits;
		delete legacy.security;
		delete legacy.delivery;
		delete legacy.review;
		delete legacy.dedupe;
		delete legacy.memorySuggestions;
		delete legacy.persistence;
		// SAFETY: this test intentionally passes a legacy partial object to verify runtime normalization.
		const normalized = normalizeAdvisorConfig(legacy as AdvisorConfig);
		expect(normalized.delivery.activeIdleSeverities).toEqual(["blocker"]);
		expect(normalized.dedupe.similarityRedeliveryThreshold).toBe(0.5);
		expect(normalized.dedupe.reRaiseMinTurns).toBe(4);
		expect(normalized.review.skipNonMaterialTurns).toBe(false);
		expect(normalized.memorySuggestions.enabled).toBe(true);
		expect(normalized.persistence.transcript).toBe(true);
		expect(normalized.limits.sessionTokenSoftCap).toBe("off");
		expect(normalized.limits.maxReviewAttemptMs).toBe(120_000);
		expect(normalized.limits.maxNestedCompactionMs).toBe(60_000);
		expect(normalized.limits.maxLifecycleAbortMs).toBe(2_000);
		expect(normalized.tools).toEqual(["read", "grep", "find", "ls"]);
	});

	it("normalizes present-but-partial groups against the release defaults", () => {
		const partial = structuredClone(DEFAULT_ADVISOR_CONFIG);
		// SAFETY: this test intentionally creates incomplete nested groups to verify default merging.
		Object.assign(partial, {
			delivery: {} as AdvisorConfig["delivery"],
			security: {} as AdvisorConfig["security"],
			dedupe: {} as AdvisorConfig["dedupe"],
			review: {} as AdvisorConfig["review"],
			context: {} as AdvisorConfig["context"],
			limits: {} as AdvisorConfig["limits"],
			memorySuggestions: {} as AdvisorConfig["memorySuggestions"],
			persistence: {} as AdvisorConfig["persistence"],
		});
		const normalized = normalizeAdvisorConfig(partial);
		expect(normalized.delivery.activeIdleSeverities).toEqual(["blocker"]);
		expect(normalized.security.additionalProtectedPaths).toEqual([]);
		expect(normalized.security.protectedPathExceptions).toEqual([]);
		expect(normalized.dedupe.similarityRedeliveryThreshold).toBe(0.5);
		expect(normalized.dedupe.reRaiseMinTurns).toBe(4);
		expect(normalized.review.skipNonMaterialTurns).toBe(false);
		expect(normalized.context.maxFraction).toBe(0.65);
		expect(normalized.limits.sessionTokenSoftCap).toBe("off");
		expect(normalized.limits.maxReviewAttemptMs).toBe(120_000);
		expect(normalized.limits.maxNestedCompactionMs).toBe(60_000);
		expect(normalized.limits.maxLifecycleAbortMs).toBe(2_000);
		expect(normalized.memorySuggestions.enabled).toBe(true);
		expect(normalized.persistence.transcript).toBe(true);
	});

	it("loads timeout limits, clamps them, and lets Project only lower them", async () => {
		const { agentDir, cwd } = await fixture();
		await writeFile(
			join(agentDir, "WATCHDOG.yml"),
			[
				"version: 1",
				"limits:",
				"  maxReviewAttemptMs: 90000",
				"  maxNestedCompactionMs: 45000",
				"  maxLifecycleAbortMs: 1500",
			].join("\n"),
		);
		await writeFile(
			join(cwd, ".pi", "WATCHDOG.yml"),
			[
				"version: 1",
				"limits:",
				"  maxReviewAttemptMs: 30000",
				"  maxNestedCompactionMs: 80000",
				"  maxLifecycleAbortMs: 0",
			].join("\n"),
		);
		const loaded = await loadAdvisorConfiguration({ agentDir, cwd, projectTrusted: true });
		expect(loaded.userConfig.limits).toMatchObject({
			maxReviewAttemptMs: 90_000,
			maxNestedCompactionMs: 45_000,
			maxLifecycleAbortMs: 1_500,
		});
		expect(loaded.effectiveConfig.limits).toMatchObject({
			maxReviewAttemptMs: 30_000,
			maxNestedCompactionMs: 45_000,
			maxLifecycleAbortMs: 0,
		});
		const oversized = structuredClone(DEFAULT_ADVISOR_CONFIG);
		oversized.limits.maxReviewAttemptMs = HARD_LIMITS.maxReviewAttemptMs + 1;
		expect(normalizeAdvisorConfig(oversized).limits.maxReviewAttemptMs).toBe(
			HARD_LIMITS.maxReviewAttemptMs,
		);
	});
});
