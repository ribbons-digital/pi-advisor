import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	branchHasMateriallyNewerExecutorActivity,
	branchHasNewerInstructionInput,
	cursorAtTail,
	renderAdvisorDelta,
	renderAdvisorReprimeSnapshot,
	successfulMemoryToolTexts,
	validateCursor,
} from "../../src/index.js";

describe("Pi 1.0 canonical Advisor evidence", () => {
	it("renders the current system prompt and tool declarations as redacted observed context", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "system",
			content: "",
			sections: { policy: "OLD-POLICY", removed: "REMOVED-POLICY" },
			timestamp: 1,
		});
		const window = cursorAtTail(manager.getBranch());
		manager.appendMessage({
			role: "system",
			content: "",
			sections: { policy: "CURRENT-POLICY\nAPI_KEY=system-context-secret", removed: null },
			toolsAdded: [
				{
					name: "read",
					description: "Read current files",
					parameters: { type: "object", properties: {} },
				},
			],
			timestamp: 2,
		});
		const snapshot = renderAdvisorReprimeSnapshot(manager.getBranch(), 4_000);
		expect(snapshot.text).toContain("CURRENT-POLICY");
		expect(snapshot.text).toContain("Read current files");
		expect(snapshot.text).toContain("[REDACTED]");
		expect(snapshot.text).not.toContain("system-context-secret");
		expect(snapshot.text).not.toContain("OLD-POLICY");
		expect(snapshot.text).not.toContain("REMOVED-POLICY");
		expect(branchHasNewerInstructionInput(manager.getBranch(), window)).toBe(true);
		expect(branchHasMateriallyNewerExecutorActivity(manager.getBranch(), window)).toBe(true);
		expect(validateCursor(manager.getBranch(), window)).toBe("context-changed");
	});

	it("uses effective forced instructions as bounded, redacted evidence rather than canonical policy", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "system", content: "CANONICAL-POLICY-NOT-SENT", timestamp: 1 });
		const effective = "FORCED-CURRENT-POLICY\nAPI_KEY=forced-system-secret";
		for (const render of [renderAdvisorDelta, renderAdvisorReprimeSnapshot]) {
			const result = render(manager.getBranch(), 1_000, effective);
			expect(result.text).toContain("FORCED-CURRENT-POLICY");
			expect(result.text).toContain("[REDACTED]");
			expect(result.text).not.toContain("forced-system-secret");
			expect(result.text).not.toContain("CANONICAL-POLICY-NOT-SENT");
			expect(
				Buffer.byteLength(render(manager.getBranch(), 10, effective.repeat(100)).text),
			).toBeLessThanOrEqual(40);
		}
	});

	it.each([null, { content: "EDITED-EVIDENCE" }])(
		"projects a context edit %j without rewriting raw history",
		(replacement) => {
			const manager = SessionManager.inMemory();
			const target = manager.appendMessage({ role: "user", content: "OLD-EVIDENCE", timestamp: 1 });
			const window = cursorAtTail(manager.getBranch());
			manager.appendContextEdit(target, replacement);
			manager.appendMessage({ role: "user", content: "CURRENT-USER", timestamp: 2 });
			const snapshot = renderAdvisorReprimeSnapshot(manager.getBranch(), 4_000);
			expect(snapshot.text).not.toContain("OLD-EVIDENCE");
			expect(snapshot.text).toContain("CURRENT-USER");
			if (replacement !== null) expect(snapshot.text).toContain("EDITED-EVIDENCE");
			expect(JSON.stringify(manager.getEntry(target))).toContain("OLD-EVIDENCE");
			expect(validateCursor(manager.getBranch(), window)).toBe("context-changed");
			expect(branchHasNewerInstructionInput(manager.getBranch(), window)).toBe(true);
			manager.branch(target);
			expect(renderAdvisorReprimeSnapshot(manager.getBranch(), 4_000).text).toContain(
				"OLD-EVIDENCE",
			);
		},
	);

	it("does not replay summarized history and retains the canonical compaction tail", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "SUMMARIZED-RAW-EVIDENCE", timestamp: 1 });
		const kept = manager.appendMessage({ role: "user", content: "KEPT-EVIDENCE", timestamp: 2 });
		manager.appendCompaction("COMPACTED-CONTEXT", kept, 1_000);
		const snapshot = renderAdvisorReprimeSnapshot(manager.getBranch(), 4_000);
		expect(snapshot.text).not.toContain("SUMMARIZED-RAW-EVIDENCE");
		expect(snapshot.text).toContain("KEPT-EVIDENCE");
		expect(snapshot.text).toContain("COMPACTED-CONTEXT");
	});

	it("includes an initial system declaration without invalidating an empty review window", () => {
		const manager = SessionManager.inMemory();
		const window = cursorAtTail(manager.getBranch());
		manager.appendMessage({ role: "system", content: "INITIAL-SYSTEM", timestamp: 1 });
		expect(validateCursor(manager.getBranch(), window)).toBe("valid");
		expect(branchHasMateriallyNewerExecutorActivity(manager.getBranch(), window)).toBe(false);
		expect(renderAdvisorDelta(manager.getBranch(), 4_000).text).toContain("INITIAL-SYSTEM");
	});

	it("keeps tool-inventory-only changes eligible for capability rechecks without resetting advice", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "system", content: "UNCHANGED-POLICY", timestamp: 1 });
		const window = cursorAtTail(manager.getBranch());
		manager.appendMessage({
			role: "system",
			content: "",
			toolsRemoved: [{ name: "memory_suggest" }],
			timestamp: 2,
		});
		expect(validateCursor(manager.getBranch(), window)).toBe("valid");
		expect(branchHasMateriallyNewerExecutorActivity(manager.getBranch(), window)).toBe(true);
	});

	it.each([
		{
			status: "ok",
			complete: true,
			text: "SAVED-NESTED-MEMORY",
			expected: ["saved-nested-memory"],
		},
		{ status: "error", complete: true, text: "FAILED-NESTED-MEMORY", expected: [] },
		{ status: "unfinished", complete: true, text: "UNFINISHED-NESTED-MEMORY", expected: [] },
		{ status: "ok", complete: false, text: "INCOMPLETE-NESTED-MEMORY", expected: [] },
	] as const)(
		"uses only complete successful nested Memory evidence ($status, $complete)",
		({ status, complete, text, expected }) => {
			const manager = SessionManager.inMemory();
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "outer",
				toolName: "orchestrate",
				content: [{ type: "text", text: "outer outcome" }],
				isError: false,
				timestamp: 1,
				nestedCalls: {
					complete,
					calls: [{ id: "outer/1", name: "memory_suggest", status, arguments: { text } }],
				},
			});
			expect([...successfulMemoryToolTexts(manager.getBranch(), 4, 1_000)]).toEqual(expected);
		},
	);

	it("bounds nested Memory evidence, ignores missing arguments, and keeps known saves after an outer error", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "outer",
			toolName: "orchestrate",
			content: [{ type: "text", text: "outer error after saving" }],
			isError: true,
			timestamp: 1,
			nestedCalls: {
				complete: true,
				calls: [
					{
						id: "outer/1",
						name: "memory_save",
						status: "ok",
						arguments: { text: "OLDER-NESTED-MEMORY" },
					},
					{ id: "outer/2", name: "memory_save", status: "ok" },
					{
						id: "outer/3",
						name: "memory_suggest",
						status: "ok",
						arguments: { text: "NEWEST-NESTED-MEMORY" },
					},
				],
			},
		});
		expect([...successfulMemoryToolTexts(manager.getBranch(), 1, 1_000)]).toEqual([
			"newest-nested-memory",
		]);
		expect([...successfulMemoryToolTexts(manager.getBranch(), 4, 1)]).toEqual([]);
	});
});
