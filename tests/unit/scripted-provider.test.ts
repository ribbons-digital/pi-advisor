import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createAdvisorProvider, createPrimaryProvider } from "../fixtures/scripted-provider.js";

describe("ScriptedProvider", () => {
	it("emits deterministic text and usage while recording the request", async () => {
		const provider = createPrimaryProvider([
			{
				content: [{ type: "text", text: "primary complete" }],
				usage: { input: 12, output: 3, costUsd: 0.25 },
			},
		]);

		const events = [];
		for await (const event of provider.streamSimple(
			provider.model,
			normalizeContext({
				messages: [{ role: "user", content: "work", timestamp: 1 }],
			}),
		)) {
			events.push(event);
		}

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(provider.requests).toHaveLength(1);
		expect(provider.requests[0]?.context.messages[0]).toMatchObject({ content: "work" });
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.message.usage).toMatchObject({ input: 12, output: 3, totalTokens: 15 });
			expect(done.message.usage.cost.total).toBe(0.25);
		}
	});

	it("supports deterministic tool calls and delayed aborts", async () => {
		const toolProvider = createAdvisorProvider([
			{
				content: [
					{ type: "toolCall", id: "advice-1", name: "advise", arguments: { note: "Check it" } },
				],
				stopReason: "toolUse",
			},
		]);
		const result = await toolProvider
			.streamSimple(toolProvider.model, normalizeContext({ messages: [] }))
			.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({ name: "advise", arguments: { note: "Check it" } });

		const delayed = createAdvisorProvider([{ delayMs: 10_000 }]);
		const controller = new AbortController();
		const stream = delayed.streamSimple(delayed.model, normalizeContext({ messages: [] }), {
			signal: controller.signal,
		});
		controller.abort();
		const aborted = await stream.result();
		expect(aborted.stopReason).toBe("aborted");

		const alreadyAbortedController = new AbortController();
		alreadyAbortedController.abort();
		const immediate = createAdvisorProvider([{}]);
		const immediatelyAborted = await immediate
			.streamSimple(immediate.model, normalizeContext({ messages: [] }), {
				signal: alreadyAbortedController.signal,
			})
			.result();
		expect(immediatelyAborted.stopReason).toBe("aborted");
	});
});
