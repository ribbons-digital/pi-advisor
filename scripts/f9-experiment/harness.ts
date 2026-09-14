/**
 * Shared plumbing for the untracked F9 runners (run-context, run-accuracy,
 * run-compare). `run.ts` stays self-contained so `pnpm experiment:f9` works
 * from a clean clone. Per-experiment verdicts, corpus loaders and summarizers
 * stay in their own scripts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { calculateContextTokens } from "@earendil-works/pi-agent-core";

import { isFunctionValue } from "../../src/value-guards.js";

/** Usage of the last usable assistant turn, as recorded on result rows. */
export interface AssistantUsageView {
	tokens: number;
	costUsd: number;
	cachedTokens: number;
	inputTokens: number;
	responseModel?: string;
}

/**
 * Load a persisted JSONL results file for breakpoint resume.
 *
 * Resume must never silently re-run live (paid) reviews, so a missing file is
 * the only case that legitimately yields an empty set. Everything else fails
 * closed: a malformed line throws with its line number instead of degrading to
 * `[]`, which would make the harness re-run every already-completed pair and
 * spend the review budget a second time.
 *
 * The single tolerated shape is a torn final append, and it is detected
 * structurally rather than guessed: every row is written as
 * `appendFile(path, JSON.stringify(row) + "\n")`, so the newline is the write's
 * last byte. A file that ends WITH `\n` therefore has only complete rows, and
 * any parse failure in it is real corruption (fail closed). A file that does NOT
 * end with `\n` can only have been cut mid-append by a killed process, so that
 * one line is moved aside to `<path>.corrupt` (never trusted, never silently
 * dropped) and the validated prefix is returned — keeping documented
 * breakpoint-resume without ever re-billing a complete-but-corrupt row.
 */
export async function loadPersistedJsonl<T>(path: string, logPrefix: string): Promise<T[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		// A missing results file is a legitimate first run, not corruption.
		// SAFETY: node fs errors carry an optional `code`; a non-fs error yields
		// `undefined`, which simply fails the ENOENT check below.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${logPrefix} cannot read ${path}: ${message}`);
	}
	// Only an unterminated tail can be a torn append; a terminated file is
	// evidence that the last row completed, so its corruption is not recoverable.
	const tolerableTornTail = !raw.endsWith("\n");
	const lines = raw.split("\n");
	const lastContentIndex = lines.reduce(
		(last, line, index) => (line.trim().length > 0 ? index : last),
		-1,
	);
	const rows: T[] = [];
	for (let index = 0; index <= lastContentIndex; index++) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0) continue;
		try {
			// SAFETY: rows in this file are only ever written by this harness from its
			// own result type T; a row that does not match surfaces on field access.
			rows.push(JSON.parse(line) as T);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (tolerableTornTail && index === lastContentIndex) {
				const quarantinePath = `${path}.corrupt`;
				await writeFile(quarantinePath, lines.slice(index).join("\n"), "utf8");
				console.error(
					`${logPrefix} ${path}:${String(index + 1)} is not valid JSON (${message}); moved the torn tail to ${quarantinePath} and resuming from the ${String(rows.length)} validated rows.`,
				);
				return rows;
			}
			throw new Error(
				`${logPrefix} ${path}:${String(index + 1)} is not valid JSON (${message}); refusing to resume from a corrupt result file — starting fresh would re-spend the review budget on already-completed pairs.`,
			);
		}
	}
	return rows;
}

export function lastAssistantUsage(session: AgentSession): AssistantUsageView {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const result: AssistantUsageView = {
			tokens: calculateContextTokens(message.usage),
			costUsd: message.usage.cost.total,
			cachedTokens: message.usage.cacheRead,
			inputTokens: message.usage.input,
		};
		if (message.responseModel !== undefined) result.responseModel = message.responseModel;
		else if (message.model.length > 0) result.responseModel = message.model;
		return result;
	}
	return { tokens: 0, costUsd: 0, cachedTokens: 0, inputTokens: 0 };
}

/**
 * Load the user provider extension whose directory name matches the configured
 * model's provider id (for example `vibeproxy` for `vibeproxy/claude-opus-4-8`)
 * so the configured Advisor model can resolve with real credentials.
 *
 * Requires the explicit opt-in env flag
 * `PI_ADVISOR_EXPERIMENT_PROVIDER_EXTENSION=<providerId>` that names exactly
 * the extension to execute: the extension runs with full process permissions
 * outside Pi's normal loading path, so naming a provider in the WATCHDOG
 * configuration alone never triggers execution. Only that single extension is
 * executed, only its provider registration is forwarded into the experiment
 * model runtime, and the provider id must be a plain single-segment directory
 * name. Returns the provider ids that were registered.
 */
export async function registerUserProviderExtensions(
	agentDir: string,
	providerId: string,
	modelRuntime: ModelRuntime,
	logPrefix: string,
): Promise<string[]> {
	if (process.env.PI_ADVISOR_EXPERIMENT_PROVIDER_EXTENSION !== providerId) {
		console.warn(
			`[${logPrefix}] the configured provider ${providerId} is not available from the built-in runtime. Set PI_ADVISOR_EXPERIMENT_PROVIDER_EXTENSION=${providerId} to load its extension from ${join(agentDir, "extensions", providerId)} after reviewing the extension source.`,
		);
		return [];
	}
	// The provider id comes from the User WATCHDOG configuration, so it must be
	// a plain single-segment directory name before it is used to build a path.
	if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(providerId)) {
		console.warn(
			`[${logPrefix}] refusing to load a provider extension for unsafe provider id ${JSON.stringify(providerId)}`,
		);
		return [];
	}
	const extensionsDir = join(agentDir, "extensions");
	const entryPath = join(extensionsDir, providerId, "index.ts");
	if (!entryPath.startsWith(`${extensionsDir}${sep}`)) return [];
	try {
		interface ProviderRegistrationApi {
			registerProvider(
				registeredProviderId: string,
				config: Parameters<ModelRuntime["registerProvider"]>[1],
			): void;
			registerCommand(): void;
			on(): void;
		}
		// SAFETY: dynamic provider modules are validated for a callable default before execution.
		const module = (await import(pathToFileURL(entryPath).href)) as {
			default?: (pi: ProviderRegistrationApi) => Promise<void> | void;
		};
		if (!isFunctionValue(module.default)) return [];
		console.warn(
			`[${logPrefix}] executing user extension ${providerId} outside Pi's extension loading path to resolve the configured provider. Review the extension source before running this experiment.`,
		);
		const adapter: ProviderRegistrationApi = {
			registerProvider: (
				registeredProviderId: string,
				config: Parameters<ModelRuntime["registerProvider"]>[1],
			) => {
				modelRuntime.registerProvider(registeredProviderId, config);
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
			`[${logPrefix}] provider extension ${providerId} could not load: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}
