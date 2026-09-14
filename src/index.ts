import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_ADVISOR_CONFIG,
	normalizeAdvisorConfig,
	READ_ONLY_TOOL_NAMES,
	type AdvisorConfig,
	type ReadOnlyToolName,
} from "./config.js";
import {
	loadAdvisorConfiguration,
	saveUserConfigurationAtomic,
	type ConfigurationWarning,
} from "./configuration.js";
import {
	ADVISOR_LATE_ENTRY_TYPE,
	renderAdviceMessage,
	renderLateAdviceEntry,
} from "./presentation.js";
import { AdvisorModelPicker, advisorModelOptions } from "./model-picker.js";
import { ADVISOR_CUSTOM_TYPE } from "./transcript.js";
import {
	AdvisorRuntime,
	formatAdvisorEnableStatus,
	formatAdvisorFooterStatus,
	formatAdvisorStatus,
	formatAdvisorStatusShort,
	shouldAnimateAdvisorFooter,
	type AdvisorRuntimeHooks,
} from "./runtime.js";
import { isHexPrefix, shortestUniquePrefixes } from "./mutes.js";

export interface PiAdvisorExtensionOptions {
	config?: AdvisorConfig;
	hooks?: AdvisorRuntimeHooks & {
		onRuntime?(runtime: AdvisorRuntime): void;
	};
}

export function publishConfigurationWarnings(
	ctx: ExtensionCommandContext | Parameters<AdvisorRuntime["startSession"]>[0],
	warnings: ConfigurationWarning[],
): void {
	if (!ctx.hasUI || warnings.length === 0) return;
	// F14: one combined notify with one line per warning instead of per-warning notifies.
	ctx.ui.notify(warnings.map((warning) => warning.message).join("\n"), "warning");
}

export const CONFIGURATION_REFERENCE =
	"docs/configuration.md (https://github.com/ribbons-digital/pi-advisor/blob/main/docs/configuration.md)";

type AdvisorPickerContext = Pick<ExtensionCommandContext, "mode" | "modelRegistry" | "ui"> & {
	thinkingLevel?: AdvisorConfig["effort"];
};

export async function pickAdvisorModelAndEffort(
	ctx: AdvisorPickerContext,
	current?: Pick<AdvisorConfig, "model" | "effort">,
): Promise<{ model: string; effort: AdvisorConfig["effort"] } | undefined> {
	const availableModels = ctx.modelRegistry.getAvailable();
	const models = advisorModelOptions(availableModels, current?.model);
	if (models.length === 0) {
		ctx.ui.notify(
			"No authenticated Advisor models are available. Configure provider credentials, then retry.",
			"warning",
		);
		return undefined;
	}
	const modelReference =
		ctx.mode === "tui"
			? await ctx.ui.custom<string | undefined>(
					(tui, theme, keybindings, done) =>
						new AdvisorModelPicker(models, tui, theme, done, keybindings),
				)
			: await ctx.ui.select(
					"Select Advisor model",
					models.map((candidate) => candidate.reference),
				);
	if (modelReference === undefined) return undefined;
	const selectedModel = availableModels.find(
		(model) => `${model.provider}/${model.id}` === modelReference,
	);
	if (selectedModel === undefined) return undefined;

	// SAFETY: Pi returns only supported Advisor effort literals.
	const effortOptions = getSupportedThinkingLevels(selectedModel) as AdvisorConfig["effort"][];
	if (current !== undefined) {
		const index = effortOptions.indexOf(current.effort);
		if (index > 0) effortOptions.unshift(...effortOptions.splice(index, 1));
		if (index < 0) {
			ctx.ui.notify(
				`Current Advisor reasoning level "${current.effort}" is not supported by ${modelReference}. Choose a supported level.`,
				"warning",
			);
		}
	}
	const reasoningPrompt =
		ctx.thinkingLevel === undefined
			? "Select Advisor reasoning level"
			: `Select Advisor reasoning level (current Executor reasoning: ${ctx.thinkingLevel}; Advisor selection is independent)`;
	const effort = await ctx.ui.select(reasoningPrompt, effortOptions);
	if (effort === undefined) return undefined;
	// SAFETY: the selected value came from the supported Advisor effort options.
	return { model: modelReference, effort: effort as AdvisorConfig["effort"] };
}

const TOOL_DESCRIPTIONS = {
	read: "read files",
	grep: "search file contents",
	find: "find files by pattern",
	ls: "list directories",
} satisfies Record<ReadOnlyToolName, string>;

export async function pickAdvisorTools(
	ctx: Pick<ExtensionCommandContext, "ui">,
	currentTools: readonly ReadOnlyToolName[],
): Promise<ReadOnlyToolName[] | undefined> {
	const selected = new Set(currentTools);
	for (;;) {
		const choices = [
			...READ_ONLY_TOOL_NAMES.map(
				(name) => `${selected.has(name) ? "[x]" : "[ ]"} ${name} - ${TOOL_DESCRIPTIONS[name]}`,
			),
			`Done - use ${String(selected.size)} read-only tool${selected.size === 1 ? "" : "s"}`,
		];
		const choice = await ctx.ui.select(
			"Select Advisor tools (toggle an approved read-only tool, then choose Done)",
			choices,
		);
		if (choice === undefined) return undefined;
		if (choice.startsWith("Done -")) {
			return READ_ONLY_TOOL_NAMES.filter((name) => selected.has(name));
		}
		const tool = READ_ONLY_TOOL_NAMES.find((name) => choice.includes(` ${name} - `));
		if (tool === undefined) continue;
		if (selected.has(tool)) selected.delete(tool);
		else selected.add(tool);
	}
}

async function pickAdvisorInstructions(
	ctx: Pick<ExtensionCommandContext, "ui">,
	currentInstructions: string,
): Promise<string | undefined> {
	const hasCurrentInstructions = currentInstructions.trim().length > 0;
	const choices = hasCurrentInstructions
		? ["Keep current instructions", "Edit instructions", "Clear instructions"]
		: ["Continue without custom instructions", "Add custom instructions"];
	const choice = await ctx.ui.select(
		"Choose optional User Advisor instructions for this configuration",
		choices,
	);
	if (choice === undefined) return undefined;
	if (choice === "Keep current instructions") return currentInstructions;
	if (choice === "Clear instructions" || choice === "Continue without custom instructions") {
		return "";
	}
	if (choice !== "Add custom instructions" && choice !== "Edit instructions") return undefined;
	const edited = await ctx.ui.editor(
		`Configuration step: ${choice === "Add custom instructions" ? "add" : "edit"} User Advisor instructions (fixed safety policy always remains authoritative)`,
		choice === "Add custom instructions" ? "" : currentInstructions,
	);
	return edited?.trim();
}

export async function pickAdvisorInteractiveConfiguration(
	ctx: AdvisorPickerContext,
	current: AdvisorConfig,
): Promise<AdvisorConfig | undefined> {
	// F12: section menu; each section edits only its own values, Apply performs
	// the single confirmation plus atomic save, Cancel discards all pending edits.
	let draft = normalizeAdvisorConfig(structuredClone(current));
	for (;;) {
		const choices = [
			`Model and reasoning: ${draft.model ?? "not configured"} (${draft.effort})`,
			`Read-only tools: ${draft.tools.join(", ") || "none"}`,
			`Instructions: ${draft.instructions.trim().length === 0 ? "none" : "set"}`,
			"Apply and save configuration",
			"Cancel",
		];
		const choice = await ctx.ui.select("Configure Advisor (edit one section, then Apply)", choices);
		if (choice === undefined || choice === "Cancel") return undefined;
		if (choice === "Apply and save configuration") {
			if (draft.model === undefined) {
				ctx.ui.notify(
					"Select an Advisor model first. Advisor never selects a model automatically, so configuration cannot be applied without one.",
					"warning",
				);
				continue;
			}
			return draft;
		}
		if (choice.startsWith("Model and reasoning")) {
			const modelAndEffort = await pickAdvisorModelAndEffort(ctx, draft);
			if (modelAndEffort === undefined) continue;
			draft = normalizeAdvisorConfig({ ...structuredClone(draft), ...modelAndEffort });
		} else if (choice.startsWith("Read-only tools")) {
			const tools = await pickAdvisorTools(ctx, draft.tools);
			if (tools === undefined) continue;
			draft = normalizeAdvisorConfig({ ...structuredClone(draft), tools });
		} else if (choice.startsWith("Instructions")) {
			const instructions = await pickAdvisorInstructions(ctx, draft.instructions);
			if (instructions === undefined) continue;
			draft = normalizeAdvisorConfig({ ...structuredClone(draft), instructions });
		}
	}
}

export async function configureAdvisor(
	ctx: ExtensionCommandContext,
	runtime: AdvisorRuntime,
	fallbackUserConfig: AdvisorConfig,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`/advisor configure requires a dialog-capable TUI or RPC client. See ${CONFIGURATION_REFERENCE}.`,
			"info",
		);
		return;
	}
	const loaded = await loadAdvisorConfiguration({
		agentDir: getAgentDir(),
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
		fallbackUserConfig,
	});
	publishConfigurationWarnings(ctx, loaded.warnings);
	const nextUserConfig = await pickAdvisorInteractiveConfiguration(ctx, loaded.userConfig);
	if (nextUserConfig === undefined) return;
	const selectedModel = nextUserConfig.model;
	if (selectedModel === undefined) return;
	const confirmed = await ctx.ui.confirm(
		"Apply Advisor configuration?",
		[
			`Model: ${selectedModel}`,
			`Reasoning: ${nextUserConfig.effort}`,
			`Read-only tools: ${nextUserConfig.tools.join(", ") || "none"}`,
			`Instructions: ${nextUserConfig.instructions.trim().length === 0 ? "none" : "set"}`,
			"",
			`Save atomically to ${loaded.paths.userYaml} and rebuild this session now?`,
			`Reference: ${CONFIGURATION_REFERENCE}`,
		].join("\n"),
	);
	if (!confirmed) return;
	try {
		await saveUserConfigurationAtomic(
			loaded.paths.userYaml,
			nextUserConfig,
			loaded.userUnknownTopLevel,
		);
	} catch {
		ctx.ui.notify(
			`Advisor configuration could not be saved to ${loaded.paths.userYaml}. The prior configuration remains active.`,
			"error",
		);
		return;
	}
	const applied = await loadAdvisorConfiguration({
		agentDir: getAgentDir(),
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
		fallbackUserConfig,
	});
	publishConfigurationWarnings(ctx, applied.warnings);
	await runtime.applyConfiguration(applied.effectiveConfig, ctx, applied.projectInstructions);
	ctx.ui.notify(
		`Advisor configuration saved and applied. Model: ${selectedModel}; reasoning: ${nextUserConfig.effort}; tools: ${nextUserConfig.tools.join(", ") || "none"}. External WATCHDOG edits require /reload or another /advisor configure apply. Reference: ${CONFIGURATION_REFERENCE}.`,
		"info",
	);
}

export function hasAdvisorCommandCollision(commands: readonly { name: string }[]): boolean {
	return (
		commands.filter((command) => command.name === "advisor" || /^advisor:\d+$/u.test(command.name))
			.length > 1
	);
}

const ADVISOR_FOOTER_STATUS_KEY = "pi-advisor";
const ADVISOR_REVIEW_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ADVISOR_REVIEW_SPINNER_INTERVAL_MS = 80;

function publishAdvisorFooterStatus(
	ctx: Parameters<AdvisorRuntime["startSession"]>[0] | undefined,
	status: Parameters<typeof formatAdvisorFooterStatus>[0] | undefined,
	frame?: string,
): boolean {
	if (ctx === undefined || status === undefined) return false;
	try {
		if (!ctx.hasUI) return false;
		const text = formatAdvisorFooterStatus(status);
		if (text === undefined) {
			ctx.ui.setStatus(ADVISOR_FOOTER_STATUS_KEY, undefined);
			return true;
		}
		const prefix = frame === undefined ? "" : `${ctx.ui.theme.fg("accent", frame)} `;
		ctx.ui.setStatus(ADVISOR_FOOTER_STATUS_KEY, `${prefix}${text}`);
		return true;
	} catch {
		// Keep runtime status publication independent from optional TUI rendering.
		return false;
	}
}

function installPiAdvisor(pi: ExtensionAPI, options: PiAdvisorExtensionOptions): void {
	const fallbackUserConfig = normalizeAdvisorConfig(
		structuredClone(options.config ?? DEFAULT_ADVISOR_CONFIG),
	);
	let statusContext: Parameters<AdvisorRuntime["startSession"]>[0] | undefined;
	let latestFooterStatus: Parameters<typeof formatAdvisorFooterStatus>[0] | undefined;
	let reviewSpinnerTimer: NodeJS.Timeout | undefined;
	let reviewSpinnerFrame = 0;
	const stopReviewSpinner = (): void => {
		if (reviewSpinnerTimer === undefined) return;
		clearInterval(reviewSpinnerTimer);
		reviewSpinnerTimer = undefined;
		reviewSpinnerFrame = 0;
	};
	const startReviewSpinner = (): void => {
		if (reviewSpinnerTimer !== undefined) return;
		reviewSpinnerTimer = setInterval(() => {
			reviewSpinnerFrame = (reviewSpinnerFrame + 1) % ADVISOR_REVIEW_SPINNER_FRAMES.length;
			const published = publishAdvisorFooterStatus(
				statusContext,
				latestFooterStatus,
				ADVISOR_REVIEW_SPINNER_FRAMES[reviewSpinnerFrame],
			);
			if (!published) stopReviewSpinner();
		}, ADVISOR_REVIEW_SPINNER_INTERVAL_MS);
		reviewSpinnerTimer.unref();
	};
	const runtime = new AdvisorRuntime(pi, fallbackUserConfig, {
		...options.hooks,
		onStatus: (status) => {
			latestFooterStatus = status;
			const animate = shouldAnimateAdvisorFooter(status, statusContext?.mode);
			if (animate) startReviewSpinner();
			else stopReviewSpinner();
			publishAdvisorFooterStatus(
				statusContext,
				status,
				animate ? ADVISOR_REVIEW_SPINNER_FRAMES[reviewSpinnerFrame] : undefined,
			);
			options.hooks?.onStatus?.(status);
		},
	});
	options.hooks?.onRuntime?.(runtime);

	pi.registerFlag("advisor", {
		description: "Enable Advisor for this session",
		type: "boolean",
		default: false,
	});

	pi.registerMessageRenderer(ADVISOR_CUSTOM_TYPE, renderAdviceMessage);
	pi.registerEntryRenderer(ADVISOR_LATE_ENTRY_TYPE, renderLateAdviceEntry);

	let coexistenceWarningPublished = false;
	pi.registerCommand("advisor", {
		description: "Control automatic Advisor review: configure, on, off, status, dump",
		handler: async (args, ctx) => {
			const command = args.trim().toLocaleLowerCase("en-US");
			if (command.length === 0 || command === "configure") {
				await configureAdvisor(ctx, runtime, fallbackUserConfig);
				return;
			}
			if (command === "on") {
				const previous = runtime.getStatus();
				const resetBudget = previous.paused;
				await runtime.enable(ctx, "session-command", resetBudget);
				ctx.ui.notify(
					formatAdvisorEnableStatus(previous, runtime.getStatus(), resetBudget),
					"info",
				);
				return;
			}
			if (command === "off") {
				await runtime.disable();
				ctx.ui.notify("Advisor is off for this session.", "info");
				return;
			}
			if (command === "status") {
				ctx.ui.notify(formatAdvisorStatusShort(runtime.getStatus()), "info");
				return;
			}
			if (command === "status full") {
				ctx.ui.notify(formatAdvisorStatus(runtime.getStatus()), "info");
				return;
			}
			if (command === "dump") {
				ctx.ui.notify(runtime.formatDiagnosticsDump(), "info");
				return;
			}
			if (command === "mute list") {
				const unavailable = runtime.mutesUnavailableReason();
				if (unavailable !== undefined) {
					ctx.ui.notify(
						`Mutes are unavailable: ${unavailable} No mute is active and the mutes file was not modified.`,
						"info",
					);
					return;
				}
				const mutes = runtime.muteList();
				ctx.ui.notify(
					mutes.length === 0
						? "No findings are muted."
						: mutes.map((mute) => `${mute.id} ${mute.label}`).join("\n"),
					"info",
				);
				return;
			}
			if (command.startsWith("mute ")) {
				const prefix = command.slice("mute ".length);
				if (!isHexPrefix(prefix)) {
					ctx.ui.notify(
						"Usage: /advisor mute <id> where <id> is an 8-to-64-character hex prefix of the findingKeyHash shown on an Advice card (for example /advisor mute a1b2c3d4).",
						"info",
					);
					return;
				}
				const resolved = runtime.resolveMuteTarget(prefix);
				if (resolved.kind === "unknown") {
					ctx.ui.notify(
						`No recent delivered finding matches ${prefix}. The recent-findings index keeps only the last 128 delivered findings, so older findings cannot be muted by ID.`,
						"info",
					);
				} else if (resolved.kind === "collision") {
					const uniquePrefixes = shortestUniquePrefixes(
						resolved.matches.map((match) => match.hash),
					);
					ctx.ui.notify(
						`Multiple recent findings match ${prefix}. Use one of these longer prefixes:\n${resolved.matches.map((match) => `${uniquePrefixes.get(match.hash) ?? match.hash.slice(0, 8)} ${match.label}`).join("\n")}`,
						"info",
					);
				} else {
					const result = await runtime.muteFinding(resolved.hash, resolved.label);
					ctx.ui.notify(
						result.message ?? `Muted ${resolved.hash.slice(0, 8)}.`,
						result.ok ? "info" : "warning",
					);
				}
				return;
			}
			if (command.startsWith("unmute ")) {
				const prefix = command.slice("unmute ".length);
				if (!isHexPrefix(prefix)) {
					ctx.ui.notify(
						"Usage: /advisor unmute <id> where <id> is an 8-to-64-character hex prefix of a muted findingKeyHash shown by /advisor mute list.",
						"info",
					);
					return;
				}
				const result = await runtime.unmuteFinding(prefix);
				ctx.ui.notify(result.message ?? "Unmuted.", result.ok ? "info" : "warning");
				return;
			}
			ctx.ui.notify(
				"Usage: /advisor configure | /advisor on | /advisor off | /advisor status [full] | /advisor dump | /advisor mute <id> | /advisor unmute <id> | /advisor mute list",
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		statusContext = ctx;
		if (!coexistenceWarningPublished && ctx.hasUI && hasAdvisorCommandCollision(pi.getCommands())) {
			coexistenceWarningPublished = true;
			ctx.ui.notify(
				"Multiple /advisor commands are installed. Pi assigned suffixed names such as /advisor:1 and /advisor:2. Pi Advisor will coexist without changing the other package; use the command list to choose one, or disable one package.",
				"warning",
			);
		}
		let configuredDefault = fallbackUserConfig.defaultEnabled;
		try {
			const loaded = await loadAdvisorConfiguration({
				agentDir: getAgentDir(),
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				fallbackUserConfig,
			});
			configuredDefault = loaded.effectiveConfig.defaultEnabled;
			runtime.setConfigurationBeforeSession(loaded.effectiveConfig, loaded.projectInstructions);
			publishConfigurationWarnings(ctx, loaded.warnings);
		} catch {
			configuredDefault = false;
			runtime.setConfigurationBeforeSession(DEFAULT_ADVISOR_CONFIG);
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Advisor WATCHDOG configuration could not be loaded. Advisor remains inactive with safe defaults.",
					"warning",
				);
			}
		}
		await runtime.startSession(ctx);
		const cliEnabled = pi.getFlag("advisor") === true;
		const defaultEnabled = configuredDefault && (ctx.mode === "tui" || ctx.mode === "rpc");
		if (cliEnabled) await runtime.enable(ctx, "cli-flag");
		else if (defaultEnabled) await runtime.enable(ctx, "user-default");
	});

	pi.on("before_agent_start", (event, ctx) => {
		const contextFiles = event.systemPromptOptions.contextFiles ?? [];
		runtime.captureContextFiles(contextFiles);
		const message = runtime.takeDeferredAdvice(ctx);
		return message === undefined ? undefined : { message };
	});

	pi.on("turn_end", (event, ctx) => {
		void runtime.observeTurn(event, ctx);
	});

	pi.on("message_end", (event) => {
		runtime.observeExecutorMessage(event.message);
	});

	pi.on("agent_settled", (_event, ctx) => runtime.settleActiveAdvice(ctx));
	pi.on("session_before_compact", (_event, ctx) => runtime.handleLifecycleHint(ctx));
	pi.on("session_compact", (_event, ctx) => runtime.handleBranchChange(ctx));
	pi.on("session_before_tree", (_event, ctx) => runtime.handleLifecycleHint(ctx));
	pi.on("session_tree", (_event, ctx) => runtime.handleBranchChange(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		stopReviewSpinner();
		latestFooterStatus = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(ADVISOR_FOOTER_STATUS_KEY, undefined);
		statusContext = undefined;
		await runtime.shutdown();
	});
}

export function createPiAdvisorExtension(
	options: PiAdvisorExtensionOptions = {},
): ExtensionFactory {
	return (pi) => {
		installPiAdvisor(pi, options);
	};
}

export default function piAdvisor(pi: ExtensionAPI): void {
	installPiAdvisor(pi, {});
}

export * from "./advice.js";
export * from "./config.js";
export * from "./configuration.js";
export * from "./delivery.js";
export * from "./model-picker.js";
export * from "./mutes.js";
export * from "./persistence.js";
export * from "./history-compaction.js";
export * from "./presentation.js";
export * from "./redaction.js";
export * from "./runtime.js";
export * from "./security.js";
export * from "./transcript.js";
