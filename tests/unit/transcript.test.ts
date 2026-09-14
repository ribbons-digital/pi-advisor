import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	ADVISOR_CUSTOM_TYPE,
	MAX_ADVISOR_TOOL_RESULT_LINES,
	branchHasMateriallyNewerExecutorActivity,
	branchHasNewerInstructionInput,
	cursorAtTail,
	renderAdvisorDelta,
} from "../../src/index.js";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "transcript-test",
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type AppendEntry = (manager: SessionManager, rootId: string) => void;

const blockingEntries: { label: string; append: AppendEntry }[] = [
	{
		label: "user message",
		append: (manager) =>
			void manager.appendMessage({ role: "user", content: "new instruction", timestamp: 2 }),
	},
	{
		label: "visible bash execution",
		append: (manager) =>
			void manager.appendMessage({
				role: "bashExecution",
				command: "touch visible",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 2,
			}),
	},
	{
		label: "context-excluded bash execution",
		append: (manager) =>
			void manager.appendMessage({
				role: "bashExecution",
				command: "touch hidden",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 2,
			}),
	},
	{
		label: "non-Advisor custom message entry",
		append: (manager) =>
			void manager.appendCustomMessageEntry(
				"foreign-extension",
				"Apply this extension instruction.",
				false,
			),
	},
	{
		label: "non-Advisor custom-role instruction message",
		append: (manager) =>
			void manager.appendMessage({
				role: "custom",
				customType: "foreign-instruction",
				content: "Apply this custom instruction.",
				display: false,
				timestamp: 2,
			}),
	},
];

const nonBlockingEntries: { label: string; append: AppendEntry }[] = [
	{
		label: "Executor assistant text",
		append: (manager) => void manager.appendMessage(assistant([{ type: "text", text: "done" }])),
	},
	{
		label: "Executor assistant tool call",
		append: (manager) =>
			void manager.appendMessage(
				assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: {} }]),
			),
	},
	{
		label: "tool result",
		append: (manager) =>
			void manager.appendMessage({
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 2,
			}),
	},
	{
		label: "Advisor custom message entry",
		append: (manager) =>
			void manager.appendCustomMessageEntry(ADVISOR_CUSTOM_TYPE, "Advisor note", true),
	},
	{
		label: "Advisor custom-role message",
		append: (manager) =>
			void manager.appendMessage({
				role: "custom",
				customType: ADVISOR_CUSTOM_TYPE,
				content: "Advisor note",
				display: true,
				timestamp: 2,
			}),
	},
	{
		label: "non-content custom metadata",
		append: (manager) => void manager.appendCustomEntry("extension-state", { current: true }),
	},
	{
		label: "model metadata",
		append: (manager) => void manager.appendModelChange("test", "new-model"),
	},
	{
		label: "thinking-level metadata",
		append: (manager) => void manager.appendThinkingLevelChange("high"),
	},
	{
		label: "label metadata",
		append: (manager, rootId) => void manager.appendLabelChange(rootId, "checkpoint"),
	},
	{
		label: "session-info metadata",
		append: (manager) => void manager.appendSessionInfo("renamed session"),
	},
];

describe("post-window instruction input classification", () => {
	it.each(blockingEntries)("blocks after a $label", ({ append }) => {
		const manager = SessionManager.inMemory();
		const rootId = manager.appendMessage({ role: "user", content: "review this", timestamp: 1 });
		const window = cursorAtTail(manager.getBranch());
		append(manager, rootId);
		expect(branchHasNewerInstructionInput(manager.getBranch(), window)).toBe(true);
	});

	it.each(nonBlockingEntries)("ignores post-window $label", ({ append }) => {
		const manager = SessionManager.inMemory();
		const rootId = manager.appendMessage({ role: "user", content: "review this", timestamp: 1 });
		const window = cursorAtTail(manager.getBranch());
		append(manager, rootId);
		expect(branchHasNewerInstructionInput(manager.getBranch(), window)).toBe(false);
	});
});

interface MaterialExpectation {
	label: string;
	append: AppendEntry;
	material: boolean;
	instructionInput: boolean;
}

const materialityEntries: MaterialExpectation[] = [
	{
		label: "a user message",
		append: (manager) =>
			void manager.appendMessage({ role: "user", content: "new instruction", timestamp: 2 }),
		material: false,
		instructionInput: true,
	},
	{
		label: "Executor assistant text",
		append: (manager) => void manager.appendMessage(assistant([{ type: "text", text: "done" }])),
		material: false,
		instructionInput: false,
	},
	{
		label: "a read-only grep tool call and result",
		append: (manager) => {
			void manager.appendMessage(
				assistant([{ type: "toolCall", id: "grep-1", name: "grep", arguments: {} }]),
			);
			void manager.appendMessage({
				role: "toolResult",
				toolCallId: "grep-1",
				toolName: "grep",
				content: [{ type: "text", text: "no matches" }],
				isError: false,
				timestamp: 2,
			});
		},
		material: false,
		instructionInput: false,
	},
	{
		label: "a mutating edit tool call and result",
		append: (manager) => {
			void manager.appendMessage(
				assistant([{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} }]),
			);
			void manager.appendMessage({
				role: "toolResult",
				toolCallId: "edit-1",
				toolName: "edit",
				content: [{ type: "text", text: "updated" }],
				isError: false,
				timestamp: 2,
			});
		},
		material: true,
		instructionInput: false,
	},
	{
		label: "an unknown third-party tool call",
		append: (manager) =>
			void manager.appendMessage(
				assistant([{ type: "toolCall", id: "custom-1", name: "some_tool", arguments: {} }]),
			),
		material: true,
		instructionInput: false,
	},
	{
		label: "an included user bash execution",
		append: (manager) =>
			void manager.appendMessage({
				role: "bashExecution",
				command: "touch visible",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 2,
			}),
		material: true,
		instructionInput: true,
	},
	{
		label: "a context-excluded bash execution",
		append: (manager) =>
			void manager.appendMessage({
				role: "bashExecution",
				command: "touch hidden",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 2,
			}),
		material: false,
		instructionInput: true,
	},
	{
		label: "an Advisor custom message entry",
		append: (manager) =>
			void manager.appendCustomMessageEntry(ADVISOR_CUSTOM_TYPE, "Advisor note", true),
		material: false,
		instructionInput: false,
	},
	{
		label: "a foreign extension custom message entry",
		append: (manager) =>
			void manager.appendCustomMessageEntry(
				"foreign-extension",
				"Follow these newer extension instructions.",
				false,
			),
		material: false,
		instructionInput: true,
	},
	{
		label: "a non-content custom entry",
		append: (manager) => void manager.appendCustomEntry("extension-state", { current: true }),
		material: false,
		instructionInput: false,
	},
	{
		label: "a compaction entry",
		append: (manager) =>
			void manager.appendCompaction("earlier context compacted", "root-id", 1_000),
		material: true,
		instructionInput: false,
	},
];

describe("post-window materially newer Executor activity classification", () => {
	it.each(materialityEntries)(
		"treats $label as $material for staleness",
		({ append, material }) => {
			const manager = SessionManager.inMemory();
			const rootId = manager.appendMessage({ role: "user", content: "review this", timestamp: 1 });
			const window = cursorAtTail(manager.getBranch());
			append(manager, rootId);
			expect(branchHasMateriallyNewerExecutorActivity(manager.getBranch(), window)).toBe(material);
		},
	);

	it("treats a branch-summary entry as materially newer", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "review this", timestamp: 1 });
		const window = cursorAtTail(manager.getBranch());
		const branch: SessionEntry[] = [
			...manager.getBranch(),
			{
				type: "branch_summary",
				id: "branch-summary-1",
				parentId: window.lastEntryId ?? null,
				timestamp: new Date().toISOString(),
				fromId: "abandoned-id",
				summary: "abandoned path summary",
			},
		];
		expect(branchHasMateriallyNewerExecutorActivity(branch, window)).toBe(true);
	});

	it("keeps the Memory follow-up instruction guard independent from material staleness", () => {
		for (const entry of materialityEntries) {
			const probe = SessionManager.inMemory();
			const rootId = probe.appendMessage({ role: "user", content: "review this", timestamp: 1 });
			const probeWindow = cursorAtTail(probe.getBranch());
			entry.append(probe, rootId);
			expect(
				branchHasNewerInstructionInput(probe.getBranch(), probeWindow),
				`instruction input after ${entry.label}`,
			).toBe(entry.instructionInput);
			expect(
				branchHasMateriallyNewerExecutorActivity(probe.getBranch(), probeWindow),
				`material staleness after ${entry.label}`,
			).toBe(entry.material);
		}
	});
});

describe("renderAdvisorDelta includeReasoning option", () => {
	it("keeps reasoning blocks by default and strips them with includeReasoning: false", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(
			assistant([
				{ type: "thinking", thinking: "PRIVATE-REASONING-CONTENT" },
				{ type: "text", text: "visible answer" },
			]),
		);
		const entries = manager.getBranch();

		const withReasoning = renderAdvisorDelta(entries, 4_096);
		expect(withReasoning.text).toContain("[reasoning]");
		expect(withReasoning.text).toContain("PRIVATE-REASONING-CONTENT");
		expect(withReasoning.text).toContain("visible answer");

		const noReasoning = renderAdvisorDelta(entries, 4_096, { includeReasoning: false });
		expect(noReasoning.text).not.toContain("[reasoning]");
		expect(noReasoning.text).not.toContain("PRIVATE-REASONING-CONTENT");
		expect(noReasoning.text).toContain("visible answer");
	});
});

describe("boundToolResult exact-boundary line cap", () => {
	function appendToolResult(manager: SessionManager, text: string): void {
		// boundToolResult operates on the full serialized entry, which prepends
		// a one-line `[Executor tool result read]` header. The byte budget below
		// is generous so only the line cap can fire.
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "boundary-result",
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 1,
		});
	}

	it("does not append the truncation marker when the serialized body has exactly the cap lines", () => {
		// Regression: when the serialized entry (header + content) has exactly
		// MAX_ADVISOR_TOOL_RESULT_LINES lines and the last ends with a newline,
		// the scan consumes all cap iterations with lineEnd still set and the
		// old `lineEnd !== -1` check reported lineTruncated — appending a
		// spurious truncation marker although every line survived.
		const manager = SessionManager.inMemory();
		const contentLines = Array.from(
			{ length: MAX_ADVISOR_TOOL_RESULT_LINES - 1 }, // header takes one of the cap lines
			(_, index) => String(index).padStart(6, "0"),
		);
		appendToolResult(manager, `${contentLines.join("\n")}\n`);
		const entries = manager.getBranch();
		const rendered = renderAdvisorDelta(entries, 2_000_000);
		expect(rendered.text).not.toContain("[Tool result truncated to per-result limit]");
		expect(rendered.text).toContain(contentLines[0] ?? "");
		expect(rendered.text).toContain(contentLines.at(-1) ?? "");
	});

	it("still truncates at the cap when a further line follows", () => {
		const manager = SessionManager.inMemory();
		// header (1) + MAX content lines = MAX+1 serialized lines. The dropped
		// (cap+1)-th line must be longer than the marker so the line trim
		// genuinely shrinks (the strict-shrink guard declines net-inflating
		// trims where the marker exceeds a tiny dropped tail).
		const contentLines = Array.from({ length: MAX_ADVISOR_TOOL_RESULT_LINES - 1 }, (_, index) =>
			String(index).padStart(6, "0"),
		);
		const oversizedTail = "z".repeat(2_000);
		appendToolResult(manager, `${contentLines.join("\n")}\n${oversizedTail}`);
		const entries = manager.getBranch();
		const rendered = renderAdvisorDelta(entries, 2_000_000);
		expect(rendered.text).toContain("[Tool result truncated to per-result limit]");
		// the cap-th content line survives; the long (cap+1)-th line is dropped
		expect(rendered.text).toContain(contentLines[contentLines.length - 1] ?? "");
		expect(rendered.text).not.toContain(oversizedTail);
	});
});
