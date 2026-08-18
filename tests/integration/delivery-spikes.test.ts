import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { defineTool, SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";

import { createSessionHarness } from "../fixtures/session-harness.js";
import { createPrimaryProvider } from "../fixtures/scripted-provider.js";

function contextText(value: Parameters<typeof JSON.stringify>[0]): string {
	return JSON.stringify(value);
}

describe.sequential("Pi 0.81.1 delivery spikes", () => {
	it("confirms a queued but undelivered steer has no restart-durable session entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-advisor-steer-capability-"));
		const project = join(root, "project");
		const sessions = join(root, "sessions");
		await mkdir(project, { recursive: true });
		await mkdir(sessions, { recursive: true });
		let releaseHold: () => void = () => undefined;
		const hold = new Promise<void>((resolve) => {
			releaseHold = resolve;
		});
		let markQueued: () => void = () => undefined;
		const queued = new Promise<void>((resolve) => {
			markQueued = resolve;
		});
		const marker = "QUEUED-STEER-IS-NOT-A-DURABLE-SESSION-ENTRY";
		const provider = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "restart-hold", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
		]);
		const extension: InlineExtension = {
			name: "queued-steer-restart-capability",
			factory: (pi) => {
				pi.on("tool_execution_start", () => {
					pi.sendMessage(
						{ customType: "pi-advisor-spike", content: marker, display: true },
						{ deliverAs: "steer" },
					);
					markQueued();
				});
			},
		};
		const holdTool = defineTool({
			name: "hold",
			label: "Hold",
			description: "Hold a tool boundary while inspecting session durability.",
			parameters: Type.Object({}),
			execute: async () => {
				await hold;
				return { content: [{ type: "text" as const, text: "released" }], details: {} };
			},
		});
		const manager = SessionManager.create(project, sessions);
		const harness = await createSessionHarness({
			provider,
			sessionManager: manager,
			extensions: [extension],
			customTools: [holdTool],
			tools: ["hold"],
		});
		try {
			const active = harness.session.prompt("measure queued steer restart durability");
			await queued;
			expect(JSON.stringify(manager.getEntries())).not.toContain(marker);
			const sessionFile = manager.getSessionFile();
			if (sessionFile === undefined) throw new Error("Expected file-backed session");
			expect(await readFile(sessionFile, "utf8")).not.toContain(marker);
			harness.session.clearQueue();
			const aborting = harness.session.abort();
			releaseHold();
			await aborting;
			await active;
		} finally {
			releaseHold();
			await harness.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("delivers steer after the active assistant tool boundary and before the next model call", async () => {
		const timeline: string[] = [];
		const provider = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-1", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "continued after steer" }] },
		]);
		const extension: InlineExtension = {
			name: "active-steer-spike",
			factory: (pi) => {
				pi.on("tool_execution_start", () => {
					timeline.push("tool_execution_start");
					pi.sendMessage(
						{
							customType: "pi-advisor-spike",
							content: "active advisory",
							display: true,
						},
						{ deliverAs: "steer" },
					);
					timeline.push("steer_queued");
				});
				pi.on("tool_execution_end", () => {
					timeline.push("tool_execution_end");
				});
			},
		};
		const hold = defineTool({
			name: "hold",
			label: "Hold",
			description: "Deterministic no-op tool for delivery timing",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
		});
		const harness = await createSessionHarness({
			provider,
			extensions: [extension],
			customTools: [hold],
			tools: ["hold"],
		});

		try {
			await harness.session.prompt("start active spike");
			expect(provider.requests).toHaveLength(2);
			expect(contextText(provider.requests[0]?.context)).not.toContain("active advisory");
			const secondContext = contextText(provider.requests[1]?.context);
			expect(secondContext).toContain("held");
			expect(secondContext).toContain("active advisory");
			expect(timeline).toEqual(["tool_execution_start", "steer_queued", "tool_execution_end"]);
		} finally {
			await harness.dispose();
		}
	});

	it("queues nextTurn while idle without triggering a completion", async () => {
		let queued = false;
		let resolveQueued: (() => void) | undefined;
		const nextTurnQueued = new Promise<void>((resolve) => {
			resolveQueued = resolve;
		});
		const provider = createPrimaryProvider([
			{ content: [{ type: "text", text: "first terminal answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
		]);
		const extension: InlineExtension = {
			name: "idle-next-turn-spike",
			factory: (pi) => {
				pi.on("agent_settled", () => {
					if (queued) return;
					queued = true;
					pi.sendMessage(
						{
							customType: "pi-advisor-spike",
							content: "deferred advisory",
							display: false,
						},
						{ deliverAs: "nextTurn" },
					);
					resolveQueued?.();
				});
			},
		};
		const harness = await createSessionHarness({ provider, extensions: [extension], tools: [] });

		try {
			await harness.session.prompt("first user turn");
			await nextTurnQueued;
			expect(harness.session.isIdle).toBe(true);
			expect(provider.requests).toHaveLength(1);
			expect(contextText(provider.requests[0]?.context)).not.toContain("deferred advisory");

			await harness.session.prompt("second user turn");
			expect(provider.requests).toHaveLength(2);
			const secondContext = contextText(provider.requests[1]?.context);
			expect(secondContext).toContain("deferred advisory");
			expect(secondContext).toContain("second user turn");
		} finally {
			await harness.dispose();
		}
	});
});
