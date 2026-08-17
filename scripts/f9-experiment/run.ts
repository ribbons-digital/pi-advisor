/**
 * F9 tiered-prompt evaluation harness (protocol approved 2026-08-16).
 *
 * Run: `pnpm experiment:f9` (uses the configured Advisor model from the User
 * WATCHDOG configuration; requires live provider credentials).
 *
 * Protocol:
 * - Fixed dataset of 26 representative updates from `dataset.ts`.
 * - Each update runs once with the baseline prompt and once with the tiered
 *   prompt, same configured model and effort for both arms.
 * - Metrics: note quality (note mentions an expected defect term), false
 *   positive rate (note delivered when silence is correct), silence
 *   correctness (no note when silence is correct).
 * - Budget ceilings: 1,000,000 review tokens and $25, enforced through the
 *   existing `limits.sessionTokenSoftCap` and `limits.sessionCostSoftCapUsd`
 *   fields; crossing either stops the experiment.
 * - No new configuration fields. The tiered prompt is selected by the
 *   non-public internal flag `PI_ADVISOR_TIERED_PROMPT_EXPERIMENT=1` in the
 *   runtime; this harness builds both prompt arms directly.
 * - The evaluation note is written to `docs/f9-evaluation.md`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-agent-core";

import { createAdviseTool, type AdviceCollector } from "../../src/advice.js";
import { loadAdvisorConfiguration } from "../../src/configuration.js";
import { DEFAULT_ADVISOR_CONFIG } from "../../src/config.js";
import {
	buildTieredAdvisorSystemPrompt,
	tieredPromptUpdateRelevance,
} from "../../src/experiment.js";
import { buildAdvisorSystemPrompt } from "../../src/runtime.js";
import { F9_DATASET, type F9DatasetExpectation } from "./dataset.js";

const REVIEW_TOKEN_CEILING = 1_000_000;
const COST_CEILING_USD = 25;

interface RunResult {
	itemId: string;
	arm: "baseline" | "tiered";
	note?: string;
	severity?: string;
	truncated?: boolean;
	stopReason: string;
	errorMessage?: string;
	verdict: "hit" | "miss" | "false-positive" | "silence-correct" | "run-error";
	tokens: number;
	costUsd: number;
	responseModel?: string;
}

interface AssistantUsage {
	tokens: number;
	costUsd: number;
	responseModel?: string;
}

interface EvaluationNoteInput {
	modelReference: string;
	responseModels: Set<string>;
	results: readonly RunResult[];
	summaries: ReturnType<typeof summarize>[];
	stoppedEarly: boolean;
	reason?: string;
}

function verdictFor(
	note: string | undefined,
	expectation: F9DatasetExpectation,
): RunResult["verdict"] {
	if (expectation.kind === "silence") {
		return note === undefined ? "silence-correct" : "false-positive";
	}
	if (note === undefined) return "miss";
	const normalized = note.toLocaleLowerCase("en-US");
	return expectation.terms.some((term) => normalized.includes(term.toLocaleLowerCase("en-US")))
		? "hit"
		: "miss";
}

function lastAssistantUsage(session: AgentSession) {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role !== "assistant") continue;
		const assistant = message;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
		const tokens = calculateContextTokens(assistant.usage);
		const usage: AssistantUsage = {
			tokens,
			costUsd: assistant.usage.cost.total,
		};
		if (assistant.responseModel !== undefined) usage.responseModel = assistant.responseModel;
		else if (assistant.model.length > 0) usage.responseModel = assistant.model;
		return usage;
	}
	return { tokens: 0, costUsd: 0 };
}

async function runArm(options: {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	model: Model<string>;
	prompt: string;
	update: string;
	expectation: F9DatasetExpectation;
	itemId: string;
	arm: "baseline" | "tiered";
}): Promise<RunResult> {
	const collector: AdviceCollector = {
		validCalls: 0,
		suppressedCalls: 0,
		memoryPolicySuppressedCalls: 0,
		memoryLimitSuppressedCalls: 0,
	};
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.model = `${options.model.provider}/${options.model.id}`;
	config.limits.sessionTokenSoftCap = REVIEW_TOKEN_CEILING;
	config.limits.sessionCostSoftCapUsd = COST_CEILING_USD;
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => options.prompt,
		appendSystemPromptOverride: () => [],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(options.cwd);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime: options.modelRuntime,
		model: options.model,
		thinkingLevel: "off",
		resourceLoader,
		sessionManager,
		settingsManager,
		customTools: [createAdviseTool(config, collector)],
		tools: ["advise"],
	});
	try {
		await session.prompt(`<advisor-update>\n${options.update}\n</advisor-update>`, {
			expandPromptTemplates: false,
			source: "extension",
		});
		const usage = lastAssistantUsage(session);
		const accepted = collector.accepted;
		const last = session.messages.at(-1);
		const lastAssistant = last?.role === "assistant" ? last : undefined;
		if (
			lastAssistant !== undefined &&
			(lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")
		) {
			return {
				itemId: options.itemId,
				arm: options.arm,
				stopReason: lastAssistant.stopReason,
				errorMessage: lastAssistant.errorMessage ?? "provider request failed",
				verdict: "run-error" as const,
				tokens: 0,
				costUsd: 0,
			};
		}
		const result: RunResult = {
			itemId: options.itemId,
			arm: options.arm,
			stopReason: lastAssistant?.stopReason ?? "unknown",
			verdict: verdictFor(accepted?.note, options.expectation),
			tokens: usage.tokens,
			costUsd: usage.costUsd,
		};
		if (accepted !== undefined) {
			result.note = accepted.note;
			result.truncated = accepted.truncated;
		}
		if (accepted?.intent === "review") result.severity = accepted.severity;
		if (usage.responseModel !== undefined) result.responseModel = usage.responseModel;
		return result;
	} finally {
		session.dispose();
	}
}

function summarize(results: readonly RunResult[], arm: "baseline" | "tiered") {
	const armResults = results.filter((result) => result.arm === arm);
	const silenceItems = armResults.filter(
		(result) =>
			F9_DATASET.find((item) => item.id === result.itemId)?.expectation.kind === "silence",
	);
	const silenceCorrect = silenceItems.filter(
		(result) => result.verdict === "silence-correct",
	).length;
	const falsePositives = silenceItems.filter(
		(result) => result.verdict === "false-positive",
	).length;
	const findingItems = armResults.filter(
		(result) =>
			F9_DATASET.find((item) => item.id === result.itemId)?.expectation.kind === "finding",
	);
	const hits = findingItems.filter((result) => result.verdict === "hit").length;
	const tokens = armResults.reduce((sum, result) => sum + result.tokens, 0);
	const costUsd = armResults.reduce((sum, result) => sum + result.costUsd, 0);
	return {
		arm,
		items: armResults.length,
		silenceCorrect,
		silenceItems: silenceItems.length,
		silenceCorrectRate: silenceItems.length === 0 ? 0 : silenceCorrect / silenceItems.length,
		falsePositives,
		falsePositiveRate: silenceItems.length === 0 ? 0 : falsePositives / silenceItems.length,
		hits,
		findingItems: findingItems.length,
		findingHitRate: findingItems.length === 0 ? 0 : hits / findingItems.length,
		tokens,
		costUsd,
	};
}

async function writeEvaluationNote(options: EvaluationNoteInput): Promise<string> {
	const { results, summaries } = options;
	const rows = results
		.map((result) => {
			const expectation = F9_DATASET.find((item) => item.id === result.itemId)?.expectation;
			const expected = expectation?.kind === "finding" ? expectation.terms.join(", ") : "silence";
			const detail =
				result.verdict === "run-error"
					? `run error: ${result.errorMessage ?? result.stopReason}`
					: (result.note ?? "(silence)").replaceAll("\n", " ");
			return `| ${result.itemId} | ${result.arm} | ${result.verdict} | ${expected.replaceAll("|", "\\|")} | ${detail.slice(0, 140).replaceAll("|", "\\|")} |`;
		})
		.join("\n");
	const summary = summaries
		.map(
			(summary) =>
				`| ${summary.arm} | ${String(summary.silenceCorrect)}/${String(summary.silenceItems)} | ${(summary.silenceCorrectRate * 100).toFixed(1)}% | ${(summary.falsePositiveRate * 100).toFixed(1)}% | ${String(summary.hits)}/${String(summary.findingItems)} | ${(summary.findingHitRate * 100).toFixed(1)}% | ${String(summary.tokens)} | $${summary.costUsd.toFixed(4)} |`,
		)
		.join("\n");
	const totalTokens = summaries.reduce((sum, summary) => sum + summary.tokens, 0);
	const totalCost = summaries.reduce((sum, summary) => sum + summary.costUsd, 0);
	const note = `# F9 tiered-prompt experiment evaluation note

Status: ${options.stoppedEarly ? `stopped early: ${options.reason ?? "budget ceiling reached"}` : "completed"}.
This experiment never ships as default behavior without measurement review and separate user approval.

## Protocol (approved 2026-08-16)

- Fixed dataset: ${String(F9_DATASET.length)} representative updates in \`scripts/f9-experiment/dataset.ts\`.
- Each update runs once with the baseline prompt and once with the tiered prompt (core rules always present; chronology and memory rule blocks included only when the update text is relevant to them).
- Same configured model and effort for both arms; exact provider-reported model recorded per run.
- Metrics: note quality (note mentions an expected defect term), false-positive rate, silence correctness.
- Budget ceilings: ${String(REVIEW_TOKEN_CEILING)} review tokens and $${String(COST_CEILING_USD)}, enforced through the existing \`limits.sessionTokenSoftCap\` and \`limits.sessionCostSoftCapUsd\` fields; crossing either stops the experiment.
- When the configured provider reports zero cost (for example a local proxy), the dollar ceiling cannot trip and the token ceiling is the effective budget bound.
- Scripted fixture providers cannot measure model judgment, so this evaluation uses bounded live-model runs under the ceilings above.

## Model identity

Configured model: \`${options.modelReference}\`.
Provider-reported response models: ${[...options.responseModels].join(", ") || "(none recorded)"}.

## Aggregate results

| Arm | Silence correct | Silence-correct rate | False-positive rate | Finding hits | Finding-hit rate | Tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
${summary}

Total: ${String(totalTokens)} tokens, $${totalCost.toFixed(4)}.

## Per-run results

| Item | Arm | Verdict | Expected | Note (truncated) |
| --- | --- | --- | --- | --- |
${rows}

## Reading

- A higher silence-correct rate and a lower false-positive rate on the tiered arm support the F9 hypothesis that the conditional rule blocks reduce distraction on updates where they are irrelevant.
- A lower finding-hit rate on the tiered arm would indicate that the omitted blocks carry material review value.
- A single run on this 26-item dataset is subject to model variance; the arms swapped positions between two consecutive runs, so the observed deltas are within noise and do not justify shipping the tiered prompt. Multiple runs (or a larger dataset) are required before a measurement-based decision.
- The tiered prompt is selected in the runtime only by the non-public internal flag \`PI_ADVISOR_TIERED_PROMPT_EXPERIMENT=1\` and changes nothing when the flag is off.
- No configuration fields were added.
`;
	const path = join("docs", "f9-evaluation.md");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, note, "utf8");
	return path;
}

/**
 * Loads the user provider extension whose directory name matches the
 * configured model's provider id (for example `vibeproxy` for
 * `vibeproxy/claude-opus-4-8`) so the configured Advisor model can resolve
 * with real credentials. Loading requires the explicit opt-in env flag
 * `PI_ADVISOR_EXPERIMENT_PROVIDER_EXTENSION=<providerId>` that names exactly
 * the extension to execute, because the extension runs with full process
 * permissions outside Pi's normal extension loading path; naming a provider
 * in the WATCHDOG configuration alone never triggers execution. Only that
 * single extension is executed, only its provider registration is forwarded
 * into the experiment model runtime, and the provider id must be a plain
 * single-segment directory name.
 */
async function registerUserProviderExtensions(
	agentDir: string,
	providerId: string,
	modelRuntime: ModelRuntime,
): Promise<string[]> {
	if (process.env.PI_ADVISOR_EXPERIMENT_PROVIDER_EXTENSION !== providerId) {
		console.warn(
			`[f9] the configured provider ${providerId} is not available from the built-in runtime. Set PI_ADVISOR_EXPERIMENT_PROVIDER_EXTENSION=${providerId} to load its extension from ${join(agentDir, "extensions", providerId)} after reviewing the extension source.`,
		);
		return [];
	}
	// The provider id comes from the User WATCHDOG configuration, so it must be
	// a plain single-segment directory name before it is used to build a path.
	if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(providerId)) {
		console.warn(
			`[f9] refusing to load a provider extension for unsafe provider id ${JSON.stringify(providerId)}`,
		);
		return [];
	}
	const extensionsDir = join(agentDir, "extensions");
	const entryPath = join(extensionsDir, providerId, "index.ts");
	if (!entryPath.startsWith(`${extensionsDir}${sep}`)) return [];
	try {
		interface ProviderRegistrationApi {
			registerProvider(registeredProviderId: string, config: unknown): void;
			registerCommand(): void;
			on(): void;
		}
		const module = (await import(pathToFileURL(entryPath).href)) as {
			default?: (pi: ProviderRegistrationApi) => Promise<void> | void;
		};
		if (typeof module.default !== "function") return [];
		console.warn(
			`[f9] executing user extension ${providerId} outside Pi's extension loading path to resolve the configured provider. Review the extension source before running this experiment.`,
		);
		const adapter: ProviderRegistrationApi = {
			registerProvider: (registeredProviderId: string, config: unknown) => {
				modelRuntime.registerProvider(
					registeredProviderId,
					config as Parameters<ModelRuntime["registerProvider"]>[1],
				);
			},
			registerCommand: () => {
				// The experiment harness needs only provider registration.
			},
			on: () => {
				// Event hooks are irrelevant to provider registration.
			},
		};
		await Promise.resolve(module.default(adapter));
		return [providerId];
	} catch (error) {
		console.warn(
			`[f9] provider extension ${providerId} could not load: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

async function main(): Promise<void> {
	const agentDir = getAgentDir();
	const cwd = process.cwd();
	const loaded = await loadAdvisorConfiguration({
		agentDir,
		cwd,
		projectTrusted: false,
		fallbackUserConfig: DEFAULT_ADVISOR_CONFIG,
	});
	const modelReference = loaded.effectiveConfig.model;
	if (modelReference === undefined) {
		console.error(
			"F9 experiment requires a configured Advisor model in the User WATCHDOG configuration (~/.pi/agent/WATCHDOG.yml). No model is configured; the experiment was not run.",
		);
		process.exitCode = 1;
		return;
	}
	const separator = modelReference.indexOf("/");
	const providerId = separator < 0 ? modelReference : modelReference.slice(0, separator);
	const modelId = separator < 0 ? modelReference : modelReference.slice(separator + 1);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: true,
	});
	const registry = new ModelRegistry(modelRuntime);
	let available = registry.getAvailable();
	if (!available.some((model) => `${model.provider}/${model.id}` === modelReference)) {
		const providerId = modelReference.slice(0, modelReference.indexOf("/"));
		const loaded = await registerUserProviderExtensions(agentDir, providerId, modelRuntime);
		if (loaded.length > 0) {
			console.log(`[f9] loaded provider extension: ${loaded.join(", ")}`);
			await registry.refresh();
			available = registry.getAvailable();
		}
	}
	if (!available.some((model) => `${model.provider}/${model.id}` === modelReference)) {
		console.error(
			`F9 experiment could not resolve an authenticated model for ${modelReference}. The experiment was not run.`,
		);
		process.exitCode = 1;
		return;
	}
	const model = modelRuntime.getModel(providerId, modelId);
	if (model === undefined) {
		console.error(
			`F9 experiment could not find model ${modelReference}. The experiment was not run.`,
		);
		process.exitCode = 1;
		return;
	}

	const results: RunResult[] = [];
	const responseModels = new Set<string>();
	let totalTokens = 0;
	let totalCostUsd = 0;
	let stoppedEarly = false;
	let stopReason: string | undefined;
	let consecutiveErrors = 0;
	for (const item of F9_DATASET) {
		for (const arm of ["baseline", "tiered"] as const) {
			const prompt =
				arm === "baseline"
					? buildAdvisorSystemPrompt(loaded.effectiveConfig, "")
					: buildTieredAdvisorSystemPrompt(loaded.effectiveConfig, item.update, "");
			console.log(
				`[f9] ${item.id} ${arm} (relevance chronology=${String(tieredPromptUpdateRelevance(item.update).chronology)}, memory=${String(tieredPromptUpdateRelevance(item.update).memory)})`,
			);
			try {
				const result = await runArm({
					cwd,
					agentDir,
					modelRuntime,
					model,
					prompt,
					update: item.update,
					expectation: item.expectation,
					itemId: item.id,
					arm,
				});
				results.push(result);
				if (result.verdict === "run-error") {
					consecutiveErrors++;
					console.error(`  -> run error: ${result.errorMessage ?? result.stopReason}`);
					if (consecutiveErrors >= 3) {
						stoppedEarly = true;
						stopReason = `provider request failed 3 times in a row (last: ${result.errorMessage ?? result.stopReason}); upstream availability or rate limits`;
						break;
					}
				} else {
					consecutiveErrors = 0;
					totalTokens += result.tokens;
					totalCostUsd += result.costUsd;
					if (result.responseModel !== undefined) responseModels.add(result.responseModel);
					console.log(
						`  -> ${result.verdict}${result.note === undefined ? "" : `: ${result.note.slice(0, 120)}`} (${String(result.tokens)} tokens, $${result.costUsd.toFixed(4)})`,
					);
				}
			} catch (error) {
				results.push({
					itemId: item.id,
					arm,
					stopReason: "thrown",
					errorMessage: error instanceof Error ? error.message : String(error),
					verdict: "run-error",
					tokens: 0,
					costUsd: 0,
				});
				consecutiveErrors++;
				console.error(`  -> run error: ${error instanceof Error ? error.message : String(error)}`);
				if (consecutiveErrors >= 3) {
					stoppedEarly = true;
					stopReason = `provider request failed 3 times in a row (last: ${error instanceof Error ? error.message : String(error)}); upstream availability or rate limits`;
					break;
				}
			}
			if (totalTokens >= REVIEW_TOKEN_CEILING || totalCostUsd >= COST_CEILING_USD) {
				stoppedEarly = true;
				stopReason = `budget ceiling reached at ${String(totalTokens)} tokens / $${totalCostUsd.toFixed(4)}`;
				break;
			}
		}
		if (stoppedEarly) break;
	}
	const summaries = [summarize(results, "baseline"), summarize(results, "tiered")];
	const evaluation: EvaluationNoteInput = {
		modelReference,
		responseModels,
		results,
		summaries,
		stoppedEarly,
	};
	if (stopReason !== undefined) evaluation.reason = stopReason;
	const path = await writeEvaluationNote(evaluation);
	console.log("");
	for (const summary of summaries) {
		console.log(
			`[f9] ${summary.arm}: silence ${String(summary.silenceCorrect)}/${String(summary.silenceItems)} (fp ${(summary.falsePositiveRate * 100).toFixed(1)}%), findings ${String(summary.hits)}/${String(summary.findingItems)} (${(summary.findingHitRate * 100).toFixed(1)}%), ${String(summary.tokens)} tokens, $${summary.costUsd.toFixed(4)}`,
		);
	}
	console.log(`[f9] evaluation note written to ${path}`);
	if (stoppedEarly) console.log(`[f9] ${stopReason ?? "stopped early"}`);
}

await main();
