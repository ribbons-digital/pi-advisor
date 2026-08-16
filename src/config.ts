export const ADVISOR_CONFIG_VERSION = 1 as const;

export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number];

export type AdvisorEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AdvisorSessionActivation {
	enabled: boolean;
	source: "user-default" | "session-command" | "cli-flag";
}

export interface AdvisorContextConfig {
	maxFraction: number;
	reserveTokens: number;
	maxUpdateTokens: number;
}

export type AdvisorSessionCap = number | "off";

export type ActiveIdleSeverity = "concern" | "blocker";

export interface AdvisorDeliveryConfig {
	activeIdleSeverities: ActiveIdleSeverity[];
}

export interface AdvisorAdaptiveCadenceConfig {
	enabled: boolean;
	silentReviewsBeforeBackOff: number;
	backOffTurnStep: number;
	maxMinTurnsBetweenReviews: number;
}

export interface AdvisorReviewConfig {
	skipNonMaterialTurns: boolean;
	adaptiveCadence: AdvisorAdaptiveCadenceConfig;
}

export interface AdvisorDedupeConfig {
	similarityRedeliveryThreshold: number;
	reRaiseMinTurns: number;
}

export interface AdvisorLimitConfig {
	maxAdviceCharacters: number;
	maxAdviceTokens: number;
	maxAdvisorTurnsPerUpdate: number;
	maxToolCallsPerUpdate: number;
	maxPendingTranscriptBytes: number;
	maxReprimeTokens: number;
	minTurnsBetweenReviews: number;
	minIntervalMs: number;
	deferredAdviceRetentionHours: number;
	sessionTokenSoftCap: AdvisorSessionCap;
	sessionCostSoftCapUsd: AdvisorSessionCap;
}

export interface MemorySuggestionConfig {
	enabled: boolean;
	minTurnsBetweenSuggestions: number;
	minIntervalMs: number;
	sessionSuggestionCap: number;
	maxProposedMemoryCharacters: number;
	maxProposedMemoryTokens: number;
}

export interface AdvisorUserConfig {
	version: typeof ADVISOR_CONFIG_VERSION;
	defaultEnabled: boolean;
	model?: string;
	effort: AdvisorEffort;
	tools: ReadOnlyToolName[];
	instructions: string;
	context: AdvisorContextConfig;
	limits: AdvisorLimitConfig;
	security: {
		additionalProtectedPaths: string[];
		protectedPathExceptions: string[];
	};
	delivery: AdvisorDeliveryConfig;
	review: AdvisorReviewConfig;
	dedupe: AdvisorDedupeConfig;
	memorySuggestions: MemorySuggestionConfig;
	persistence: {
		transcript: boolean;
	};
}

export type AdvisorConfig = AdvisorUserConfig;

export interface AdvisorProjectConfig {
	instructions?: string;
	tools?: ReadOnlyToolName[];
	context?: Partial<AdvisorContextConfig>;
	limits?: Partial<AdvisorLimitConfig>;
	security?: {
		additionalProtectedPaths?: string[];
	};
	delivery?: {
		activeIdleSeverities?: ActiveIdleSeverity[];
	};
	review?: {
		skipNonMaterialTurns?: true;
		adaptiveCadence?: {
			enabled?: true;
			silentReviewsBeforeBackOff?: number;
			maxMinTurnsBetweenReviews?: number;
		};
	};
	dedupe?: Partial<AdvisorDedupeConfig>;
	memorySuggestions?: {
		enabled?: false;
	} & Partial<Omit<MemorySuggestionConfig, "enabled">>;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
	return Object.freeze(value);
}

const CANONICAL_DEFAULT_ADVISOR_CONFIG: AdvisorConfig = deepFreeze({
	version: ADVISOR_CONFIG_VERSION,
	defaultEnabled: false,
	effort: "high",
	tools: [...READ_ONLY_TOOL_NAMES],
	instructions: "",
	context: {
		maxFraction: 0.65,
		reserveTokens: 8_192,
		maxUpdateTokens: 24_000,
	},
	limits: {
		maxAdviceCharacters: 2_000,
		maxAdviceTokens: 512,
		maxAdvisorTurnsPerUpdate: 4,
		maxToolCallsPerUpdate: 8,
		maxPendingTranscriptBytes: 200_000,
		maxReprimeTokens: 32_000,
		minTurnsBetweenReviews: 1,
		minIntervalMs: 0,
		deferredAdviceRetentionHours: 24,
		sessionTokenSoftCap: "off",
		sessionCostSoftCapUsd: "off",
	},
	security: {
		additionalProtectedPaths: [],
		protectedPathExceptions: [],
	},
	delivery: {
		activeIdleSeverities: ["blocker"],
	},
	review: {
		skipNonMaterialTurns: false,
		adaptiveCadence: {
			enabled: false,
			silentReviewsBeforeBackOff: 3,
			backOffTurnStep: 1,
			maxMinTurnsBetweenReviews: 4,
		},
	},
	dedupe: {
		similarityRedeliveryThreshold: 0.5,
		reRaiseMinTurns: 4,
	},
	memorySuggestions: {
		enabled: true,
		minTurnsBetweenSuggestions: 8,
		minIntervalMs: 600_000,
		sessionSuggestionCap: 5,
		maxProposedMemoryCharacters: 1_000,
		maxProposedMemoryTokens: 256,
	},
	persistence: {
		transcript: true,
	},
});

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = deepFreeze(
	structuredClone(CANONICAL_DEFAULT_ADVISOR_CONFIG),
);

/**
 * @deprecated Use DEFAULT_ADVISOR_CONFIG. Removed in 0.4.0.
 */
export const PROPOSED_ADVISOR_CONFIG: AdvisorConfig = structuredClone(
	CANONICAL_DEFAULT_ADVISOR_CONFIG,
);

export const HARD_LIMITS = {
	maxAdviceCharacters: 8_000,
	maxAdviceTokens: 2_048,
	maxProposedMemoryCharacters: 4_000,
	maxProposedMemoryTokens: 1_024,
	maxAdvisorTurnsPerUpdate: 12,
	maxToolCallsPerUpdate: 32,
	maxPendingTranscriptBytes: 1_000_000,
	maxReprimeTokens: 128_000,
	silentReviewsBeforeBackOff: 32,
	backOffTurnStep: 8,
	maxMinTurnsBetweenReviews: 64,
	reRaiseMinTurns: 64,
} as const;

function finiteAtLeast(value: number, minimum: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

function isActiveIdleSeverity(value: unknown): value is ActiveIdleSeverity {
	return value === "concern" || value === "blocker";
}

function finiteClamped(value: number, minimum: number, maximum: number, fallback: number): number {
	return Math.min(maximum, finiteAtLeast(value, minimum, fallback));
}

function normalizeReviewConfig(
	input: AdvisorReviewConfig | undefined,
	minTurnsBetweenReviews: number,
): AdvisorReviewConfig {
	const defaults = CANONICAL_DEFAULT_ADVISOR_CONFIG.review;
	const adaptive = input?.adaptiveCadence;
	const minTurns = finiteAtLeast(
		minTurnsBetweenReviews,
		1,
		CANONICAL_DEFAULT_ADVISOR_CONFIG.limits.minTurnsBetweenReviews,
	);
	return {
		skipNonMaterialTurns: input?.skipNonMaterialTurns === true,
		adaptiveCadence: {
			enabled: adaptive?.enabled === true,
			silentReviewsBeforeBackOff: finiteClamped(
				adaptive?.silentReviewsBeforeBackOff ?? defaults.adaptiveCadence.silentReviewsBeforeBackOff,
				1,
				HARD_LIMITS.silentReviewsBeforeBackOff,
				defaults.adaptiveCadence.silentReviewsBeforeBackOff,
			),
			backOffTurnStep: finiteClamped(
				adaptive?.backOffTurnStep ?? defaults.adaptiveCadence.backOffTurnStep,
				1,
				HARD_LIMITS.backOffTurnStep,
				defaults.adaptiveCadence.backOffTurnStep,
			),
			maxMinTurnsBetweenReviews: finiteClamped(
				adaptive?.maxMinTurnsBetweenReviews ?? defaults.adaptiveCadence.maxMinTurnsBetweenReviews,
				minTurns,
				HARD_LIMITS.maxMinTurnsBetweenReviews,
				Math.max(minTurns, defaults.adaptiveCadence.maxMinTurnsBetweenReviews),
			),
		},
	};
}

function positiveSessionCap(
	value: AdvisorSessionCap,
	fallback: AdvisorSessionCap,
): AdvisorSessionCap {
	if (value === "off") return value;
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizeAdvisorConfig(input: AdvisorConfig): AdvisorConfig {
	const defaults = CANONICAL_DEFAULT_ADVISOR_CONFIG;
	const tools = input.tools.filter(
		(tool, index, values) => READ_ONLY_TOOL_NAMES.includes(tool) && values.indexOf(tool) === index,
	);
	return {
		...input,
		version: ADVISOR_CONFIG_VERSION,
		tools,
		context: {
			maxFraction: Math.min(
				1,
				finiteAtLeast(input.context.maxFraction, 0.01, defaults.context.maxFraction),
			),
			reserveTokens: finiteAtLeast(input.context.reserveTokens, 0, defaults.context.reserveTokens),
			maxUpdateTokens: finiteAtLeast(
				input.context.maxUpdateTokens,
				1,
				defaults.context.maxUpdateTokens,
			),
		},
		limits: {
			...input.limits,
			maxAdviceCharacters: finiteClamped(
				input.limits.maxAdviceCharacters,
				1,
				HARD_LIMITS.maxAdviceCharacters,
				defaults.limits.maxAdviceCharacters,
			),
			maxAdviceTokens: finiteClamped(
				input.limits.maxAdviceTokens,
				1,
				HARD_LIMITS.maxAdviceTokens,
				defaults.limits.maxAdviceTokens,
			),
			maxAdvisorTurnsPerUpdate: finiteClamped(
				input.limits.maxAdvisorTurnsPerUpdate,
				1,
				HARD_LIMITS.maxAdvisorTurnsPerUpdate,
				defaults.limits.maxAdvisorTurnsPerUpdate,
			),
			maxToolCallsPerUpdate: finiteClamped(
				input.limits.maxToolCallsPerUpdate,
				0,
				HARD_LIMITS.maxToolCallsPerUpdate,
				defaults.limits.maxToolCallsPerUpdate,
			),
			maxPendingTranscriptBytes: finiteClamped(
				input.limits.maxPendingTranscriptBytes,
				1,
				HARD_LIMITS.maxPendingTranscriptBytes,
				defaults.limits.maxPendingTranscriptBytes,
			),
			maxReprimeTokens: finiteClamped(
				input.limits.maxReprimeTokens,
				1,
				HARD_LIMITS.maxReprimeTokens,
				defaults.limits.maxReprimeTokens,
			),
			minTurnsBetweenReviews: finiteAtLeast(
				input.limits.minTurnsBetweenReviews,
				1,
				defaults.limits.minTurnsBetweenReviews,
			),
			minIntervalMs: finiteAtLeast(input.limits.minIntervalMs, 0, defaults.limits.minIntervalMs),
			deferredAdviceRetentionHours: finiteAtLeast(
				input.limits.deferredAdviceRetentionHours,
				0,
				defaults.limits.deferredAdviceRetentionHours,
			),
			sessionTokenSoftCap: positiveSessionCap(
				input.limits.sessionTokenSoftCap,
				defaults.limits.sessionTokenSoftCap,
			),
			sessionCostSoftCapUsd: positiveSessionCap(
				input.limits.sessionCostSoftCapUsd,
				defaults.limits.sessionCostSoftCapUsd,
			),
		},
		security: {
			additionalProtectedPaths: [...input.security.additionalProtectedPaths],
			protectedPathExceptions: [...input.security.protectedPathExceptions],
		},
		delivery: {
			// Programmatic configs created against the pre-Q3 shape may omit the
			activeIdleSeverities:
				// delivery key even though the type marks it required; fall back to
				// the release default instead of crashing at extension load.
				(
					(input as Partial<AdvisorConfig>).delivery?.activeIdleSeverities ??
					defaults.delivery.activeIdleSeverities
				).filter(
					(severity, index, values) =>
						isActiveIdleSeverity(severity) && values.indexOf(severity) === index,
				),
		},
		review: normalizeReviewConfig(input.review, input.limits.minTurnsBetweenReviews),
		dedupe: {
			similarityRedeliveryThreshold: Math.min(
				1,
				finiteAtLeast(
					input.dedupe.similarityRedeliveryThreshold,
					0,
					defaults.dedupe.similarityRedeliveryThreshold,
				),
			),
			reRaiseMinTurns: Math.floor(
				finiteClamped(
					input.dedupe.reRaiseMinTurns,
					0,
					HARD_LIMITS.reRaiseMinTurns,
					defaults.dedupe.reRaiseMinTurns,
				),
			),
		},
		memorySuggestions: {
			enabled: input.memorySuggestions.enabled,
			minTurnsBetweenSuggestions: finiteAtLeast(
				input.memorySuggestions.minTurnsBetweenSuggestions,
				0,
				defaults.memorySuggestions.minTurnsBetweenSuggestions,
			),
			minIntervalMs: finiteAtLeast(
				input.memorySuggestions.minIntervalMs,
				0,
				defaults.memorySuggestions.minIntervalMs,
			),
			sessionSuggestionCap: Math.floor(
				finiteAtLeast(
					input.memorySuggestions.sessionSuggestionCap,
					0,
					defaults.memorySuggestions.sessionSuggestionCap,
				),
			),
			maxProposedMemoryCharacters: finiteClamped(
				input.memorySuggestions.maxProposedMemoryCharacters,
				1,
				HARD_LIMITS.maxProposedMemoryCharacters,
				defaults.memorySuggestions.maxProposedMemoryCharacters,
			),
			maxProposedMemoryTokens: finiteClamped(
				input.memorySuggestions.maxProposedMemoryTokens,
				1,
				HARD_LIMITS.maxProposedMemoryTokens,
				defaults.memorySuggestions.maxProposedMemoryTokens,
			),
		},
		persistence: { ...input.persistence },
	};
}

export interface ConfigValidationStrategy {
	format: "yaml";
	schema: "typebox-compiled";
	unknownFields: "warn";
	malformedUserConfig: "inactive";
	malformedProjectConfig: "ignore-with-warning";
	projectMerge: "narrow-only";
	apply: "atomic-epoch-rebuild";
}

export const CONFIG_VALIDATION_STRATEGY: ConfigValidationStrategy = {
	format: "yaml",
	schema: "typebox-compiled",
	unknownFields: "warn",
	malformedUserConfig: "inactive",
	malformedProjectConfig: "ignore-with-warning",
	projectMerge: "narrow-only",
	apply: "atomic-epoch-rebuild",
};
