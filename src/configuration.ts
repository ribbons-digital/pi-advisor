import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Compile } from "typebox/compile";
import { Type } from "typebox";
import { parse, stringify } from "yaml";

import {
	ADVISOR_CONFIG_VERSION,
	DEFAULT_ADVISOR_CONFIG,
	HARD_LIMITS,
	normalizeAdvisorConfig,
	READ_ONLY_TOOL_NAMES,
	type AdvisorConfig,
	type AdvisorProjectConfig,
	type ReadOnlyToolName,
} from "./config.js";
import { redactSecrets, truncateUtf8Bytes } from "./redaction.js";
import { isRecordValue } from "./value-guards.js";

export const WATCHDOG_YAML_NAME = "WATCHDOG.yml";
export const WATCHDOG_MARKDOWN_NAME = "WATCHDOG.md";
export const MAX_WATCHDOG_YAML_BYTES = 1_048_576;
export const MAX_WATCHDOG_MARKDOWN_BYTES = 65_536;
export const MAX_PRESERVED_UNKNOWN_CONFIG_BYTES = 65_536;

const effortValues = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const toolValues = ["read", "grep", "find", "ls"] as const;

const ContextSchema = Type.Object(
	{
		maxFraction: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1 })),
		reserveTokens: Type.Optional(Type.Number({ minimum: 0 })),
		maxUpdateTokens: Type.Optional(Type.Number({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
const LimitsSchema = Type.Object(
	{
		maxAdviceCharacters: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxAdviceCharacters }),
		),
		maxAdviceTokens: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxAdviceTokens }),
		),
		maxAdvisorTurnsPerUpdate: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxAdvisorTurnsPerUpdate }),
		),
		maxToolCallsPerUpdate: Type.Optional(
			Type.Number({ minimum: 0, maximum: HARD_LIMITS.maxToolCallsPerUpdate }),
		),
		maxPendingTranscriptBytes: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxPendingTranscriptBytes }),
		),
		maxReprimeTokens: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxReprimeTokens }),
		),
		minTurnsBetweenReviews: Type.Optional(Type.Number({ minimum: 1 })),
		minIntervalMs: Type.Optional(Type.Number({ minimum: 0 })),
		deferredAdviceRetentionHours: Type.Optional(Type.Number({ minimum: 0 })),
		sessionTokenSoftCap: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Number({ minimum: 1 })]),
		),
		sessionCostSoftCapUsd: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Number({ exclusiveMinimum: 0 })]),
		),
		maxReviewAttemptMs: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxReviewAttemptMs }),
		),
		maxNestedCompactionMs: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxNestedCompactionMs }),
		),
		maxLifecycleAbortMs: Type.Optional(
			Type.Number({ minimum: 0, maximum: HARD_LIMITS.maxLifecycleAbortMs }),
		),
	},
	{ additionalProperties: false },
);
const SecuritySchema = Type.Object(
	{
		additionalProtectedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		protectedPathExceptions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	},
	{ additionalProperties: false },
);
const MemorySchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		minTurnsBetweenSuggestions: Type.Optional(Type.Number({ minimum: 0 })),
		minIntervalMs: Type.Optional(Type.Number({ minimum: 0 })),
		sessionSuggestionCap: Type.Optional(Type.Number({ minimum: 0 })),
		maxProposedMemoryCharacters: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxProposedMemoryCharacters }),
		),
		maxProposedMemoryTokens: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxProposedMemoryTokens }),
		),
	},
	{ additionalProperties: false },
);
const DeliverySchema = Type.Object(
	{
		activeIdleSeverities: Type.Optional(
			Type.Array(Type.Union([Type.Literal("concern"), Type.Literal("blocker")])),
		),
	},
	{ additionalProperties: false },
);
const AdaptiveCadenceSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		silentReviewsBeforeBackOff: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.silentReviewsBeforeBackOff }),
		),
		backOffTurnStep: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.backOffTurnStep }),
		),
		maxMinTurnsBetweenReviews: Type.Optional(
			Type.Number({ minimum: 1, maximum: HARD_LIMITS.maxMinTurnsBetweenReviews }),
		),
	},
	{ additionalProperties: false },
);
const ReviewSchema = Type.Object(
	{
		skipNonMaterialTurns: Type.Optional(Type.Boolean()),
		adaptiveCadence: Type.Optional(AdaptiveCadenceSchema),
	},
	{ additionalProperties: false },
);
const DedupeSchema = Type.Object(
	{
		similarityRedeliveryThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		reRaiseMinTurns: Type.Optional(
			Type.Number({ minimum: 0, maximum: HARD_LIMITS.reRaiseMinTurns }),
		),
	},
	{ additionalProperties: false },
);
const UserSchema = Type.Object(
	{
		version: Type.Literal(ADVISOR_CONFIG_VERSION),
		defaultEnabled: Type.Optional(Type.Boolean()),
		model: Type.Optional(Type.String({ pattern: "^[^/\\s]+/.+$" })),
		effort: Type.Optional(Type.Union(effortValues.map((value) => Type.Literal(value)))),
		tools: Type.Optional(Type.Array(Type.Union(toolValues.map((value) => Type.Literal(value))))),
		instructions: Type.Optional(Type.String()),
		context: Type.Optional(ContextSchema),
		limits: Type.Optional(LimitsSchema),
		security: Type.Optional(SecuritySchema),
		delivery: Type.Optional(DeliverySchema),
		review: Type.Optional(ReviewSchema),
		dedupe: Type.Optional(DedupeSchema),
		memorySuggestions: Type.Optional(MemorySchema),
		persistence: Type.Optional(
			Type.Object({ transcript: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);
const ProjectSchema = Type.Object(
	{
		version: Type.Literal(ADVISOR_CONFIG_VERSION),
		instructions: Type.Optional(Type.String()),
		tools: Type.Optional(Type.Array(Type.Union(toolValues.map((value) => Type.Literal(value))))),
		context: Type.Optional(ContextSchema),
		limits: Type.Optional(LimitsSchema),
		security: Type.Optional(
			Type.Object(
				{ additionalProtectedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) },
				{ additionalProperties: false },
			),
		),
		delivery: Type.Optional(DeliverySchema),
		review: Type.Optional(ReviewSchema),
		dedupe: Type.Optional(DedupeSchema),
		memorySuggestions: Type.Optional(MemorySchema),
	},
	{ additionalProperties: false },
);

const userValidator = Compile(UserSchema);
const projectValidator = Compile(ProjectSchema);

interface ValidatedUserDocument {
	version: AdvisorConfig["version"];
	defaultEnabled?: boolean;
	model?: string;
	effort?: AdvisorConfig["effort"];
	tools?: AdvisorConfig["tools"];
	instructions?: string;
	context?: Partial<AdvisorConfig["context"]>;
	limits?: Partial<AdvisorConfig["limits"]>;
	security?: Partial<AdvisorConfig["security"]>;
	delivery?: Partial<AdvisorConfig["delivery"]>;
	review?: Partial<Omit<AdvisorConfig["review"], "adaptiveCadence">> & {
		adaptiveCadence?: Partial<AdvisorConfig["review"]["adaptiveCadence"]>;
	};
	dedupe?: Partial<AdvisorConfig["dedupe"]>;
	memorySuggestions?: Partial<AdvisorConfig["memorySuggestions"]>;
	persistence?: Partial<AdvisorConfig["persistence"]>;
}

type ConfigFieldName = keyof ValidatedUserDocument;

interface UnvalidatedConfigRecord {
	version?: unknown;
	defaultEnabled?: unknown;
	model?: unknown;
	effort?: unknown;
	tools?: unknown;
	instructions?: unknown;
	context?: unknown;
	limits?: unknown;
	security?: unknown;
	delivery?: unknown;
	review?: unknown;
	dedupe?: unknown;
	memorySuggestions?: unknown;
	persistence?: unknown;
	adaptiveCadence?: unknown;
	enabled?: unknown;
	skipNonMaterialTurns?: unknown;
}

const USER_KEY_NAMES: readonly ConfigFieldName[] = [
	"version",
	"defaultEnabled",
	"model",
	"effort",
	"tools",
	"instructions",
	"context",
	"limits",
	"security",
	"delivery",
	"review",
	"dedupe",
	"memorySuggestions",
	"persistence",
];
const PROJECT_KEY_NAMES: readonly ConfigFieldName[] = [
	"version",
	"instructions",
	"tools",
	"context",
	"limits",
	"security",
	"delivery",
	"review",
	"dedupe",
	"memorySuggestions",
];
const USER_KEYS: ReadonlySet<string> = new Set(USER_KEY_NAMES);
const PROJECT_KEYS: ReadonlySet<string> = new Set(PROJECT_KEY_NAMES);
const CONTEXT_KEYS = new Set(["maxFraction", "reserveTokens", "maxUpdateTokens"]);
const LIMIT_KEYS = new Set(Object.keys(DEFAULT_ADVISOR_CONFIG.limits));
const SECURITY_USER_KEYS = new Set(["additionalProtectedPaths", "protectedPathExceptions"]);
const SECURITY_PROJECT_KEYS = new Set(["additionalProtectedPaths"]);
const DELIVERY_KEYS = new Set(["activeIdleSeverities"]);
const REVIEW_KEYS = new Set(["skipNonMaterialTurns", "adaptiveCadence"]);
const DEDUPE_KEYS = new Set(["similarityRedeliveryThreshold", "reRaiseMinTurns"]);
const ADAPTIVE_CADENCE_KEYS = new Set([
	"enabled",
	"silentReviewsBeforeBackOff",
	"backOffTurnStep",
	"maxMinTurnsBetweenReviews",
]);
const MEMORY_KEYS = new Set(Object.keys(DEFAULT_ADVISOR_CONFIG.memorySuggestions));
const PERSISTENCE_KEYS = new Set(["transcript"]);

export interface ConfigurationWarning {
	source: "user" | "project";
	path: string;
	message: string;
}

export interface LoadedAdvisorConfiguration {
	userConfig: AdvisorConfig;
	effectiveConfig: AdvisorConfig;
	projectInstructions: string;
	warnings: ConfigurationWarning[];
	paths: ReturnType<typeof advisorConfigurationPaths>;
	userUnknownTopLevel?: Record<string, unknown>;
}

export function advisorConfigurationPaths(agentDir: string, cwd: string) {
	return {
		userYaml: join(agentDir, WATCHDOG_YAML_NAME),
		userMarkdown: join(agentDir, WATCHDOG_MARKDOWN_NAME),
		projectYaml: join(cwd, ".pi", WATCHDOG_YAML_NAME),
		projectMarkdown: join(cwd, ".pi", WATCHDOG_MARKDOWN_NAME),
	};
}

function isRecord<T>(value: T): value is T & UnvalidatedConfigRecord {
	return isRecordValue<UnvalidatedConfigRecord, T>(value);
}

function collectUnknownWarnings(
	value: Parameters<typeof isRecord>[0],
	source: "user" | "project",
	warnings: ConfigurationWarning[],
): void {
	if (!isRecord(value)) return;
	const topKeys = source === "user" ? USER_KEYS : PROJECT_KEYS;
	for (const key of Object.keys(value)) {
		if (!topKeys.has(key)) {
			warnings.push({
				source,
				path: key,
				message:
					source === "project"
						? `Project field ${key} is not permitted and was ignored.`
						: `Unknown User field ${key} was ignored.`,
			});
		}
	}
	const nested: [ConfigFieldName, Set<string>][] = [
		["context", CONTEXT_KEYS],
		["limits", LIMIT_KEYS],
		["security", source === "user" ? SECURITY_USER_KEYS : SECURITY_PROJECT_KEYS],
		["delivery", DELIVERY_KEYS],
		["review", REVIEW_KEYS],
		["dedupe", DEDUPE_KEYS],
		["memorySuggestions", MEMORY_KEYS],
	];
	if (source === "user") nested.push(["persistence", PERSISTENCE_KEYS]);
	for (const [name, keys] of nested) {
		const candidate = value[name];
		if (!isRecord(candidate)) continue;
		if (
			source === "project" &&
			name === "memorySuggestions" &&
			Object.hasOwn(candidate, "enabled") &&
			candidate.enabled !== false
		) {
			warnings.push({
				source,
				path: "memorySuggestions.enabled",
				message:
					"Project field memorySuggestions.enabled cannot re-enable User-disabled behavior and was ignored.",
			});
		}
		if (
			source === "project" &&
			name === "review" &&
			Object.hasOwn(candidate, "skipNonMaterialTurns") &&
			candidate.skipNonMaterialTurns !== true
		) {
			warnings.push({
				source,
				path: "review.skipNonMaterialTurns",
				message:
					"Project field review.skipNonMaterialTurns cannot disable User-enabled behavior and was ignored.",
			});
		}
		for (const key of Object.keys(candidate)) {
			if (!keys.has(key)) {
				const path = `${name}.${key}`;
				warnings.push({
					source,
					path,
					message:
						source === "project"
							? `Project field ${path} is not permitted and was ignored.`
							: `Unknown User field ${path} was ignored.`,
				});
			}
		}
		if (name === "review" && isRecord(candidate.adaptiveCadence)) {
			const adaptive = candidate.adaptiveCadence;
			if (source === "project" && Object.hasOwn(adaptive, "enabled") && adaptive.enabled !== true) {
				warnings.push({
					source,
					path: "review.adaptiveCadence.enabled",
					message:
						"Project field review.adaptiveCadence.enabled cannot disable User-enabled behavior and was ignored.",
				});
			}
			if (source === "project" && Object.hasOwn(adaptive, "backOffTurnStep")) {
				warnings.push({
					source,
					path: "review.adaptiveCadence.backOffTurnStep",
					message:
						"Project field review.adaptiveCadence.backOffTurnStep is not permitted and was ignored.",
				});
			}
			for (const key of Object.keys(adaptive)) {
				if (!ADAPTIVE_CADENCE_KEYS.has(key)) {
					const path = `review.adaptiveCadence.${key}`;
					warnings.push({
						source,
						path,
						message:
							source === "project"
								? `Project field ${path} is not permitted and was ignored.`
								: `Unknown User field ${path} was ignored.`,
					});
				}
			}
		}
	}
}

function pickKnown(
	value: Parameters<typeof isRecord>[0],
	source: "user" | "project",
): UnvalidatedConfigRecord {
	if (!isRecord(value)) return {};
	const topKeyNames = source === "user" ? USER_KEY_NAMES : PROJECT_KEY_NAMES;
	const output: UnvalidatedConfigRecord = {};
	for (const key of topKeyNames) {
		if (!(key in value)) continue;
		const candidate = value[key];
		if (isRecord(candidate)) {
			const nestedKeys =
				key === "context"
					? CONTEXT_KEYS
					: key === "limits"
						? LIMIT_KEYS
						: key === "security"
							? source === "user"
								? SECURITY_USER_KEYS
								: SECURITY_PROJECT_KEYS
							: key === "delivery"
								? DELIVERY_KEYS
								: key === "review"
									? REVIEW_KEYS
									: key === "dedupe"
										? DEDUPE_KEYS
										: key === "memorySuggestions"
											? MEMORY_KEYS
											: key === "persistence"
												? PERSISTENCE_KEYS
												: undefined;
			if (nestedKeys !== undefined) {
				const picked: UnvalidatedConfigRecord = Object.fromEntries(
					Object.entries(candidate).filter(([nestedKey, nestedValue]) => {
						if (!nestedKeys.has(nestedKey)) return false;
						if (
							source === "project" &&
							key === "memorySuggestions" &&
							nestedKey === "enabled" &&
							nestedValue !== false
						) {
							return false;
						}
						if (
							source === "project" &&
							key === "review" &&
							nestedKey === "skipNonMaterialTurns" &&
							nestedValue !== true
						) {
							return false;
						}
						return true;
					}),
				);
				if (key === "review" && isRecord(picked.adaptiveCadence)) {
					picked.adaptiveCadence = Object.fromEntries(
						Object.entries(picked.adaptiveCadence).filter(([nestedKey, nestedValue]) => {
							if (!ADAPTIVE_CADENCE_KEYS.has(nestedKey)) return false;
							if (source === "project" && nestedKey === "backOffTurnStep") return false;
							return !(source === "project" && nestedKey === "enabled" && nestedValue !== true);
						}),
					);
				}
				output[key] = picked;
				continue;
			}
		}
		output[key] = candidate;
	}
	return output;
}

export async function readBounded(path: string, maximumBytes: number): Promise<string | undefined> {
	let handle;
	try {
		handle = await open(path, "r");
		const buffer = Buffer.alloc(maximumBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch (error) {
		// SAFETY: Node filesystem failures expose code through ErrnoException.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		await handle?.close();
	}
}

function parseYamlDocument(
	text: string,
	source: "user" | "project",
	path: string,
	warnings: ConfigurationWarning[],
): { known: ValidatedUserDocument; unknownTopLevel: Record<string, unknown> } | undefined {
	if (Buffer.byteLength(text, "utf8") > MAX_WATCHDOG_YAML_BYTES) {
		warnings.push({ source, path, message: `${path} exceeds the 1 MiB configuration limit.` });
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = parse(text, { maxAliasCount: 100 });
	} catch {
		warnings.push({ source, path, message: `${path} contains malformed YAML and was ignored.` });
		return undefined;
	}
	if (!isRecord(parsed)) {
		warnings.push({ source, path, message: `${path} must contain a YAML mapping.` });
		return undefined;
	}
	collectUnknownWarnings(parsed, source, warnings);
	const known = pickKnown(parsed, source);
	const validator = source === "user" ? userValidator : projectValidator;
	if (!validator.Check(known)) {
		for (const error of validator.Errors(known)) {
			const field = error.instancePath.replace(/^\//, "").replaceAll("/", ".") || "root";
			warnings.push({
				source,
				path: field,
				message: `${source === "user" ? "User" : "Project"} field ${field} is invalid: ${error.message}.`,
			});
		}
		return undefined;
	}
	const topKeys = source === "user" ? USER_KEYS : PROJECT_KEYS;
	const unknownTopLevel = Object.fromEntries(
		Object.entries(parsed).filter(([key]) => !topKeys.has(key)),
	);
	// SAFETY: validator.Check(known) accepted only schema-valid user or project fields.
	return { known: known as ValidatedUserDocument, unknownTopLevel };
}

function mergeUserConfig(base: AdvisorConfig, document: ValidatedUserDocument): AdvisorConfig {
	const context = document.context ?? {};
	const limits = document.limits ?? {};
	const security = document.security ?? {};
	const delivery = document.delivery ?? {};
	const review = document.review ?? {};
	const dedupe = document.dedupe ?? {};
	const adaptive = review.adaptiveCadence ?? {};
	const memory = document.memorySuggestions ?? {};
	const persistence = document.persistence ?? {};
	const merged: AdvisorConfig = {
		...structuredClone(base),
	};
	if (document.defaultEnabled !== undefined) {
		merged.defaultEnabled = document.defaultEnabled;
	}
	if (document.model !== undefined) merged.model = document.model;
	if (document.effort !== undefined) merged.effort = document.effort;
	if (document.tools !== undefined) merged.tools = document.tools;
	if (document.instructions !== undefined) merged.instructions = document.instructions;
	return normalizeAdvisorConfig({
		...merged,
		context: { ...base.context, ...context },
		limits: { ...base.limits, ...limits },
		security: {
			additionalProtectedPaths:
				security.additionalProtectedPaths ?? base.security.additionalProtectedPaths,
			protectedPathExceptions:
				security.protectedPathExceptions ?? base.security.protectedPathExceptions,
		},
		delivery: {
			activeIdleSeverities: delivery.activeIdleSeverities ?? base.delivery.activeIdleSeverities,
		},
		review: {
			skipNonMaterialTurns: review.skipNonMaterialTurns ?? base.review.skipNonMaterialTurns,
			adaptiveCadence: {
				...base.review.adaptiveCadence,
				...adaptive,
			},
		},
		dedupe: { ...base.dedupe, ...dedupe },
		memorySuggestions: { ...base.memorySuggestions, ...memory },
		persistence: { ...base.persistence, ...persistence },
		version: ADVISOR_CONFIG_VERSION,
	});
}

const PROJECT_LOWER_LIMIT_KEYS = [
	"maxAdviceCharacters",
	"maxAdviceTokens",
	"maxAdvisorTurnsPerUpdate",
	"maxToolCallsPerUpdate",
	"maxPendingTranscriptBytes",
	"maxReprimeTokens",
	"deferredAdviceRetentionHours",
	"maxReviewAttemptMs",
	"maxNestedCompactionMs",
	"maxLifecycleAbortMs",
] as const;

function mergeProjectReviewConfiguration(
	userConfig: AdvisorConfig,
	project: AdvisorProjectConfig,
): AdvisorConfig["review"] {
	const userReview = userConfig.review;
	const projectReview = project.review;
	const userAdaptive = userReview.adaptiveCadence;
	const projectAdaptive = projectReview?.adaptiveCadence;
	const silentReviewsBeforeBackOff = Math.min(
		userAdaptive.silentReviewsBeforeBackOff,
		projectAdaptive?.silentReviewsBeforeBackOff ?? userAdaptive.silentReviewsBeforeBackOff,
	);
	const maxMinTurnsBetweenReviews = Math.max(
		userAdaptive.maxMinTurnsBetweenReviews,
		projectAdaptive?.maxMinTurnsBetweenReviews ?? userAdaptive.maxMinTurnsBetweenReviews,
	);
	return {
		skipNonMaterialTurns:
			userReview.skipNonMaterialTurns || projectReview?.skipNonMaterialTurns === true,
		adaptiveCadence: {
			enabled: userAdaptive.enabled || projectAdaptive?.enabled === true,
			silentReviewsBeforeBackOff,
			backOffTurnStep: userAdaptive.backOffTurnStep,
			maxMinTurnsBetweenReviews: Math.max(
				maxMinTurnsBetweenReviews,
				userConfig.limits.minTurnsBetweenReviews,
			),
		},
	};
}

function narrowerSessionCap(
	userCap: AdvisorConfig["limits"]["sessionTokenSoftCap"],
	projectCap: AdvisorConfig["limits"]["sessionTokenSoftCap"] | undefined,
): AdvisorConfig["limits"]["sessionTokenSoftCap"] {
	if (projectCap === undefined || projectCap === "off") return userCap;
	if (userCap === "off") return projectCap;
	return Math.min(userCap, projectCap);
}

export function mergeProjectConfiguration(
	userConfig: AdvisorConfig,
	project: AdvisorProjectConfig | undefined,
): AdvisorConfig {
	if (project === undefined) return structuredClone(userConfig);
	const limits = { ...userConfig.limits };
	for (const key of PROJECT_LOWER_LIMIT_KEYS) {
		const candidate = project.limits?.[key];
		if (candidate !== undefined) limits[key] = Math.min(userConfig.limits[key], candidate);
	}
	limits.sessionTokenSoftCap = narrowerSessionCap(
		userConfig.limits.sessionTokenSoftCap,
		project.limits?.sessionTokenSoftCap,
	);
	limits.sessionCostSoftCapUsd = narrowerSessionCap(
		userConfig.limits.sessionCostSoftCapUsd,
		project.limits?.sessionCostSoftCapUsd,
	);
	if (project.limits?.minTurnsBetweenReviews !== undefined) {
		limits.minTurnsBetweenReviews = Math.max(
			userConfig.limits.minTurnsBetweenReviews,
			project.limits.minTurnsBetweenReviews,
		);
	}
	if (project.limits?.minIntervalMs !== undefined) {
		limits.minIntervalMs = Math.max(userConfig.limits.minIntervalMs, project.limits.minIntervalMs);
	}
	const projectMemory = project.memorySuggestions;
	const memorySuggestions = { ...userConfig.memorySuggestions };
	if (projectMemory?.enabled === false) memorySuggestions.enabled = false;
	if (projectMemory !== undefined) {
		memorySuggestions.minTurnsBetweenSuggestions = Math.max(
			userConfig.memorySuggestions.minTurnsBetweenSuggestions,
			projectMemory.minTurnsBetweenSuggestions ?? 0,
		);
		memorySuggestions.minIntervalMs = Math.max(
			userConfig.memorySuggestions.minIntervalMs,
			projectMemory.minIntervalMs ?? 0,
		);
		for (const key of [
			"sessionSuggestionCap",
			"maxProposedMemoryCharacters",
			"maxProposedMemoryTokens",
		] as const) {
			if (projectMemory[key] !== undefined) {
				memorySuggestions[key] = Math.min(userConfig.memorySuggestions[key], projectMemory[key]);
			}
		}
	}
	return normalizeAdvisorConfig({
		...structuredClone(userConfig),
		tools:
			project.tools === undefined
				? [...userConfig.tools]
				: userConfig.tools.filter((tool) => project.tools?.includes(tool)),
		context: {
			maxFraction: Math.min(
				userConfig.context.maxFraction,
				project.context?.maxFraction ?? userConfig.context.maxFraction,
			),
			reserveTokens: Math.max(
				userConfig.context.reserveTokens,
				project.context?.reserveTokens ?? userConfig.context.reserveTokens,
			),
			maxUpdateTokens: Math.min(
				userConfig.context.maxUpdateTokens,
				project.context?.maxUpdateTokens ?? userConfig.context.maxUpdateTokens,
			),
		},
		limits,
		security: {
			additionalProtectedPaths: [
				...new Set([
					...userConfig.security.additionalProtectedPaths,
					...(project.security?.additionalProtectedPaths ?? []),
				]),
			],
			protectedPathExceptions: [...userConfig.security.protectedPathExceptions],
		},
		delivery: {
			activeIdleSeverities:
				project.delivery?.activeIdleSeverities === undefined
					? [...userConfig.delivery.activeIdleSeverities]
					: userConfig.delivery.activeIdleSeverities.filter((severity) =>
							project.delivery?.activeIdleSeverities?.includes(severity),
						),
		},
		review: mergeProjectReviewConfiguration(userConfig, project),
		dedupe: {
			similarityRedeliveryThreshold: Math.min(
				userConfig.dedupe.similarityRedeliveryThreshold,
				project.dedupe?.similarityRedeliveryThreshold ??
					userConfig.dedupe.similarityRedeliveryThreshold,
			),
			reRaiseMinTurns:
				userConfig.dedupe.reRaiseMinTurns === 0 || project.dedupe?.reRaiseMinTurns === 0
					? 0
					: Math.max(
							userConfig.dedupe.reRaiseMinTurns,
							project.dedupe?.reRaiseMinTurns ?? userConfig.dedupe.reRaiseMinTurns,
						),
		},
		memorySuggestions,
	});
}

async function loadMarkdown(
	path: string,
	source: "user" | "project",
	warnings: ConfigurationWarning[],
): Promise<string> {
	let text: string | undefined;
	try {
		text = await readBounded(path, MAX_WATCHDOG_MARKDOWN_BYTES + 1);
	} catch {
		warnings.push({ source, path, message: `${path} could not be read and was ignored.` });
		return "";
	}
	if (text === undefined) return "";
	const wasOversized = Buffer.byteLength(text, "utf8") > MAX_WATCHDOG_MARKDOWN_BYTES;
	const redacted = redactSecrets(text);
	if (redacted.redactions > 0) {
		warnings.push({
			source,
			path,
			message: `${path} contained sensitive values that were redacted.`,
		});
	}
	if (wasOversized) {
		warnings.push({ source, path, message: `${path} was truncated to 64 KiB.` });
	}
	return truncateUtf8Bytes(
		redacted.text,
		MAX_WATCHDOG_MARKDOWN_BYTES,
		"\n[WATCHDOG instructions truncated]",
	);
}

function joinInstructions(...parts: (string | undefined)[]): string {
	return parts
		.map((part) => part?.trim())
		.filter(Boolean)
		.join("\n\n");
}

function boundInstructions(
	text: string,
	source: "user" | "project",
	path: string,
	warnings: ConfigurationWarning[],
): string {
	const redacted = redactSecrets(text);
	if (redacted.redactions > 0) {
		warnings.push({
			source,
			path,
			message: `${path} contained sensitive values that were redacted.`,
		});
	}
	if (Buffer.byteLength(redacted.text, "utf8") > MAX_WATCHDOG_MARKDOWN_BYTES) {
		warnings.push({ source, path, message: `${path} instructions were truncated to 64 KiB.` });
	}
	return truncateUtf8Bytes(
		redacted.text,
		MAX_WATCHDOG_MARKDOWN_BYTES,
		"\n[WATCHDOG instructions truncated]",
	);
}

function inactiveUserConfiguration(): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.persistence.transcript = false;
	return config;
}

export async function loadAdvisorConfiguration(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	fallbackUserConfig?: AdvisorConfig;
}): Promise<LoadedAdvisorConfiguration> {
	const warnings: ConfigurationWarning[] = [];
	const paths = advisorConfigurationPaths(options.agentDir, options.cwd);
	const base = normalizeAdvisorConfig(
		structuredClone(options.fallbackUserConfig ?? DEFAULT_ADVISOR_CONFIG),
	);
	let userConfig = base;
	let userUnknownTopLevel: Record<string, unknown> | undefined;
	try {
		const text = await readBounded(paths.userYaml, MAX_WATCHDOG_YAML_BYTES + 1);
		if (text !== undefined) {
			const parsed = parseYamlDocument(text, "user", paths.userYaml, warnings);
			if (parsed === undefined) {
				userConfig = inactiveUserConfiguration();
			} else {
				userConfig = mergeUserConfig(DEFAULT_ADVISOR_CONFIG, parsed.known);
				if (Object.keys(parsed.unknownTopLevel).length > 0) {
					if (
						Buffer.byteLength(stringify(parsed.unknownTopLevel, { lineWidth: 0 }), "utf8") >
						MAX_PRESERVED_UNKNOWN_CONFIG_BYTES
					) {
						warnings.push({
							source: "user",
							path: paths.userYaml,
							message: `Unknown top-level User fields exceeded the ${String(MAX_PRESERVED_UNKNOWN_CONFIG_BYTES)}-byte preservation limit and were not preserved on the next save.`,
						});
					} else {
						userUnknownTopLevel = parsed.unknownTopLevel;
					}
				}
			}
		}
	} catch {
		warnings.push({
			source: "user",
			path: paths.userYaml,
			message: `${paths.userYaml} could not be read; persisted activation is inactive.`,
		});
		userConfig = inactiveUserConfiguration();
	}
	const persistedUserConfig = structuredClone(userConfig);
	userConfig.instructions = boundInstructions(
		userConfig.instructions,
		"user",
		"instructions",
		warnings,
	);
	const userMarkdown = await loadMarkdown(paths.userMarkdown, "user", warnings);
	userConfig.instructions = boundInstructions(
		joinInstructions(userConfig.instructions, userMarkdown),
		"user",
		"instructions",
		warnings,
	);

	let effectiveConfig = structuredClone(userConfig);
	let projectInstructions = "";
	if (options.projectTrusted) {
		let project: AdvisorProjectConfig | undefined;
		try {
			const text = await readBounded(paths.projectYaml, MAX_WATCHDOG_YAML_BYTES + 1);
			if (text !== undefined) {
				const parsed = parseYamlDocument(text, "project", paths.projectYaml, warnings);
				if (parsed !== undefined) {
					// SAFETY: the parsed known fields were validated against the Advisor project schema.
					project = parsed.known as AdvisorProjectConfig;
					projectInstructions = boundInstructions(
						project.instructions ?? "",
						"project",
						"instructions",
						warnings,
					);
				}
			}
		} catch {
			warnings.push({
				source: "project",
				path: paths.projectYaml,
				message: `${paths.projectYaml} could not be read and was ignored.`,
			});
		}
		const projectMarkdown = await loadMarkdown(paths.projectMarkdown, "project", warnings);
		projectInstructions = boundInstructions(
			joinInstructions(projectInstructions, projectMarkdown),
			"project",
			"instructions",
			warnings,
		);
		effectiveConfig = mergeProjectConfiguration(userConfig, project);
	}
	const loaded: LoadedAdvisorConfiguration = {
		userConfig: persistedUserConfig,
		effectiveConfig,
		projectInstructions,
		warnings,
		paths,
	};
	if (userUnknownTopLevel !== undefined) loaded.userUnknownTopLevel = userUnknownTopLevel;
	return loaded;
}

export function serializeUserConfiguration(
	config: AdvisorConfig,
	unknownTopLevel?: Record<string, unknown>,
): string {
	const normalized = normalizeAdvisorConfig(structuredClone(config));
	const merged = {
		...(unknownTopLevel ?? {}),
		...normalized,
	};
	const serialized = stringify(merged, { lineWidth: 0 });
	if (
		Buffer.byteLength(serialized, "utf8") > MAX_WATCHDOG_YAML_BYTES &&
		unknownTopLevel !== undefined
	) {
		// Never write a file the next load would reject as oversized; drop the
		// preserved unknown top-level fields instead of failing the whole save.
		return stringify(normalized, { lineWidth: 0 });
	}
	return serialized;
}

const MAX_ATOMIC_WRITE_SYMLINK_HOPS = 32;

/**
 * Resolve the real file an atomic save should replace.
 * `rename()` onto a symlink path replaces the link itself, so User WATCHDOG.yml
 * that is a symlink (for example into a dotfiles repo) must write through to the
 * final target, including dangling or nested links.
 */
export async function resolveAtomicWriteDestination(path: string): Promise<string> {
	let current = path;
	const seen = new Set<string>();
	for (let hop = 0; hop < MAX_ATOMIC_WRITE_SYMLINK_HOPS; hop++) {
		if (seen.has(current)) return current;
		seen.add(current);
		let stats;
		try {
			stats = await lstat(current);
		} catch (error) {
			// SAFETY: Node filesystem failures expose code through ErrnoException.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
			throw error;
		}
		if (!stats.isSymbolicLink()) return current;
		const raw = await readlink(current);
		current = isAbsolute(raw) ? raw : resolve(dirname(current), raw);
	}
	return current;
}

export async function saveUserConfigurationAtomic(
	path: string,
	config: AdvisorConfig,
	unknownTopLevel?: Record<string, unknown>,
): Promise<void> {
	const destination = await resolveAtomicWriteDestination(path);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(destination), `.${WATCHDOG_YAML_NAME}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, serializeUserConfiguration(config, unknownTopLevel), {
			encoding: "utf8",
			mode: 0o600,
		});
		const handle = await open(temporary, "r+");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, destination);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export function isReadOnlyToolName(value: string): value is ReadOnlyToolName {
	// SAFETY: the membership check is against the complete readonly tool-name list.
	return READ_ONLY_TOOL_NAMES.includes(value as ReadOnlyToolName);
}
