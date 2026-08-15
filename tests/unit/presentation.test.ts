import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_ADVISOR_CONFIG,
	escapeXmlAttribute,
	escapeXmlText,
	formatAdviceCardMarkdown,
	formatAdviceForDelivery,
	formatAdvisorDiagnosticsDump,
	formatAdvisorFooterStatus,
	shouldAnimateAdvisorFooter,
	HARD_LIMITS,
	MAX_ADVISOR_DUMP_BYTES,
	MAX_DEFERRED_DELIVERY_BYTES,
	MAX_PENDING_ADVICE_ITEMS,
	renderAdviceCards,
	renderAdviceMessage,
	renderLateAdviceEntry,
	type AdvicePresentationNote,
	type AdvisorRuntimeStatus,
	type PersistedAdvisorTranscriptRecord,
} from "../../src/index.js";

function fixtureTheme(ansi: boolean, borderColors?: string[]): Theme {
	const style = (open: string, text: string): string =>
		ansi ? `\u001B[${open}m${text}\u001B[0m` : text;
	return {
		fg: (color: string, text: string) => {
			if (text === "│") borderColors?.push(color);
			return style("33", text);
		},
		bg: (_color: string, text: string) => style("40", text),
		bold: (text: string) => style("1", text),
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
	} as Theme;
}

function recordingTheme(borderColors: string[]): Theme {
	return fixtureTheme(false, borderColors);
}

function presentationNote(
	overrides: Partial<Extract<AdvicePresentationNote, { intent: "review" }>> = {},
): AdvicePresentationNote {
	return {
		intent: "review",
		note: "Verify the narrow and wide rendering path before shipping this longer advisory note.",
		severity: "concern",
		delivery: "deferred",
		stale: true,
		truncated: false,
		originalCharacters: 84,
		originalEstimatedTokens: 21,
		createdAt: 1_700_000_000_000,
		...overrides,
	};
}

function runtimeStatus(): AdvisorRuntimeStatus {
	return {
		enabled: true,
		active: true,
		paused: false,
		activationSource: "session-command",
		model: "fixture/model",
		effort: "high",
		backlog: false,
		reviewing: false,
		pendingTranscriptBytes: 0,
		maxPendingTranscriptBytesObserved: 0,
		retryPending: false,
		retryDelayMs: 0,
		retryAttempts: 0,
		contextEstimateTokens: 20,
		contextLimitTokens: 100,
		contextUsageTokens: 12,
		contextTrailingEstimateTokens: 8,
		contextEstimateSource: "usage-plus-estimate",
		compactionsCompleted: 1,
		compactionFailures: 0,
		compactionUsageUnavailable: 1,
		contextReprimesCompleted: 0,
		contextReprimeFailures: 0,
		sessionTokenSoftCap: "off",
		sessionCostSoftCapUsd: "off",
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, costUsd: 0.01 },
		reviewRequests: 1,
		reviewsCompleted: 1,
		silentReviews: 0,
		reviewsSuperseded: 0,
		failedReviews: 0,
		effectiveMinTurnsBetweenReviews: 1,
		governorSkippedReviews: 0,
		deliveryFailures: 0,
		notesDelivered: 1,
		activeNotesPending: 0,
		deferredNotesPending: 0,
		restoredDeferredNotesPending: 0,
		oldestDeferredAdviceAgeMs: 0,
		notesSuppressed: 0,
		memorySuggestionCapability: { state: "available" },
		memorySuggestionsEnabled: true,
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
		epoch: 1,
		nestedExtensionCount: 0,
		nestedActiveTools: ["read", "advise"],
	};
}

describe("Advisor presentation and diagnostics through Slice 5", () => {
	it("renders a compact active, queued, reviewing, paused, or hidden footer status", () => {
		const status = runtimeStatus();
		expect(formatAdvisorFooterStatus(status)).toBe("Advisor active");
		expect(formatAdvisorFooterStatus({ ...status, modelName: "Grok 4.5" })).toBe(
			"Advisor active (Grok 4.5)",
		);
		expect(formatAdvisorFooterStatus({ ...status, backlog: true, pendingTranscriptBytes: 1 })).toBe(
			"Advisor active · 1 byte queued",
		);
		expect(
			formatAdvisorFooterStatus({
				...status,
				modelName: "Grok 4.5",
				backlog: true,
				pendingTranscriptBytes: 2048,
			}),
		).toBe("Advisor active (Grok 4.5) · 2048 bytes queued");
		expect(
			formatAdvisorFooterStatus({ ...status, backlog: true, pendingTranscriptBytes: 2048 }),
		).toBe("Advisor active · 2048 bytes queued");
		expect(
			formatAdvisorFooterStatus({
				...status,
				reviewing: true,
				backlog: true,
				pendingTranscriptBytes: 2048,
			}),
		).toBe("Advisor reviewing");
		expect(
			formatAdvisorFooterStatus({
				...status,
				modelName: "Grok 4.5",
				reviewing: true,
			}),
		).toBe("Advisor reviewing (Grok 4.5)");
		expect(
			formatAdvisorFooterStatus({
				...status,
				active: false,
				paused: true,
				reviewing: true,
				backlog: true,
			}),
		).toBe("Advisor paused · 0 bytes queued");
		expect(formatAdvisorFooterStatus({ ...status, active: false, paused: true })).toBe(
			"Advisor paused",
		);
		expect(
			formatAdvisorFooterStatus({
				...status,
				active: false,
				paused: true,
				modelName: "Grok 4.5",
			}),
		).toBe("Advisor paused (Grok 4.5)");
		expect(formatAdvisorFooterStatus({ ...status, enabled: false, active: false })).toBeUndefined();
		expect(shouldAnimateAdvisorFooter({ ...status, reviewing: true }, "tui")).toBe(true);
		expect(shouldAnimateAdvisorFooter({ ...status, reviewing: true }, "rpc")).toBe(false);
		expect(
			shouldAnimateAdvisorFooter(
				{ ...status, active: false, paused: true, reviewing: true },
				"tui",
			),
		).toBe(false);
	});

	it("escapes XML text, attributes, and invalid XML control characters", () => {
		expect(escapeXmlText(`A & B < C > D\u0000 "quoted"`)).toBe(
			`A &amp; B &lt; C &gt; D\uFFFD "quoted"`,
		);
		expect(escapeXmlAttribute(`A & B < C > D "quoted" 'single'`)).toBe(
			"A &amp; B &lt; C &gt; D &quot;quoted&quot; &apos;single&apos;",
		);
		const rendered = formatAdviceForDelivery(
			presentationNote({ note: `Compare <old> & "new" before 'ship'.` }),
			"active",
			false,
		);
		expect(rendered).toContain("<note>Compare &lt;old&gt; &amp; \"new\" before 'ship'.</note>");
		expect(rendered).not.toContain("<old>");
	});

	it("neutralizes carriage returns in terminal-rendered note text", () => {
		const lines = renderAdviceCards(
			[presentationNote({ note: "safe text\roverwrite attempt" })],
			false,
			fixtureTheme(false),
			1_700_000_000_000,
		).render(80);
		const rendered = lines.join("\n");
		expect(rendered).not.toContain("\r");
		expect(rendered).toContain("safe text\uFFFDoverwrite attempt");
	});

	it("formats inline numbered actions as a Markdown list without inventing lists", () => {
		expect(
			formatAdviceCardMarkdown(
				"Avoid printing `gh auth token` output; 1) redact the whole helper line, and 2) treat exposed prefixes as rotation candidates.",
			),
		).toBe(
			[
				"Avoid printing `gh auth token` output",
				"",
				"1) redact the whole helper line",
				"2) treat exposed prefixes as rotation candidates.",
			].join("\n"),
		);
		expect(
			formatAdviceCardMarkdown("Version 1. 2 extra files remain after the failed publish."),
		).toBe("Version 1. 2 extra files remain after the failed publish.");
		expect(
			formatAdviceCardMarkdown(
				"Either 1) keep the current cache, or 2) rebuild it from the source files.",
			),
		).toBe("Either 1) keep the current cache, or 2) rebuild it from the source files.");
	});

	it("splits a long note into a short lead and supporting body", () => {
		expect(
			formatAdviceCardMarkdown(
				"Secret hygiene: the debug command printed live OAuth token prefixes into the transcript. Avoid echoing `gh auth token` output and redact the whole helper line.",
			),
		).toBe(
			[
				"Secret hygiene:",
				"",
				"the debug command printed live OAuth token prefixes into the transcript. Avoid echoing `gh auth token` output and redact the whole helper line.",
			].join("\n"),
		);
		expect(
			formatAdviceCardMarkdown(
				"The drafted response ends in a repetition loop. The same closing paragraph is duplicated several times and would deliver a broken proposal.",
			),
		).toBe(
			[
				"The drafted response ends in a repetition loop.",
				"",
				"The same closing paragraph is duplicated several times and would deliver a broken proposal.",
			].join("\n"),
		);
		expect(
			formatAdviceCardMarkdown(
				"Use e.g. a fixture path rather than a live token when the helper must be tested.",
			),
		).toBe("Use e.g. a fixture path rather than a live token when the helper must be tested.");
		expect(
			formatAdviceCardMarkdown("Fix the `mode: primary` flag so reviewers can override it now."),
		).toBe("Fix the `mode: primary` flag so reviewers can override it now.");
	});

	it("renders numbered actions on separate card lines", () => {
		const rendered = renderAdviceCards(
			[
				presentationNote({
					note: "Secret hygiene: 1) avoid printing `gh auth token` output, and 2) redact the whole helper line.",
				}),
			],
			false,
			fixtureTheme(false),
			1_700_000_000_000,
		)
			.render(80)
			.join("\n");
		expect(rendered).toContain("1) avoid printing");
		expect(rendered).toContain("2) redact the whole helper line.");
		expect(rendered.indexOf("1) avoid printing")).toBeLessThan(
			rendered.indexOf("2) redact the whole helper line."),
		);
		expect(rendered).not.toMatch(/1\) avoid printing.*2\) redact/u);
	});

	it.each([
		{ width: 24, expanded: false },
		{ width: 100, expanded: true },
	])("keeps $width-column advice cards within terminal width", ({ width, expanded }) => {
		for (const theme of [fixtureTheme(false), fixtureTheme(true)]) {
			const component = renderAdviceCards(
				[presentationNote(), presentationNote({ severity: "blocker", note: "Second note." })],
				expanded,
				theme,
				1_700_000_065_000,
			);
			const lines = component.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("colors every card border by severity and Memory suggestions independently", () => {
		const borderColors: string[] = [];
		const memoryNote: AdvicePresentationNote = {
			intent: "memory-suggestion",
			note: "Remember the durable procedure.",
			memory: {
				text: "Use the verified procedure.",
				category: "project",
				basis: "project-procedure",
			},
			delivery: "active",
			truncated: false,
			originalCharacters: 31,
			originalEstimatedTokens: 8,
			createdAt: 1_700_000_000_000,
		};
		const component = renderAdviceCards(
			[
				presentationNote({ severity: "nit" }),
				presentationNote({ severity: "concern" }),
				presentationNote({ severity: "blocker" }),
				memoryNote,
			],
			false,
			recordingTheme(borderColors),
			1_700_000_000_000,
		);
		const lines = component.render(60);
		component.invalidate();
		expect(lines.filter((line) => line.length > 0 && !line.startsWith("│ "))).toEqual([]);
		expect(new Set(borderColors)).toEqual(new Set(["accent", "warning", "error"]));
		expect(borderColors[0]).toBe("accent");
		expect(borderColors).toContain("warning");
		expect(borderColors).toContain("error");
		expect(borderColors.at(-1)).toBe("accent");
	});

	it("uses the bordered shared render path for messages and late entries", () => {
		const note = presentationNote({ severity: "blocker" });
		const theme = fixtureTheme(false);
		const messageComponent = renderAdviceMessage(
			{
				role: "custom",
				customType: "pi-advisor-note",
				content: "advice",
				display: true,
				details: { notes: [note] },
				timestamp: note.createdAt,
			},
			{ expanded: false },
			theme,
		);
		const lateComponent = renderLateAdviceEntry(
			{
				type: "custom",
				customType: "pi-advisor-late-note",
				data: { note, displayedAt: 1 },
			} as Parameters<typeof renderLateAdviceEntry>[0],
			{ expanded: false },
			theme,
		);
		expect(
			messageComponent?.render(60).every((line) => line.length === 0 || line.startsWith("│ ")),
		).toBe(true);
		expect(
			lateComponent?.render(60).every((line) => line.length === 0 || line.startsWith("│ ")),
		).toBe(true);
	});

	it("renders restored deferred advice with its age and resume marker", () => {
		const lines = renderAdviceCards(
			[presentationNote({ restoredAfterResume: true })],
			false,
			fixtureTheme(false),
			1_700_007_200_000,
		).render(80);
		const rendered = lines.join("\n");
		expect(rendered).toContain("2h ago");
		expect(rendered).toContain("potentially stale");
		expect(rendered).toContain("restored after resume");
	});

	it("renders Memory suggestions distinctly with proposed text and queue state", () => {
		const memoryNote: AdvicePresentationNote = {
			intent: "memory-suggestion",
			note: "This workflow is durable across future sessions.",
			memory: {
				text: "Install packages only with sfw-prefixed pnpm commands.",
				category: "project",
				basis: "project-procedure",
			},
			delivery: "deferred",
			queueState: "could-not-queue",
			truncated: false,
			originalCharacters: 47,
			originalEstimatedTokens: 12,
			createdAt: 1_700_000_000_000,
		};
		const lines = renderAdviceCards(
			[memoryNote],
			true,
			fixtureTheme(false),
			1_700_000_000_000,
		).render(60);
		const rendered = lines.join("\n");
		expect(rendered).toContain("MEMORY SUGGESTION - COULD NOT QUEUE");
		const activeMemoryNote = structuredClone(memoryNote);
		activeMemoryNote.delivery = "active";
		delete activeMemoryNote.queueState;
		const activeRendered = renderAdviceCards(
			[activeMemoryNote],
			false,
			fixtureTheme(false),
			1_700_000_000_000,
		)
			.render(60)
			.join("\n");
		expect(activeRendered).toContain("active guidance");
		expect(activeRendered).not.toContain("next-turn guidance");
		expect(rendered).toContain("Proposed memory");
		expect(rendered).toContain("sfw-prefixed pnpm");
		expect(rendered).toContain("project-procedure");
		for (const width of [24, 100]) {
			for (const theme of [fixtureTheme(false), fixtureTheme(true)]) {
				const themedLines = renderAdviceCards([memoryNote], true, theme, 1_700_000_000_000).render(
					width,
				);
				for (const line of themedLines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("falls back to Pi rendering when message details are malformed or oversized", () => {
		expect(
			renderAdviceMessage(
				{
					role: "custom",
					customType: "pi-advisor-note",
					content: "legacy advice",
					display: true,
					details: { notes: [{ invalid: true }] },
					timestamp: 1_700_000_000_000,
				},
				{ expanded: false },
				fixtureTheme(false),
			),
		).toBeUndefined();
		expect(
			renderAdviceMessage(
				{
					role: "custom",
					customType: "pi-advisor-note",
					content: "invalid timestamp advice",
					display: true,
					details: {
						notes: [presentationNote({ createdAt: 8_640_000_000_000_001 })],
					},
					timestamp: 1_700_000_000_000,
				},
				{ expanded: false },
				fixtureTheme(false),
			),
		).toBeUndefined();
		const baseMessage = {
			role: "custom" as const,
			customType: "pi-advisor-note",
			content: "oversized details",
			display: true,
			timestamp: 1_700_000_000_000,
		};
		for (const notes of [
			[presentationNote({ note: "x".repeat(HARD_LIMITS.maxAdviceCharacters + 1) })],
			Array.from({ length: MAX_PENDING_ADVICE_ITEMS + 1 }, () => presentationNote({ note: "x" })),
			Array.from({ length: Math.floor(MAX_DEFERRED_DELIVERY_BYTES / 100) + 1 }, () =>
				presentationNote({ note: "x".repeat(100) }),
			),
			Array.from({ length: Math.floor(MAX_DEFERRED_DELIVERY_BYTES / 512) + 1 }, () =>
				presentationNote({ note: "", deliveryId: "x".repeat(512) }),
			),
		]) {
			expect(
				renderAdviceMessage(
					{ ...baseMessage, details: { notes } },
					{ expanded: false },
					fixtureTheme(false),
				),
			).toBeUndefined();
		}
	});

	it("labels mixed legacy and metadata-only activity records accurately", () => {
		const status = runtimeStatus();
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		const records: PersistedAdvisorTranscriptRecord[] = [
			{
				version: 1,
				sessionId: "session-1",
				savedAt: 1,
				kind: "advisor-tool-result",
				toolName: "read",
				isError: false,
				text: "legacy file body",
			},
			{
				version: 2,
				sessionId: "session-1",
				savedAt: 2,
				reviewId: "review-1",
				kind: "review-start",
				entryCount: 1,
				truncated: false,
			},
		];
		const dump = formatAdvisorDiagnosticsDump(status, config, 1_700_000_000_000, records);
		expect(dump).toContain('"recordSchema": "legacy-content-v1"');
		expect(dump).toContain('"recordSchema": "activity-v2"');
		expect(dump).toContain('"fileContentBodiesIncluded": true');
		expect(dump).toContain('"legacyContentRecordsPresent": true');
		expect(dump).toContain('"newActivityRecordsMetadataOnly": true');
	});

	it("creates a bounded redacted dump without transcripts, notes, instructions, or paths", () => {
		const status = runtimeStatus();
		status.lastFailure =
			"Bearer dump-secret-token-value private review instruction private/project/path";
		status.governorSkippedReviews = 4;
		status.lastGovernorOutcome = "Advisor tool-call limit reached";
		status.lastDeliveryFailure =
			"TOKEN=dump-delivery-secret-value private review instruction private/project/path";
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.model = "provider/sk-test-abcdefghijklmnop";
		config.instructions = "private review instruction";
		config.security.additionalProtectedPaths = ["private/project/path"];
		const dump = formatAdvisorDiagnosticsDump(status, config, 1_700_000_000_000);

		expect(Buffer.byteLength(dump, "utf8")).toBeLessThanOrEqual(MAX_ADVISOR_DUMP_BYTES);
		expect(dump).toContain("Advisor diagnostics (redacted)");
		expect(dump).toContain("[REDACTED]");
		expect(dump).not.toContain("dump-secret-token-value");
		expect(dump).not.toContain("dump-delivery-secret-value");
		expect(dump).not.toContain("private review instruction");
		expect(dump).not.toContain("private/project/path");
		expect(dump).toContain('"executorTranscriptIncluded": false');
		expect(dump).toContain('"noteContentIncluded": false');
		expect(dump).toContain('"hasLastFailure": true');
		expect(dump).toContain('"governorSkippedReviews": 4');
		expect(dump).toContain('"lastGovernorOutcome": "Advisor tool-call limit reached"');
		expect(dump).toContain('"hasLastDeliveryFailure": true');
		expect(() => {
			JSON.parse(dump.slice(dump.indexOf("\n") + 1));
		}).not.toThrow();

		status.model = `provider/${"x".repeat(MAX_ADVISOR_DUMP_BYTES)}`;
		const fallbackDump = formatAdvisorDiagnosticsDump(status, config, 1_700_000_000_000);
		const fallback: unknown = JSON.parse(fallbackDump.slice(fallbackDump.indexOf("\n") + 1));
		expect(Buffer.byteLength(fallbackDump, "utf8")).toBeLessThanOrEqual(MAX_ADVISOR_DUMP_BYTES);
		expect(fallback).toMatchObject({ truncated: true });
	});
});
