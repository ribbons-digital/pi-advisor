import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
	ADVISE_WIRE_SCHEMA,
	adviceDedupeKey,
	boundAdvice,
	BoundedAdviceDedupe,
	BoundedKeyedByteFifo,
	ADVISOR_CUSTOM_TYPE,
	ADVISOR_TRANSCRIPT_RECORD_VERSION,
	DEFAULT_ADVISOR_CONFIG,
	createAdviseTool,
	estimateAdvisorContext,
	estimateTokens,
	formatAdviceForDelivery,
	formatAdvisorEnableStatus,
	formatAdvisorStatus,
	HARD_LIMITS,
	isAdviseWireInput,
	isContentFreeAdvice,
	isMeaningfulExecutorTurn,
	MAX_ADVISOR_TOOL_RESULT_BYTES,
	MAX_ADVISOR_TOOL_RESULT_LINES,
	MAX_DEFERRED_DELIVERY_BYTES,
	measureAdvisorToolOutput,
	normalizeAdviceForDedupe,
	normalizeAdvisorConfig,
	noteSimilarity,
	hammingDistance64,
	noteSignature,
	parseAdviseWireInput,
	parsePersistedAdvisorTranscriptRecord,
	PROPOSED_ADVISOR_CONFIG,
	redactSecrets,
	renderAdvisorDelta,
	renderAdvisorReprimeSnapshot,
	successfulMemoryToolTexts,
	takeRenderedPrefix,
	type AdviceDedupeIdentity,
	type AdviseWireInput,
	type AdvisorRuntimeStatus,
	type AdviceSeverity,
	type DedupePolicy,
} from "../../src/index.js";

function dedupeIdentity(
	note: string,
	severity: "nit" | "concern" | "blocker" = "concern",
): AdviceDedupeIdentity {
	return { note, severity };
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "pi-advisor-test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("portable advise wire contract", () => {
	it("projects a complete top-level object contract without root composition", () => {
		const tool = createAdviseTool(DEFAULT_ADVISOR_CONFIG, {
			validCalls: 0,
			suppressedCalls: 0,
			memoryPolicySuppressedCalls: 0,
			memoryLimitSuppressedCalls: 0,
		});
		const schema = { ...ADVISE_WIRE_SCHEMA };
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["note"]);
		expect(schema).not.toHaveProperty("anyOf");
		expect(schema).not.toHaveProperty("oneOf");
		expect(schema).not.toHaveProperty("allOf");
		expect(schema).not.toHaveProperty("additionalProperties");
		const properties = schema.properties;
		expect(Object.keys(properties)).toEqual(["note", "intent", "severity", "findingKey", "memory"]);
		expect(properties.memory).not.toHaveProperty("additionalProperties");
		expect(properties.memory.required).toBeUndefined();

		const anthropicProjection = {
			type: "object",
			properties: schema.properties,
			required: schema.required,
		};
		expect(anthropicProjection.properties).toEqual(schema.properties);
		expect(anthropicProjection.required).toEqual(["note"]);
		for (const description of [
			tool.description,
			JSON.stringify(properties.intent),
			JSON.stringify(properties.memory),
		]) {
			expect(description).toContain("memory.text");
			expect(description).toContain("memory.category");
			expect(description).toContain("memory.basis");
			expect(description).toContain("Otherwise omit memory");
		}
	});

	it("matches TypeBox grapheme-length validation at findingKey boundaries", () => {
		const tool = createAdviseTool(DEFAULT_ADVISOR_CONFIG, {
			validCalls: 0,
			suppressedCalls: 0,
			memoryPolicySuppressedCalls: 0,
			memoryLimitSuppressedCalls: 0,
		});
		const familyGrapheme = "👨‍👩‍👧‍👦";
		const accepted = { note: "x", findingKey: familyGrapheme.repeat(200) };
		const rejected = { note: "x", findingKey: familyGrapheme.repeat(201) };

		expect(isAdviseWireInput({ note: "x", findingKey: "k".repeat(200) })).toBe(true);
		expect(isAdviseWireInput({ note: "" })).toBe(false);
		expect(isAdviseWireInput({ note: "x", findingKey: "" })).toBe(false);
		expect(isAdviseWireInput({ note: "x", findingKey: "k".repeat(201) })).toBe(false);
		expect(isAdviseWireInput(accepted)).toBe(true);
		expect(isAdviseWireInput(rejected)).toBe(false);
		expect(() => {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "accepted-grapheme-key",
				name: "advise",
				arguments: accepted,
			});
		}).not.toThrow();
		expect(() => {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "rejected-grapheme-key",
				name: "advise",
				arguments: rejected,
			});
		}).toThrow();
	});

	it("parses strict review and complete Memory inputs while discarding unknown fields", () => {
		const reviewWire = {
			note: "Verify the rollback.",
			severity: "blocker",
			findingKey: "migration-rollback",
			memory: { text: "ignored for review", nestedUnknown: "discard me" },
			rootUnknown: "discard me",
		} satisfies AdviseWireInput & {
			rootUnknown: string;
			memory: { text: string; nestedUnknown: string };
		};
		expect(parseAdviseWireInput(reviewWire)).toEqual({
			note: "Verify the rollback.",
			intent: "review",
			severity: "blocker",
			findingKey: "migration-rollback",
		});

		const memoryWire = {
			note: "This durable constraint matters later.",
			intent: "memory-suggestion",
			severity: "nit",
			findingKey: "ignored",
			memory: {
				text: "Use pnpm for package installation.",
				category: "project",
				basis: "project-constraint",
				nestedUnknown: "discard me",
			},
			rootUnknown: "discard me",
		} satisfies AdviseWireInput & {
			rootUnknown: string;
			memory: AdviseWireInput["memory"] & { nestedUnknown: string };
		};
		expect(parseAdviseWireInput(memoryWire)).toEqual({
			note: "This durable constraint matters later.",
			intent: "memory-suggestion",
			memory: {
				text: "Use pnpm for package installation.",
				category: "project",
				basis: "project-constraint",
			},
		});
	});

	it.each([
		{ label: "absent memory" },
		{ label: "missing text", memory: { category: "project", basis: "project-constraint" } },
		{ label: "missing category", memory: { text: "durable", basis: "project-constraint" } },
		{ label: "missing basis", memory: { text: "durable", category: "project" } },
		{
			label: "empty text",
			memory: { text: "   ", category: "project", basis: "project-constraint" },
		},
	] satisfies readonly {
		label: string;
		memory?: NonNullable<AdviseWireInput["memory"]>;
	}[])("suppresses $label at the typed boundary", ({ memory }) => {
		expect(
			parseAdviseWireInput({
				note: "Potential durable context.",
				intent: "memory-suggestion",
				...(memory === undefined ? {} : { memory }),
			}),
		).toBeUndefined();
	});
});

function runtimeStatus(): AdvisorRuntimeStatus {
	return {
		enabled: true,
		active: true,
		paused: false,
		effort: "high",
		backlog: false,
		reviewing: false,
		pendingTranscriptBytes: 0,
		queuedReviews: 0,
		maxPendingTranscriptBytesObserved: 0,
		retryPending: false,
		retryDelayMs: 0,
		retryAttempts: 0,
		contextEstimateTokens: 0,
		contextLimitTokens: 10_000,
		contextUsageTokens: 0,
		contextTrailingEstimateTokens: 0,
		contextEstimateSource: "estimate-only",
		compactionsCompleted: 0,
		compactionFailures: 0,
		compactionUsageUnavailable: 0,
		contextReprimesCompleted: 0,
		contextReprimeFailures: 0,
		sessionTokenSoftCap: "off",
		sessionCostSoftCapUsd: "off",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 },
		reviewRequests: 0,
		reviewsCompleted: 0,
		silentReviews: 0,
		reviewsSuperseded: 0,
		failedReviews: 0,
		effectiveMinTurnsBetweenReviews: 1,
		governorSkippedReviews: 0,
		deliveryFailures: 0,
		notesDelivered: 0,
		activeNotesPending: 0,
		deferredNotesPending: 0,
		restoredDeferredNotesPending: 0,
		oldestDeferredAdviceAgeMs: 0,
		notesSuppressed: 0,
		mutedSuppressions: 0,
		mutedFindings: 0,
		memorySuggestionCapability: { state: "absent", reason: "not registered" },
		memorySuggestionsEnabled: false,
		memorySuggestionsDelivered: 0,
		memorySuggestionsPolicySuppressed: 0,
		memorySuggestionsLimitSuppressed: 0,
		memorySuggestionsRemaining: 5,
		reviewFollowUpsTriggered: 0,
		memorySuggestionNextEligibleTurn: 0,
		memorySuggestionNextEligibleAt: 0,
		redactions: 0,
		consecutiveFailures: 0,
		branchResets: 0,
		staleQueuedMessagesDiscarded: 0,
		warnings: 0,
		transcriptPersistenceEnabled: false,
		transcriptRecordsPersisted: 0,
		transcriptPersistenceFailures: 0,
		restoredActiveReviewPending: false,
		restoredQueuedReviewPending: false,
		restoredActiveDeliveriesPending: 0,
		restoredReplayCount: 0,
		poisonReviewDrops: 0,
		runtimeStatePersistenceFailures: 0,
		serializedPersistenceTruncations: 0,
		epoch: 0,
		nestedActiveTools: [],
	};
}

describe("Slice 1 configuration and emission policy", () => {
	it("keeps release defaults deeply immutable and normalization fallbacks canonical", () => {
		expect(Object.isFrozen(DEFAULT_ADVISOR_CONFIG)).toBe(true);
		expect(Object.isFrozen(DEFAULT_ADVISOR_CONFIG.limits)).toBe(true);
		expect(DEFAULT_ADVISOR_CONFIG.persistence.transcript).toBe(true);
		expect(Reflect.set(DEFAULT_ADVISOR_CONFIG.limits, "maxAdviceCharacters", 1)).toBe(false);
		const input = structuredClone(DEFAULT_ADVISOR_CONFIG);
		input.limits.maxAdviceCharacters = Number.NaN;
		expect(normalizeAdvisorConfig(input).limits.maxAdviceCharacters).toBe(2_000);
	});

	it("normalizes a partial review block and keeps User cadence values away from the defaults", () => {
		const omittedAdaptive = structuredClone(DEFAULT_ADVISOR_CONFIG);
		omittedAdaptive.review = { skipNonMaterialTurns: true } as typeof omittedAdaptive.review;
		expect(normalizeAdvisorConfig(omittedAdaptive).review).toEqual({
			skipNonMaterialTurns: true,
			adaptiveCadence: {
				enabled: false,
				silentReviewsBeforeBackOff: 3,
				backOffTurnStep: 1,
				maxMinTurnsBetweenReviews: 4,
			},
		});

		const custom = structuredClone(DEFAULT_ADVISOR_CONFIG);
		custom.limits.minTurnsBetweenReviews = 5;
		custom.review.adaptiveCadence.silentReviewsBeforeBackOff = 8;
		custom.review.adaptiveCadence.maxMinTurnsBetweenReviews = 2;
		const normalized = normalizeAdvisorConfig(custom);
		expect(normalized.review.adaptiveCadence.silentReviewsBeforeBackOff).toBe(8);
		expect(normalized.review.adaptiveCadence.maxMinTurnsBetweenReviews).toBe(5);
	});

	it("floors a fractional Memory suggestion session cap", () => {
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.memorySuggestions.sessionSuggestionCap = 1.9;
		expect(normalizeAdvisorConfig(config).memorySuggestions.sessionSuggestionCap).toBe(1);
		config.memorySuggestions.sessionSuggestionCap = -1;
		expect(normalizeAdvisorConfig(config).memorySuggestions.sessionSuggestionCap).toBe(0);
	});

	it("keeps the deprecated proposed config export independent from release defaults", () => {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		const original = PROPOSED_ADVISOR_CONFIG.limits.maxAdviceCharacters;
		try {
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			PROPOSED_ADVISOR_CONFIG.limits.maxAdviceCharacters = original - 1;
			expect(DEFAULT_ADVISOR_CONFIG.limits.maxAdviceCharacters).toBe(original);
		} finally {
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			PROPOSED_ADVISOR_CONFIG.limits.maxAdviceCharacters = original;
		}
	});

	it("clamps every approved package hard maximum", () => {
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.limits.maxAdviceCharacters = Number.MAX_SAFE_INTEGER;
		config.limits.maxAdviceTokens = Number.MAX_SAFE_INTEGER;
		config.limits.maxAdvisorTurnsPerUpdate = Number.MAX_SAFE_INTEGER;
		config.limits.maxToolCallsPerUpdate = Number.MAX_SAFE_INTEGER;
		config.limits.maxPendingTranscriptBytes = Number.MAX_SAFE_INTEGER;
		config.limits.maxReprimeTokens = Number.MAX_SAFE_INTEGER;
		config.memorySuggestions.maxProposedMemoryCharacters = Number.MAX_SAFE_INTEGER;
		config.memorySuggestions.maxProposedMemoryTokens = Number.MAX_SAFE_INTEGER;
		const normalized = normalizeAdvisorConfig(config);
		expect(normalized.limits).toMatchObject({
			maxAdviceCharacters: HARD_LIMITS.maxAdviceCharacters,
			maxAdviceTokens: HARD_LIMITS.maxAdviceTokens,
			maxAdvisorTurnsPerUpdate: HARD_LIMITS.maxAdvisorTurnsPerUpdate,
			maxToolCallsPerUpdate: HARD_LIMITS.maxToolCallsPerUpdate,
			maxPendingTranscriptBytes: HARD_LIMITS.maxPendingTranscriptBytes,
			maxReprimeTokens: HARD_LIMITS.maxReprimeTokens,
		});
		expect(normalized.memorySuggestions).toMatchObject({
			maxProposedMemoryCharacters: HARD_LIMITS.maxProposedMemoryCharacters,
			maxProposedMemoryTokens: HARD_LIMITS.maxProposedMemoryTokens,
		});
	});

	it("reports prior token and cost totals before a paused budget reset", () => {
		const previous = runtimeStatus();
		previous.paused = true;
		previous.pauseReason = "Advisor session cost soft cap reached";
		previous.usage.total = 12_345;
		previous.usage.costUsd = 10.25;
		const current = runtimeStatus();
		const output = formatAdvisorEnableStatus(previous, current, true);
		expect(output).toContain("Previous Advisor budget before reset: 12345 tokens, $10.2500");
		expect(output).toContain("Advisor session cost soft cap reached");
		expect(output).toContain("Session tokens: 0");
	});

	it("reports complete review usage, maintenance, suppression, and persistence accounting", () => {
		const status = runtimeStatus();
		status.reviewRequests = 4;
		status.reviewsCompleted = 3;
		status.failedReviews = 1;
		status.governorSkippedReviews = 2;
		status.lastGovernorOutcome = "Advisor turn limit reached";
		status.contextReprimesCompleted = 2;
		status.contextReprimeFailures = 1;
		status.compactionUsageUnavailable = 2;
		status.usage = {
			input: 100,
			output: 20,
			cacheRead: 30,
			cacheWrite: 5,
			total: 155,
			costUsd: 0.125,
		};
		status.notesSuppressed = 7;
		status.transcriptPersistenceEnabled = true;
		status.transcriptRecordsPersisted = 9;
		status.transcriptPersistenceFailures = 1;
		const output = formatAdvisorStatus(status);
		expect(output).toContain("2 operations with usage unavailable through Pi public APIs");
		expect(output).toContain("Context re-prime: 2 completed, 1 failed");
		expect(output).toContain(
			"Session tokens: 155 total (100 input, 20 output, 30 cache read, 5 cache write)",
		);
		expect(output).toContain("Session tokens: 155 total");
		expect(output).toContain("cap off");
		expect(output).toContain("Reviewing: no");
		expect(output).toContain("Reviews: 4 requests, 3 completed");
		expect(output).toContain("0 superseded");
		expect(output).toContain("Review cadence: every 1 meaningful turn");
		expect(output).toContain("Governor skips: 2, latest Advisor turn limit reached");
		expect(output).toContain("7 suppressed");
		expect(output).toContain("Local redacted activity record: enabled, 9 records available, 1");
		expect(output).toContain("never include reasoning or file-content bodies");
	});

	it("keeps even extremely small configured note bounds within their limit", () => {
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.limits.maxAdviceCharacters = 3;
		config.limits.maxAdviceTokens = 1;
		const result = boundAdvice("A note that must be truncated", config);
		expect(result.truncated).toBe(true);
		expect(Array.from(result.note)).toHaveLength(3);
	});

	it("enforces the estimated-token bound for non-BMP notes", () => {
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.limits.maxAdviceCharacters = 100;
		config.limits.maxAdviceTokens = 10;
		const result = boundAdvice("😀".repeat(100), config);
		expect(result.truncated).toBe(true);
		expect(estimateTokens(result.note)).toBeLessThanOrEqual(10);
	});

	it("suppresses normalized approval, whitespace-only, and punctuation-only notes", () => {
		expect(isContentFreeAdvice("  LOOKS GOOD!!! ")).toBe(true);
		expect(isContentFreeAdvice("   \t\n ")).toBe(true);
		expect(isContentFreeAdvice("... !!! --")).toBe(true);
		expect(isContentFreeAdvice("Stop: this migration deletes production rows.")).toBe(false);
	});

	it("redacts and safely truncates oversized notes with visible metadata", () => {
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.limits.maxAdviceCharacters = 80;
		config.limits.maxAdviceTokens = 20;
		const discarded = "DISCARDED-SENTINEL";
		const result = boundAdvice(
			`API_KEY=top-secret-value ${"useful detail ".repeat(20)}${discarded}`,
			config,
		);
		expect(result.truncated).toBe(true);
		expect(result.note).toContain("[Advisory note truncated to configured limit]");
		expect(result.note).toContain("[REDACTED]");
		expect(result.note).not.toContain("top-secret-value");
		expect(result.note).not.toContain(discarded);
		expect(Array.from(result.note).length).toBeLessThanOrEqual(80);
		expect(result.originalCharacters).toBeGreaterThan(Array.from(result.note).length);
	});
});

describe("Usage estimation and bounded transcript serialization through Slice 4B", () => {
	it("anchors context to the latest exact successful usage and estimates only trailing content", () => {
		const exact = assistant([{ type: "text", text: "prior private response" }]);
		exact.usage = {
			input: 80,
			output: 20,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 115,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const messages = [
			{ role: "user" as const, content: "older content", timestamp: 1 },
			exact,
			{
				role: "toolResult" as const,
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text" as const, text: "trailing tool result" }],
				isError: false,
				timestamp: 2,
			},
		];
		const toolSchemas = [
			{
				name: "schema_heavy_tool",
				description: "A fixed Advisor tool with enough schema text to affect estimation.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "A deliberately explicit query value." },
					},
					required: ["query"],
				},
			},
		];
		const estimate = estimateAdvisorContext(
			messages,
			"next bounded update",
			"system policy",
			true,
			toolSchemas,
		);
		const publicEstimate = estimateContextTokens([
			...messages,
			{ role: "user" as const, content: "next bounded update", timestamp: 3 },
		]);
		expect(estimate).toEqual({
			tokens: publicEstimate.tokens,
			usageTokens: publicEstimate.usageTokens,
			trailingEstimateTokens: publicEstimate.trailingTokens,
			source: "usage-plus-estimate",
		});
		expect(estimate.usageTokens).toBe(115);
		expect(estimate.trailingEstimateTokens).toBeGreaterThan(0);
		expect(
			estimateAdvisorContext(messages, "next bounded update", "system policy", true, []).tokens,
		).toBe(estimate.tokens);

		const heuristicWithoutTools = estimateAdvisorContext(
			messages,
			"next bounded update",
			"system policy",
			false,
		);
		const heuristic = estimateAdvisorContext(
			messages,
			"next bounded update",
			"system policy",
			false,
			toolSchemas,
		);
		expect(heuristic.source).toBe("estimate-only");
		expect(heuristic.usageTokens).toBe(0);
		expect(heuristic.tokens).toBeGreaterThan(heuristicWithoutTools.tokens);
	});

	it("redacts and independently bounds each large tool result before update and re-prime bounds", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "keep this request", timestamp: 1 });
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "large-result",
			toolName: "read",
			content: [
				{
					type: "text",
					text: `API_KEY=tool-result-secret\n${Array.from(
						{ length: MAX_ADVISOR_TOOL_RESULT_LINES + 50 },
						(_, index) => `line-${String(index)}`,
					).join("\n")}${"z".repeat(MAX_ADVISOR_TOOL_RESULT_BYTES)}`,
				},
			],
			isError: false,
			timestamp: 2,
		});
		const rendered = renderAdvisorDelta(manager.getBranch(), 24_000);
		expect(rendered.text).toContain("[Tool result truncated to per-result limit]");
		expect(rendered.text).toContain("[REDACTED]");
		expect(rendered.text).not.toContain("tool-result-secret");
		expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(24_000 * 4);

		const reprime = renderAdvisorReprimeSnapshot(manager.getBranch(), 16);
		expect(Buffer.byteLength(reprime.text, "utf8")).toBeLessThanOrEqual(64);
		expect(reprime.text).not.toContain("tool-result-secret");
	});

	it("counts text and image tool output without retaining content", () => {
		const measured = measureAdvisorToolOutput([
			{ type: "text", text: "alpha\nbeta\n" },
			{ type: "text", text: "gamma" },
			{ type: "image", data: Buffer.from("four bytes", "utf8").toString("base64") },
		]);
		expect(measured).toEqual({
			outputBytes: Buffer.byteLength("alpha\nbeta\ngammafour bytes", "utf8"),
			outputLines: 3,
		});
		expect(measureAdvisorToolOutput([{ type: "text", text: "" }])).toEqual({
			outputBytes: 0,
			outputLines: 0,
		});
	});

	it("strictly separates legacy content records from metadata-only activity records", () => {
		const legacyUpdate = {
			version: 1 as const,
			sessionId: "session-1",
			savedAt: 1,
			kind: "update" as const,
			text: "Visible legacy Executor conclusion.",
			entryCount: 1,
			truncated: false,
		};
		expect(parsePersistedAdvisorTranscriptRecord(legacyUpdate, "session-1")).toEqual(legacyUpdate);

		const start = {
			version: ADVISOR_TRANSCRIPT_RECORD_VERSION,
			sessionId: "session-1",
			savedAt: 2,
			reviewId: "review-1",
			kind: "review-start" as const,
			entryCount: 3,
			truncated: true,
		};
		const attempt = {
			version: ADVISOR_TRANSCRIPT_RECORD_VERSION,
			sessionId: "session-1",
			savedAt: 3,
			reviewId: "review-1",
			kind: "tool-attempt" as const,
			ordinal: 1,
			toolName: "grep",
			internal: false,
			path: "src",
			pattern: "reviewId",
			completed: true,
			isError: false,
			outputBytes: 42,
			outputLines: 2,
		};
		const outcome = {
			version: ADVISOR_TRANSCRIPT_RECORD_VERSION,
			sessionId: "session-1",
			savedAt: 4,
			reviewId: "review-1",
			kind: "review-outcome" as const,
			outcome: "silent" as const,
			input: 10,
			output: 2,
			cacheRead: 3,
			cacheWrite: 0,
			total: 15,
			costUsd: 0.01,
			stopReason: "stop",
		};
		for (const record of [start, attempt, outcome]) {
			expect(parsePersistedAdvisorTranscriptRecord(record, "session-1")).toEqual(record);
		}
		for (const invalid of [
			{ ...start, text: "Executor body must not persist" },
			{ ...attempt, text: "tool result body" },
			{ ...attempt, arguments: { path: "src" } },
			{ ...attempt, query: "raw query" },
			{ ...attempt, pattern: "API_KEY=unsafe-persisted-secret" },
			{ ...outcome, advice: boundAdvice("private note", DEFAULT_ADVISOR_CONFIG) },
			{ ...outcome, version: 3 },
		]) {
			expect(parsePersistedAdvisorTranscriptRecord(invalid, "session-1")).toBeUndefined();
		}
	});

	it("collects only a bounded redacted tail across many older large entries", () => {
		const manager = SessionManager.inMemory();
		for (let index = 0; index < 24; index++) {
			manager.appendMessage({
				role: "toolResult",
				toolCallId: `large-result-${String(index)}`,
				toolName: "read",
				content: [
					{
						type: "text",
						text: `Bearer older-secret-value-${String(index)}\n${Array.from(
							{ length: MAX_ADVISOR_TOOL_RESULT_LINES + 100 },
							() => "x",
						).join("\n")}${"z".repeat(3_000)}`,
					},
				],
				isError: false,
				timestamp: index + 1,
			});
		}
		manager.appendCustomMessageEntry(ADVISOR_CUSTOM_TYPE, "excluded advisor note", true);
		manager.appendMessage({
			role: "user",
			content: "NEWEST-EXECUTOR-TAIL",
			timestamp: 100,
		});

		const originalByteLength = Buffer.byteLength.bind(Buffer);
		const byteLengthSpy = vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
			const bytes = originalByteLength(value, encoding);
			if (typeof value === "string" && bytes > 10_000) {
				throw new Error("rendering assembled an unbounded intermediate string");
			}
			return bytes;
		});
		let rendered: ReturnType<typeof renderAdvisorDelta>;
		try {
			rendered = renderAdvisorDelta(manager.getBranch(), 256);
		} finally {
			byteLengthSpy.mockRestore();
		}

		expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(1_024);
		expect(rendered.text).toContain("[Older Advisor update content truncated");
		expect(rendered.text).toContain("[Tool result truncated to per-result limit]");
		expect(rendered.text).toContain("NEWEST-EXECUTOR-TAIL");
		expect(rendered.text).not.toContain("excluded advisor note");
		expect(rendered.text).not.toContain("older-secret-value");
		expect(rendered.redactions).toBe(24);
		expect(rendered.entryCount).toBe(manager.getBranch().length);
		expect(rendered.truncated).toBe(true);
	});
});

describe("Slice 1 transcript filtering and redaction", () => {
	it("redacts common secret forms before update budgeting, including reasoning", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "Bearer bearer-secret-123456", timestamp: 1 });
		manager.appendMessage(
			assistant([
				{ type: "thinking", thinking: "PASSWORD=reasoning-secret-value" },
				{ type: "text", text: "token near boundary sk-test-abcdefghijklmnop" },
			]),
		);
		const rendered = renderAdvisorDelta(manager.getBranch(), 30);
		expect(rendered.text).toContain("[REDACTED]");
		expect(rendered.text).not.toContain("bearer-secret-123456");
		expect(rendered.text).not.toContain("reasoning-secret-value");
		expect(rendered.text).not.toContain("sk-test-abcdefghijklmnop");
		expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(120);
	});

	it("bounds successful Memory tool metadata by item and UTF-8 byte budgets", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(
			assistant(
				[
					{ type: "toolCall", id: "one", name: "memory_save", arguments: { text: "abcd" } },
					{ type: "toolCall", id: "two", name: "memory_suggest", arguments: { text: "ef" } },
					{ type: "toolCall", id: "three", name: "memory_suggest", arguments: { text: "g" } },
					{ type: "toolCall", id: "four", name: "memory_suggest", arguments: { text: "h" } },
				],
				"toolUse",
			),
		);
		for (const toolCallId of ["one", "two", "three", "four"]) {
			manager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: toolCallId === "one" ? "memory_save" : "memory_suggest",
				content: [{ type: "text", text: "queued" }],
				isError: toolCallId === "four",
				timestamp: Date.now(),
			});
		}

		const retained = successfulMemoryToolTexts(manager.getBranch(), 2, 5);
		expect([...retained]).toEqual(["ef", "g"]);
		expect([...retained].reduce((bytes, text) => bytes + Buffer.byteLength(text), 0)).toBe(3);
		expect(() => successfulMemoryToolTexts(manager.getBranch(), -1, 5)).toThrow(RangeError);
		expect(() => successfulMemoryToolTexts(manager.getBranch(), 1, -1)).toThrow(RangeError);

		const afterFailure = SessionManager.inMemory();
		afterFailure.appendMessage(
			assistant(
				[
					{ type: "toolCall", id: "failed", name: "memory_save", arguments: { text: "abcd" } },
					{ type: "toolCall", id: "replacement", name: "memory_save", arguments: { text: "xy" } },
				],
				"toolUse",
			),
		);
		afterFailure.appendMessage({
			role: "toolResult",
			toolCallId: "failed",
			toolName: "memory_save",
			content: [{ type: "text", text: "failed" }],
			isError: true,
			timestamp: Date.now(),
		});
		afterFailure.appendMessage({
			role: "toolResult",
			toolCallId: "replacement",
			toolName: "memory_save",
			content: [{ type: "text", text: "saved" }],
			isError: false,
			timestamp: Date.now(),
		});
		expect([...successfulMemoryToolTexts(afterFailure.getBranch(), 1, 4)]).toEqual(["xy"]);

		const normalizedBudget = SessionManager.inMemory();
		normalizedBudget.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "overlong",
						name: "memory_suggest",
						arguments: {
							text: "x".repeat(HARD_LIMITS.maxProposedMemoryCharacters * 2 + 1),
						},
					},
					{
						type: "toolCall",
						id: "normalized",
						name: "memory_suggest",
						arguments: { text: "   a   " },
					},
				],
				"toolUse",
			),
		);
		normalizedBudget.appendMessage({
			role: "toolResult",
			toolCallId: "overlong",
			toolName: "memory_suggest",
			content: [{ type: "text", text: "queued" }],
			isError: false,
			timestamp: Date.now(),
		});
		normalizedBudget.appendMessage({
			role: "toolResult",
			toolCallId: "normalized",
			toolName: "memory_suggest",
			content: [{ type: "text", text: "queued" }],
			isError: false,
			timestamp: Date.now(),
		});
		expect([...successfulMemoryToolTexts(normalizedBudget.getBranch(), 1, 1)]).toEqual(["a"]);
	});

	it("fully redacts quoted JSON and environment values containing spaces", () => {
		const redacted = redactSecrets(
			'"client_secret": "json secret value with spaces"\nMY_API_KEY=\'environment secret value with spaces\'\nSAFE=value',
		);
		expect(redacted.text).not.toContain("json secret value with spaces");
		expect(redacted.text).not.toContain("environment secret value with spaces");
		expect(redacted.text).toContain('"client_secret": [REDACTED]');
		expect(redacted.text).toContain("MY_API_KEY=[REDACTED]");
		expect(redacted.text).toContain("SAFE=value");
	});

	it("redacts private keys, credentials, and URL passwords", () => {
		const redacted = redactSecrets(
			'-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n"client_secret":"secret-json-value"\nhttps://user:url-password@example.com',
		);
		expect(redacted.redactions).toBeGreaterThanOrEqual(3);
		expect(redacted.text).not.toContain("abc123");
		expect(redacted.text).not.toContain("secret-json-value");
		expect(redacted.text).not.toContain("url-password");
	});

	it("formats every severity as structured delivery-safe XML", () => {
		for (const severity of ["nit", "concern", "blocker"] as const) {
			const advice = {
				...boundAdvice("Check the rollback path.", DEFAULT_ADVISOR_CONFIG),
				severity,
			};
			expect(formatAdviceForDelivery(advice, "active", false)).toContain(
				`severity="${severity}" delivery="active" stale="false"`,
			);
			expect(formatAdviceForDelivery(advice, "deferred", true)).toContain(
				`severity="${severity}" delivery="deferred" stale="true"`,
			);
		}
	});

	it("deduplicates only conservative prose variants and preserves code identity", () => {
		expect(normalizeAdviceForDedupe("  VERIFY rollback punctuation... ")).toBe(
			"verify rollback punctuation",
		);
		const dedupe = new BoundedAdviceDedupe(20);
		expect(dedupe.add(dedupeIdentity("Verify rollback punctuation!"))).toBe(true);
		expect(dedupe.add(dedupeIdentity("  VERIFY rollback punctuation... "))).toBe(false);

		for (const [left, right] of [
			["change < to >", "change > to <"],
			["change x != y", "change x = y"],
			["Use x / y", "Use x y"],
			["Negate !flag", "Negate flag"],
			["Add the missing ;", "Add the missing"],
			["Change `User` to `user`.", "Change `user` to `User`."],
			["Change ``User`` now.", "Change ``user`` now."],
		] as const) {
			expect(dedupe.add(dedupeIdentity(left))).toBe(true);
			expect(dedupe.add(dedupeIdentity(right))).toBe(true);
		}

		expect(normalizeAdviceForDedupe("CHANGE `User` NOW!")).toBe("change `User` now");
		expect(adviceDedupeKey(dedupeIdentity("Use `a  b` here."))).not.toBe(
			adviceDedupeKey(dedupeIdentity("Use `a b` here.")),
		);
		expect(dedupe.add(dedupeIdentity("CHANGE `Account` NOW!"))).toBe(true);
		expect(dedupe.add(dedupeIdentity("change `Account` now..."))).toBe(false);
	});

	it("avoids case and trailing-punctuation suppression for unmatched backticks", () => {
		expect(normalizeAdviceForDedupe("  Review `User carefully... ")).toBe(
			"Review `User carefully...",
		);
		const dedupe = new BoundedAdviceDedupe(4);
		expect(dedupe.add(dedupeIdentity("Review `User carefully."))).toBe(true);
		expect(dedupe.add(dedupeIdentity("Review `User carefully..."))).toBe(true);
		expect(dedupe.add(dedupeIdentity("review `user carefully..."))).toBe(true);
	});

	it("deduplicates Memory suggestions by proposed text, category, and basis rather than rationale", () => {
		const first = {
			intent: "memory-suggestion" as const,
			memory: {
				text: "Use sfw-prefixed pnpm commands.",
				category: "project" as const,
				basis: "project-constraint" as const,
			},
		};
		const sameProposal = {
			...first,
			memory: { ...first.memory, text: "  USE sfw-prefixed pnpm commands... " },
		};
		const differentBasis = {
			...first,
			memory: { ...first.memory, basis: "project-procedure" as const },
		};
		expect(adviceDedupeKey(first)).toBe(adviceDedupeKey(sameProposal));
		expect(adviceDedupeKey(first)).not.toBe(adviceDedupeKey(differentBasis));
	});

	it("ignores severity in review identity and retains FIFO insertion order", () => {
		const dedupe = new BoundedAdviceDedupe(2);
		expect(dedupe.add(dedupeIdentity("Verify rollback!", "nit"))).toBe(true);
		expect(dedupe.add(dedupeIdentity("Check migrations"))).toBe(true);
		expect(dedupe.add(dedupeIdentity("VERIFY rollback...", "nit"))).toBe(false);
		expect(dedupe.add(dedupeIdentity("Verify rollback!", "blocker"))).toBe(false);
		expect(dedupe.size).toBe(2);
		expect(dedupe.delete(dedupeIdentity("Verify rollback!", "blocker"))).toBe(true);
		expect(dedupe.add(dedupeIdentity("Inspect atomic writes"))).toBe(true);
		expect(dedupe.add(dedupeIdentity("Verify rollback!", "nit"))).toBe(true);
	});

	it("treats a finding key as the authoritative identity for one concrete defect", () => {
		const dedupe = new BoundedAdviceDedupe(4);
		const cancellationIdentity = "a".repeat(64);
		expect(
			dedupe.add({
				note: "Cancel writes configuration before confirmation.",
				severity: "blocker",
				findingKeyHash: cancellationIdentity,
			}),
		).toBe(true);
		expect(
			dedupe.add({
				note: "The cancellation path is not atomic because it persists too early.",
				severity: "concern",
				findingKeyHash: cancellationIdentity,
			}),
		).toBe(false);
		expect(
			dedupe.add({
				note: "Cancellation leaks a temporary file.",
				severity: "concern",
				findingKeyHash: "b".repeat(64),
			}),
		).toBe(true);
	});

	it("bounds keyed FIFO admission by items and raw bytes without evicting older entries", () => {
		const queue = new BoundedKeyedByteFifo<string>(2, 5);
		expect(queue.enqueue("a", "one", 3)).toBe("accepted");
		expect(queue.enqueue("a", "duplicate", 1)).toBe("duplicate");
		expect(queue.enqueue("b", "two", 2)).toBe("accepted");
		expect(queue.enqueue("c", "three", 1)).toBe("capacity");
		expect(queue.values()).toEqual(["one", "two"]);
		expect(queue.totalBytes).toBe(5);
		expect(queue.shift()).toMatchObject({ key: "a", value: "one", bytes: 3 });
		expect(queue.totalBytes).toBe(2);
		expect(queue.enqueue("c", "three", 3)).toBe("accepted");
		expect(queue.remove("b")).toMatchObject({ key: "b", value: "two", bytes: 2 });
		expect(queue.values()).toEqual(["three"]);
		expect(queue.totalBytes).toBe(3);
	});

	it("keeps one hard-bounded note below the deferred delivery batch limit", () => {
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.limits.maxAdviceCharacters = HARD_LIMITS.maxAdviceCharacters;
		config.limits.maxAdviceTokens = HARD_LIMITS.maxAdviceTokens;
		const advice = boundAdvice("😀".repeat(HARD_LIMITS.maxAdviceCharacters), config);
		const formatted = formatAdviceForDelivery(advice, "deferred", true);
		expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(MAX_DEFERRED_DELIVERY_BYTES);
	});

	it("takes byte-bounded rendered FIFO prefixes and retains the remainder", () => {
		const queue = new BoundedKeyedByteFifo<string>(4, 100);
		for (const value of ["aa", "bb", "cc"]) {
			expect(queue.enqueue(value, value, Buffer.byteLength(value, "utf8"))).toBe("accepted");
		}
		const first = takeRenderedPrefix(queue, 6, (value) => value);
		expect(first.map(({ value }) => value)).toEqual(["aa", "bb"]);
		expect(first.map(({ rendered }) => rendered).join("\n\n")).toBe("aa\n\nbb");
		expect(queue.values()).toEqual(["cc"]);
		const second = takeRenderedPrefix(queue, 6, (value) => value);
		expect(second.map(({ value }) => value)).toEqual(["cc"]);
		expect(queue.length).toBe(0);

		const oversized = new BoundedKeyedByteFifo<string>(1, 100);
		expect(oversized.enqueue("x", "1234567", 7)).toBe("accepted");
		expect(() => takeRenderedPrefix(oversized, 6, (value) => value)).toThrow(
			"exceeds the prefix byte bound",
		);
		expect(oversized.values()).toEqual(["1234567"]);
		expect(oversized.totalBytes).toBe(7);
		expect(oversized.has("x")).toBe(true);
	});

	it.each([
		{
			name: "renderer failure",
			render: (value: string) => {
				if (value === "bb") throw new Error("renderer failed");
				return value;
			},
			error: "renderer failed",
		},
		{
			name: "oversized later candidate",
			render: (value: string) => (value === "bb" ? "1234567" : value),
			error: "exceeds the prefix byte bound",
		},
	])("leaves FIFO state unchanged after $name", ({ render, error }) => {
		const queue = new BoundedKeyedByteFifo<string>(4, 100);
		for (const value of ["aa", "bb", "cc"]) {
			expect(queue.enqueue(value, value, Buffer.byteLength(value, "utf8"))).toBe("accepted");
		}

		expect(() => takeRenderedPrefix(queue, 6, render)).toThrow(error);
		expect(queue.values()).toEqual(["aa", "bb", "cc"]);
		expect(queue.length).toBe(3);
		expect(queue.totalBytes).toBe(6);
		for (const key of ["aa", "bb", "cc"]) {
			expect(queue.has(key)).toBe(true);
			expect(queue.enqueue(key, "duplicate", 1)).toBe("duplicate");
		}
	});

	it("reviews failed Executor tool evidence appended after an Advisor note", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomMessageEntry(
			ADVISOR_CUSTOM_TYPE,
			"Advisor note that prompted the recovery attempt.",
			true,
		);
		const resumeAttempt = assistant(
			[
				{
					type: "toolCall",
					id: "resume-worker",
					name: "resume_worker",
					arguments: { workerId: "worker-1" },
				},
			],
			"toolUse",
		);
		manager.appendMessage(resumeAttempt);
		const failedResult = {
			role: "toolResult" as const,
			toolCallId: "resume-worker",
			toolName: "resume_worker",
			content: [{ type: "text" as const, text: "Invalid async recovery descriptor" }],
			isError: true,
			timestamp: Date.now(),
		};
		manager.appendMessage(failedResult);
		const entries = manager.getBranch();
		const event: TurnEndEvent = {
			type: "turn_end",
			turnIndex: 0,
			message: resumeAttempt,
			toolResults: [failedResult],
		};

		expect(isMeaningfulExecutorTurn(event, entries)).toBe(true);
		const rendered = renderAdvisorDelta(entries, 1_024);
		expect(rendered.text).toContain('[tool call resume_worker] {"workerId":"worker-1"}');
		expect(rendered.text).toContain("[Executor tool result resume_worker error]");
		expect(rendered.text).toContain("Invalid async recovery descriptor");
		expect(rendered.text).not.toContain("Advisor note that prompted the recovery attempt.");
	});

	it("skips aborted, empty, and Advisor-generated turns", () => {
		const aborted: TurnEndEvent = {
			type: "turn_end",
			turnIndex: 0,
			message: assistant([{ type: "text", text: "partial" }], "aborted"),
			toolResults: [],
		};
		const empty: TurnEndEvent = {
			...aborted,
			message: assistant([]),
		};
		const advisorGenerated: TurnEndEvent = {
			...aborted,
			message: assistant([{ type: "text", text: "weighed advisory" }]),
		};
		const manager = SessionManager.inMemory();
		manager.appendMessage(
			assistant(
				[{ type: "toolCall", id: "older-call", name: "inspect", arguments: {} }],
				"toolUse",
			),
		);
		manager.appendCustomMessageEntry("pi-advisor-note", "peer note", true);
		expect(isMeaningfulExecutorTurn(aborted, [])).toBe(false);
		expect(isMeaningfulExecutorTurn(empty, [])).toBe(false);
		expect(isMeaningfulExecutorTurn(advisorGenerated, manager.getBranch())).toBe(false);
		expect(
			isMeaningfulExecutorTurn(
				{ ...empty, message: assistant([{ type: "text", text: "ordinary answer" }]) },
				[],
			),
		).toBe(true);
	});
});

describe("Quality Slice Q5 dedupe accuracy", () => {
	const POLICY: DedupePolicy = { similarityRedeliveryThreshold: 0.5, reRaiseMinTurns: 4 };

	function finding(
		note: string,
		severity: AdviceSeverity = "concern",
	): AdviceDedupeIdentity & { note: string } {
		return { note, severity, intent: "review", findingKeyHash: "a".repeat(64) };
	}

	it("computes 64-bit SimHash similarity with identity 1.0 and full range", () => {
		const a = noteSignature("The rollback path drops the pending migration state on failure.");
		expect(noteSignature("The rollback path drops the pending migration state on failure.")).toBe(
			a,
		);
		expect(noteSimilarity(a, a)).toBe(1);
		expect(hammingDistance64(0n, 0n)).toBe(0);
		expect(hammingDistance64(0n, (1n << 32n) - 1n)).toBe(32);
		expect(noteSimilarity(0n, (1n << 32n) - 1n)).toBe(0.5);
		expect(noteSimilarity(0n, (1n << 64n) - 1n)).toBe(0);
		const short = noteSignature("one");
		expect(short).toBe(noteSignature(" ONE "));
	});

	it("suppresses paraphrase findingKey reuse and near-identical notes", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = finding("The rollback path drops the pending migration state on failure.");
		expect(dedupe.add(first, 1)).toBe(true);
		const paraphrase = finding(
			"The rollback path loses the pending migration state when it fails.",
		);
		const nearIdentical = finding(
			"The rollback path drops the pending migration state on failure, leaving stale data.",
		);
		expect(
			noteSimilarity(noteSignature(first.note), noteSignature(paraphrase.note)),
		).toBeGreaterThanOrEqual(0.5);
		expect(
			noteSimilarity(noteSignature(first.note), noteSignature(nearIdentical.note)),
		).toBeGreaterThanOrEqual(0.5);
		expect(dedupe.decide(paraphrase, 2, POLICY)).toEqual({ outcome: "suppress" });
		expect(dedupe.decide(nearIdentical, 2, POLICY)).toEqual({ outcome: "suppress" });
	});

	it("delivers a dissimilar findingKey reuse with the possible-duplicate tag", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = finding("The rollback path drops the pending migration state on failure.");
		dedupe.add(first, 1);
		const distinct = finding(
			"Feature flags are read after the configuration file is closed, so values always come back empty.",
		);
		const similarity = noteSimilarity(noteSignature(first.note), noteSignature(distinct.note));
		expect(similarity).toBeLessThan(0.5);
		expect(dedupe.decide(distinct, 2, POLICY)).toEqual({
			outcome: "deliver",
			tag: "possible-duplicate",
		});
	});

	it("treats a zero threshold as disabled and boundary equality as suppressed", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = finding("The rollback path drops the pending migration state on failure.");
		dedupe.add(first, 1);
		const distinct = finding(
			"Feature flags are read after the configuration file is closed, so values always come back empty.",
		);
		const similarity = noteSimilarity(noteSignature(first.note), noteSignature(distinct.note));
		expect(
			dedupe.decide(distinct, 2, { similarityRedeliveryThreshold: 0, reRaiseMinTurns: 4 }),
		).toEqual({ outcome: "suppress" });
		expect(
			dedupe.decide(distinct, 2, {
				similarityRedeliveryThreshold: similarity,
				reRaiseMinTurns: 0,
			}),
		).toEqual({ outcome: "suppress" });
		expect(
			dedupe.decide(distinct, 2, {
				similarityRedeliveryThreshold: similarity + 1 / 64,
				reRaiseMinTurns: 0,
			}),
		).toEqual({ outcome: "deliver", tag: "possible-duplicate" });
	});

	it("re-raises only after the configured turn distance and only for strictly higher severity", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = finding(
			"The rollback path drops the pending migration state on failure.",
			"concern",
		);
		dedupe.add(first, 1);
		expect(dedupe.decide(finding(first.note, "blocker"), 2, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(dedupe.decide(finding(first.note, "blocker"), 4, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(dedupe.decide(finding(first.note, "blocker"), 5, POLICY)).toEqual({
			outcome: "deliver",
			tag: "re-raised",
		});
		expect(dedupe.decide(finding(first.note, "concern"), 9, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(dedupe.decide(finding(first.note, "nit"), 9, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(
			dedupe.decide(finding(first.note, "blocker"), 9, {
				similarityRedeliveryThreshold: 0.5,
				reRaiseMinTurns: 0,
			}),
		).toEqual({ outcome: "suppress" });
	});

	it("updates stored severity and turn metadata on redelivery", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = finding(
			"The rollback path drops the pending migration state on failure.",
			"concern",
		);
		expect(dedupe.add(first, 1)).toBe(true);
		expect(dedupe.add(finding(first.note, "blocker"), 5)).toBe(false);
		expect(dedupe.decide(finding(first.note, "blocker"), 6, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(dedupe.decide(finding(first.note, "concern"), 5, POLICY)).toEqual({
			outcome: "suppress",
		});
	});

	it("keeps metadata-free restored keys on exact pre-Q5 suppress-always behavior", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		dedupe.restoreEntries([{ hash: adviceDedupeKey(finding("Any note.")) }]);
		expect(
			dedupe.decide(
				finding(
					"Feature flags are read after the configuration file is closed, so values always come back empty.",
					"blocker",
				),
				9,
				POLICY,
			),
		).toEqual({ outcome: "suppress" });
	});

	it("keeps exact suppression for non-finding identities regardless of severity", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		dedupe.add(dedupeIdentity("Verify rollback punctuation!"), 1);
		expect(
			dedupe.decide(dedupeIdentity("VERIFY rollback punctuation...", "blocker"), 9, POLICY),
		).toEqual({ outcome: "suppress" });
		const memory: AdviceDedupeIdentity = {
			intent: "memory-suggestion",
			memory: {
				text: "Use sfw-prefixed pnpm commands.",
				category: "project",
				basis: "project-constraint",
			},
		};
		dedupe.add(memory, 1);
		expect(dedupe.decide(memory, 9, POLICY)).toEqual({ outcome: "suppress" });
	});

	it("records metadata only for findingKey review notes and evicts it with the key", () => {
		const dedupe = new BoundedAdviceDedupe(2);
		expect(dedupe.add(dedupeIdentity("Plain review note."), 1)).toBe(true);
		const memory: AdviceDedupeIdentity = {
			intent: "memory-suggestion",
			memory: {
				text: "Use sfw-prefixed pnpm commands.",
				category: "project",
				basis: "project-constraint",
			},
		};
		expect(dedupe.add(memory, 1)).toBe(true);
		const first = finding("The rollback path drops the pending migration state on failure.");
		expect(dedupe.add(first, 1)).toBe(true);
		expect(dedupe.has(dedupeIdentity("Plain review note."))).toBe(false);
		expect(dedupe.has(first)).toBe(true);
		const exported = dedupe.exportNewestEntries(8);
		const findingEntry = exported.find((entry) => entry.hash === adviceDedupeKey(first));
		expect(findingEntry?.metadata).toEqual({
			severity: "concern",
			signature: noteSignature(first.note).toString(16).padStart(16, "0"),
			lastDeliveryTurn: 1,
		});
		for (const entry of exported) {
			if (entry.hash !== adviceDedupeKey(first)) expect(entry.metadata).toBeUndefined();
		}
	});

	it("restores persisted metadata and rejects malformed entries", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = finding("The rollback path drops the pending migration state on failure.");
		const key = adviceDedupeKey(first);
		const signature = noteSignature(first.note).toString(16).padStart(16, "0");
		dedupe.restoreEntries([
			{ hash: key, metadata: { severity: "concern", signature, lastDeliveryTurn: 1 } },
			{
				hash: "f".repeat(64),
				metadata: {
					severity: "urgent" as AdviceSeverity,
					signature,
					lastDeliveryTurn: 1,
				},
			},
			{
				hash: "e".repeat(64),
				metadata: { severity: "concern", signature: "not-hex", lastDeliveryTurn: 1 },
			},
			{
				hash: "d".repeat(64),
				metadata: { severity: "concern", signature, lastDeliveryTurn: 0 },
			},
		]);
		expect(dedupe.size).toBe(1);
		expect(dedupe.decide(finding(first.note, "blocker"), 5, POLICY)).toEqual({
			outcome: "deliver",
			tag: "re-raised",
		});
		const distinct = finding(
			"Feature flags are read after the configuration file is closed, so values always come back empty.",
		);
		expect(dedupe.decide(distinct, 2, POLICY)).toEqual({
			outcome: "deliver",
			tag: "possible-duplicate",
		});
	});
});

describe("Quality Slice Q5 dedupe rollback restoration", () => {
	const POLICY: DedupePolicy = { similarityRedeliveryThreshold: 0.5, reRaiseMinTurns: 4 };

	function finding(
		note: string,
		severity: AdviceSeverity = "concern",
	): AdviceDedupeIdentity & { note: string } {
		return { note, severity, intent: "review", findingKeyHash: "a".repeat(64) };
	}

	it("restores prior metadata on rollback instead of deleting a re-delivered key", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = finding(
			"The rollback path drops the pending migration state on failure.",
			"concern",
		);
		dedupe.add(first, 1);
		const blocker = finding(first.note, "blocker");
		const snapshot = dedupe.snapshotEntry(blocker);
		expect(dedupe.add(blocker, 5)).toBe(false);
		dedupe.restoreEntry(snapshot);
		expect(dedupe.size).toBe(1);
		const entries = dedupe.exportNewestEntries(8);
		expect(entries.find((entry) => entry.hash === adviceDedupeKey(first))?.metadata).toEqual({
			severity: "concern",
			signature: noteSignature(first.note).toString(16).padStart(16, "0"),
			lastDeliveryTurn: 1,
		});
		expect(dedupe.decide(blocker, 5, POLICY)).toEqual({
			outcome: "deliver",
			tag: "re-raised",
		});
	});

	it("restoring a fresh-key snapshot deletes the inserted key", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = finding("The rollback path drops the pending migration state on failure.");
		const snapshot = dedupe.snapshotEntry(first);
		dedupe.add(first, 1);
		dedupe.restoreEntry(snapshot);
		expect(dedupe.size).toBe(0);
		expect(dedupe.decide(first, 9, POLICY)).toEqual({ outcome: "deliver" });
	});

	it("back-fills metadata onto an entry inserted without a turn", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = finding("The rollback path drops the pending migration state on failure.");
		dedupe.add(first);
		expect(dedupe.decide(finding(first.note, "blocker"), 5, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(dedupe.add(first, 1)).toBe(false);
		expect(dedupe.decide(finding(first.note, "blocker"), 5, POLICY)).toEqual({
			outcome: "deliver",
			tag: "re-raised",
		});
		const distinct = finding(
			"Feature flags are read after the configuration file is closed, so values always come back empty.",
		);
		expect(dedupe.decide(distinct, 2, POLICY)).toEqual({
			outcome: "deliver",
			tag: "possible-duplicate",
		});
	});
});
