import { describe, expect, it } from "vitest";

import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";

import { createSessionHarness } from "../fixtures/session-harness.js";
import { createPrimaryProvider } from "../fixtures/scripted-provider.js";

function textMessage(role: "user", text: string) {
	return { role, content: text, timestamp: Date.now() } as const;
}

describe.sequential("Pi 0.81.1 branch and lifecycle spikes", () => {
	it("keeps append-only entry IDs stable across equal-length branch changes and compaction context building", () => {
		const manager = SessionManager.inMemory();
		const firstUserId = manager.appendMessage(textMessage("user", "root"));
		const originalAssistantId = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "original" }],
			api: "pi-advisor-scripted",
			provider: "fixture",
			model: "fixture",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const originalBranch = manager.getBranch().map((entry) => entry.id);

		manager.branch(firstUserId);
		const alternateAssistantId = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "alternate" }],
			api: "pi-advisor-scripted",
			provider: "fixture",
			model: "fixture",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const alternateBranch = manager.getBranch().map((entry) => entry.id);

		expect(originalBranch).toEqual([firstUserId, originalAssistantId]);
		expect(alternateBranch).toEqual([firstUserId, alternateAssistantId]);
		expect(originalBranch).toHaveLength(alternateBranch.length);
		expect(manager.getEntry(originalAssistantId)?.id).toBe(originalAssistantId);
		expect(manager.getEntries().map((entry) => entry.id)).toContain(originalAssistantId);

		const compactionId = manager.appendCompaction(
			"bounded alternate branch summary",
			alternateAssistantId,
			2,
		);
		const contextIds = manager.buildContextEntries().map((entry) => entry.id);
		expect(contextIds).toContain(compactionId);
		expect(contextIds).toContain(alternateAssistantId);
		expect(contextIds).not.toContain(originalAssistantId);
		expect(manager.getEntry(firstUserId)?.id).toBe(firstUserId);
	});

	it("compacts through AgentSession.compact and records a stable compaction entry", async () => {
		const manager = SessionManager.inMemory();
		for (let turn = 0; turn < 24; turn++) {
			manager.appendMessage({
				role: "user",
				content: `compaction-${String(turn)}-${"x".repeat(5_000)}`,
				timestamp: turn * 2,
			});
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `answer-${String(turn)}-${"y".repeat(1_000)}` }],
				api: "pi-advisor-scripted",
				provider: "fixture",
				model: "fixture",
				usage: {
					input: 1_000,
					output: 250,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_250,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: turn * 2 + 1,
			});
		}
		const provider = createPrimaryProvider([
			{
				content: [{ type: "text", text: "measured compacted summary" }],
				usage: { input: 20_000, output: 100 },
			},
		]);
		const harness = await createSessionHarness({ provider, sessionManager: manager, tools: [] });

		try {
			const result = await harness.session.compact("Use the scripted summary");
			expect(result.summary).toBe("measured compacted summary");
			const compaction = manager.getEntries().find((entry) => entry.type === "compaction");
			expect(compaction).toBeDefined();
			if (compaction?.type !== "compaction") throw new Error("Expected compaction entry");
			expect(manager.getEntry(compaction.id)?.id).toBe(compaction.id);
			expect(manager.buildContextEntries().some((entry) => entry.id === compaction.id)).toBe(true);
		} finally {
			await harness.dispose();
		}
	});

	it("reports tree navigation with stable old and new leaf IDs", async () => {
		const treeEvents: { oldLeafId: string | null; newLeafId: string | null }[] = [];
		const extension: InlineExtension = {
			name: "tree-spike",
			factory: (pi) => {
				pi.on("session_tree", (event) => {
					treeEvents.push({ oldLeafId: event.oldLeafId, newLeafId: event.newLeafId });
				});
			},
		};
		const provider = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
		]);
		const harness = await createSessionHarness({ provider, extensions: [extension], tools: [] });

		try {
			await harness.session.prompt("first prompt");
			const firstAssistant = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "assistant");
			await harness.session.prompt("second prompt");
			const oldLeafId = harness.sessionManager.getLeafId();
			expect(firstAssistant).toBeDefined();
			if (firstAssistant === undefined || oldLeafId === null)
				throw new Error("Expected populated branch");
			await harness.session.navigateTree(firstAssistant.id, { summarize: false });
			expect(treeEvents).toEqual([{ oldLeafId, newLeafId: firstAssistant.id }]);
			expect(harness.sessionManager.getLeafId()).toBe(firstAssistant.id);
			expect(harness.sessionManager.getEntry(oldLeafId)?.id).toBe(oldLeafId);
		} finally {
			await harness.dispose();
		}
	});

	it("exposes an aborted stop reason but no public user-interrupt cause", async () => {
		const observedTurnEnds: unknown[] = [];
		const extension: InlineExtension = {
			name: "abort-spike",
			factory: (pi) => {
				pi.on("turn_end", (event) => {
					observedTurnEnds.push(event);
				});
			},
		};
		const provider = createPrimaryProvider([{ delayMs: 10_000 }]);
		const harness = await createSessionHarness({ provider, extensions: [extension], tools: [] });

		try {
			const prompt = harness.session.prompt("abort this run");
			while (provider.requests.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			await harness.session.abort();
			await prompt;

			expect(observedTurnEnds).toHaveLength(1);
			// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
			const event = observedTurnEnds[0] as {
				message: { stopReason: string };
			};
			expect(event.message.stopReason).toBe("aborted");
			expect(Object.keys(event).sort()).toEqual(["message", "toolResults", "turnIndex", "type"]);
			expect(JSON.stringify(event)).not.toMatch(/user|interrupt|cause/i);
		} finally {
			await harness.dispose();
		}
	});
});
