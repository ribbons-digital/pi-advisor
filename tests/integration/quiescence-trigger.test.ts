import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import {
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	type AdvisorConfig,
	type AdvisorRuntime,
} from "../../src/index.js";
import { runtimeInternals, clearEnvFlag } from "../fixtures/runtime-internals.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

const HOLD_CAP_ENV = "PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS";

function configFor(
	provider: ScriptedProvider,
	mutate?: (config: AdvisorConfig) => void,
): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.defaultEnabled = true;
	config.model = `${provider.model.provider}/${provider.model.id}`;
	mutate?.(config);
	return config;
}

function extensionFor(
	config: AdvisorConfig,
	onRuntime: (runtime: AdvisorRuntime) => void,
): InlineExtension {
	return {
		name: "pi-advisor-quiescence-trigger-test",
		factory: createPiAdvisorExtension({ config, hooks: { onRuntime } }),
	};
}

function createBarrier() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

function stepTool(name: string, resultText: string) {
	return defineTool({
		name,
		label: name,
		description: `Deterministic burst step ${name}.`,
		parameters: Type.Object({}),
		execute: () =>
			Promise.resolve({
				content: [{ type: "text" as const, text: resultText }],
				details: {},
			}),
	});
}

describe.sequential("quiescence-aware review triggering", () => {
	const savedCap = process.env[HOLD_CAP_ENV];
	afterEach(() => {
		if (savedCap === undefined) clearEnvFlag(HOLD_CAP_ENV);
		else process.env[HOLD_CAP_ENV] = savedCap;
	});

	it("holds mid-burst toolUse turns and submits one coalesced review at the first quiescent turn", async () => {
		process.env[HOLD_CAP_ENV] = "60000";
		const midBurst = createBarrier();
		const stepOne = stepTool("step_one", "BURST-STEP-ONE evidence");
		const stepTwo = stepTool("step_two", "BURST-STEP-TWO evidence");
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "s1", name: "step_one", arguments: {} }],
				stopReason: "toolUse",
			},
			{
				waitFor: midBurst.promise,
				content: [{ type: "toolCall", id: "s2", name: "step_two", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "BURST-FINAL summary of the finished work." }] },
		]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [stepOne, stepTwo],
			tools: ["step_one", "step_two"],
			mode: "rpc",
		});
		try {
			const prompt = harness.session.prompt("run the two-step burst");
			// Turn 1 ended with toolUse and turn 2 is blocked mid-burst: the update
			// must be held, not reviewed.
			await waitFor(
				() =>
					runtime !== undefined &&
					runtimeInternals(runtime).throttledUpdate?.heldForQuiescence === true,
			);
			expect(advisor.requests).toHaveLength(0);
			expect(runtime?.getStatus().reviewRequests).toBe(0);

			midBurst.release();
			await prompt;
			// The burst paused (final turn ended without toolUse): exactly one
			// coalesced review covers all three turns, with no supersession churn.
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(advisor.requests).toHaveLength(1);
			const reviewed = JSON.stringify(advisor.requests[0]?.context.messages);
			expect(reviewed).toContain("BURST-STEP-ONE");
			expect(reviewed).toContain("BURST-STEP-TWO");
			expect(reviewed).toContain("BURST-FINAL");
			expect(runtime?.getStatus().reviewsSuperseded).toBe(0);
		} finally {
			midBurst.release();
			await harness.dispose();
		}
	});

	it("submits a quiescence-held update when the hold cap expires mid-burst", async () => {
		process.env[HOLD_CAP_ENV] = "50";
		const stuckBurst = createBarrier();
		const stepOne = stepTool("step_one", "CAP-EXPIRY-EVIDENCE");
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "s1", name: "step_one", arguments: {} }],
				stopReason: "toolUse",
			},
			{
				waitFor: stuckBurst.promise,
				content: [{ type: "text", text: "burst eventually finishes" }],
			},
		]);
		const advisor = createAdvisorProvider([{ content: [] }, { content: [] }]);
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), () => undefined)],
			customTools: [stepOne],
			tools: ["step_one"],
			mode: "rpc",
		});
		try {
			const prompt = harness.session.prompt("start a burst that stalls");
			// The burst never pauses, but the 50ms hold cap expires: the held
			// evidence is submitted anyway instead of stalling indefinitely.
			await waitFor(() => advisor.requests.length === 1);
			expect(JSON.stringify(advisor.requests[0]?.context.messages)).toContain(
				"CAP-EXPIRY-EVIDENCE",
			);
			stuckBurst.release();
			await prompt;
		} finally {
			stuckBurst.release();
			await harness.dispose();
		}
	});

	it("re-bounds a coalesced multi-turn update to the per-update token budget, newest evidence first", async () => {
		process.env[HOLD_CAP_ENV] = "60000";
		const midBurst = createBarrier();
		const stepOne = stepTool("step_one", "done-1");
		const stepTwo = stepTool("step_two", "done-2");
		const primary = createPrimaryProvider([
			{
				content: [
					{ type: "text", text: `ALPHA-${"a".repeat(150)}` },
					{ type: "toolCall", id: "s1", name: "step_one", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{
				content: [
					{ type: "text", text: `OMEGA-${"o".repeat(150)}` },
					{ type: "toolCall", id: "s2", name: "step_two", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{
				waitFor: midBurst.promise,
				content: [{ type: "text", text: "burst ends" }],
			},
		]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						// 100 tokens x 4 = 400-byte per-update budget; each turn render
						// fits, but the coalesced pair exceeds it and must be re-bounded.
						config.context.maxUpdateTokens = 100;
					}),
					(value) => (runtime = value),
				),
			],
			customTools: [stepOne, stepTwo],
			tools: ["step_one", "step_two"],
			mode: "rpc",
		});
		try {
			const prompt = harness.session.prompt("run a two-step oversized burst");
			await waitFor(() => {
				if (runtime === undefined) return false;
				const held = runtimeInternals(runtime).throttledUpdate;
				return held?.heldForQuiescence === true && held.text.includes("OMEGA-");
			});
			if (runtime === undefined) throw new Error("Expected the Advisor runtime to be initialized");
			const held = runtimeInternals(runtime).throttledUpdate;
			if (held === undefined) throw new Error("Expected a quiescence-held update");
			expect(Buffer.byteLength(held.text, "utf8")).toBeLessThanOrEqual(400);
			expect(held.text).toContain("[Older coalesced update content discarded");
			expect(held.text).toContain("OMEGA-");
			expect(held.text).not.toContain("ALPHA-");
			midBurst.release();
			await prompt;
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(JSON.stringify(advisor.requests[0]?.context.messages)).toContain("OMEGA-");
		} finally {
			midBurst.release();
			await harness.dispose();
		}
	});

	it("submits mid-burst updates immediately when the hold cap is zero", async () => {
		process.env[HOLD_CAP_ENV] = "0";
		const midBurst = createBarrier();
		const stepOne = stepTool("step_one", "IMMEDIATE-EVIDENCE");
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "s1", name: "step_one", arguments: {} }],
				stopReason: "toolUse",
			},
			{
				waitFor: midBurst.promise,
				content: [{ type: "text", text: "burst ends" }],
			},
		]);
		const advisor = createAdvisorProvider([{ content: [] }, { content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [stepOne],
			tools: ["step_one"],
			mode: "rpc",
		});
		try {
			const prompt = harness.session.prompt("start a burst");
			// Holding disabled: the mid-burst update is reviewed immediately even
			// though turn 2 is still blocked.
			await waitFor(() => advisor.requests.length === 1);
			expect(JSON.stringify(advisor.requests[0]?.context.messages)).toContain("IMMEDIATE-EVIDENCE");
			// waitFor above only resolves after at least one request, by which time the
			// extension callback has captured the runtime.
			const heldAfterDisable =
				runtime === undefined ? undefined : runtimeInternals(runtime).throttledUpdate;
			expect(heldAfterDisable).toBeUndefined();
			midBurst.release();
			await prompt;
		} finally {
			midBurst.release();
			await harness.dispose();
		}
	});
});
