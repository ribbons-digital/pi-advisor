/**
 * Runtime-level coverage for the no-reasoning render flag (issue #141 review).
 *
 * The unit tests cover the flag reader and the renderer option directly; these
 * integration tests confirm the flag actually gates the PRODUCTION call sites:
 *   1. normal Advisor update rendering (runtime observeTurn path),
 *   2. lifecycle/configuration re-prime rendering (seedLifecycleReprime path),
 *   3. default behavior when the flag is absent (HEAD default: no-reasoning ON).
 */
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	type AdvisorConfig,
	type AdvisorRuntime,
	type AdvisorRuntimeHooks,
} from "../../src/index.js";
import { NO_REASONING_FLAG } from "../../src/feature-flags.js";
import { clearEnvFlag } from "../fixtures/runtime-internals.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

const THINKING_SENTINEL = "EXECUTOR-THINKING-SENTINEL-9f3a";

function configFor(provider: ScriptedProvider): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	return {
		...config,
		defaultEnabled: true,
		model: `${provider.model.provider}/${provider.model.id}`,
	};
}

function advisorExtension(
	config: AdvisorConfig,
	onRuntime: (runtime: AdvisorRuntime) => void,
): InlineExtension {
	const hooks: AdvisorRuntimeHooks & { onRuntime(runtime: AdvisorRuntime): void } = { onRuntime };
	return {
		name: "pi-advisor-under-test",
		factory: createPiAdvisorExtension({ config, hooks }),
	};
}

function contextProbe(onContext: (ctx: ExtensionContext) => void): InlineExtension {
	return {
		name: "no-reasoning-context-probe",
		factory: (pi) => {
			pi.on("session_start", (_event, ctx) => {
				onContext(ctx);
			});
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

function advisorRequestText(advisor: ScriptedProvider, index: number): string {
	const request = advisor.requests[index];
	return request === undefined ? "" : JSON.stringify(request.context.messages);
}

describe.sequential("no-reasoning render flag runtime gating", () => {
	const previousFlag = process.env[NO_REASONING_FLAG];
	afterEach(() => {
		if (previousFlag === undefined) clearEnvFlag(NO_REASONING_FLAG);
		else process.env[NO_REASONING_FLAG] = previousFlag;
	});

	it("default (flag absent): advisor update prompt strips Executor reasoning", async () => {
		clearEnvFlag(NO_REASONING_FLAG);
		const primary = createPrimaryProvider([
			{
				content: [
					{ type: "thinking", thinking: THINKING_SENTINEL },
					{ type: "text", text: "primary answer" },
				],
			},
		]);
		const advisor = createAdvisorProvider([
			{ content: [{ type: "text", text: "private silent review" }] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review this turn with executor thinking");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			// The nested advisor session saw the update WITHOUT the reasoning block.
			const prompt = advisorRequestText(advisor, 0);
			expect(prompt).not.toContain("[reasoning]");
			expect(prompt).not.toContain(THINKING_SENTINEL);
			// The update itself still reached the advisor (sanity: the turn rendered).
			expect(prompt).toContain("primary answer");
		} finally {
			await harness.dispose();
		}
	});

	it("PI_ADVISOR_NO_REASONING=0: advisor update prompt keeps Executor reasoning", async () => {
		process.env[NO_REASONING_FLAG] = "0";
		const primary = createPrimaryProvider([
			{
				content: [
					{ type: "thinking", thinking: THINKING_SENTINEL },
					{ type: "text", text: "primary answer" },
				],
			},
		]);
		const advisor = createAdvisorProvider([
			{ content: [{ type: "text", text: "private silent review" }] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review this turn with executor thinking");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const prompt = advisorRequestText(advisor, 0);
			expect(prompt).toContain("[reasoning]");
			expect(prompt).toContain(THINKING_SENTINEL);
		} finally {
			await harness.dispose();
		}
	});

	it("configuration re-prime rendering honors the flag", async () => {
		clearEnvFlag(NO_REASONING_FLAG);
		const primary = createPrimaryProvider([
			{
				content: [
					{ type: "thinking", thinking: THINKING_SENTINEL },
					{ type: "text", text: "first primary answer" },
				],
			},
			{ content: [{ type: "text", text: "second primary answer" }] },
			{ content: [{ type: "text", text: "third primary answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ content: [{ type: "text", text: "private silent review" }] },
			{ content: [{ type: "text", text: "private silent review" }] },
			{ content: [{ type: "text", text: "private silent review" }] },
		]);
		let runtime: AdvisorRuntime | undefined;
		let hostContext: ExtensionContext | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				contextProbe((ctx) => (hostContext = ctx)),
				advisorExtension(configFor(advisor), (value) => (runtime = value)),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			// Turn 1: an Executor turn WITH thinking, reviewed normally.
			await harness.session.prompt("first user request with executor thinking");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(advisorRequestText(advisor, 0)).not.toContain(THINKING_SENTINEL);

			// Configuration apply seeds a bounded re-prime snapshot of the branch.
			if (runtime === undefined || hostContext === undefined) {
				throw new Error("Expected initialized Advisor runtime and host context");
			}
			const applying = runtime.applyConfiguration(
				configFor(advisor),
				hostContext,
				"Focus on REPRIME-SENTINEL without overriding fixed policy.",
			);
			await applying;
			await harness.session.prompt("second user request after configuration apply");
			await waitFor(() => advisor.requests.length >= 2);
			// The re-prime prompt embeds the branch snapshot: flag ON (default) →
			// the carried history must NOT include the reasoning block.
			const reprimeRequest = advisor.requests[1];
			const reprimeText =
				reprimeRequest === undefined ? "" : JSON.stringify(reprimeRequest.context.messages);
			expect(reprimeText).toContain("advisor-reprime");
			expect(reprimeText).not.toContain("[reasoning]");
			expect(reprimeText).not.toContain(THINKING_SENTINEL);

			// Flip the flag to legacy behavior and re-apply: the NEXT re-prime must
			// carry the reasoning block, proving the flag gates the reprime path.
			process.env[NO_REASONING_FLAG] = "0";
			const applyingLegacy = runtime.applyConfiguration(
				configFor(advisor),
				hostContext,
				"Focus on REPRIME-SENTINEL without overriding fixed policy.",
			);
			await applyingLegacy;
			await harness.session.prompt("third user request after legacy flag apply");
			await waitFor(() => advisor.requests.length >= 3);
			const legacyReprimeText = advisorRequestText(advisor, 2);
			expect(legacyReprimeText).toContain("advisor-reprime");
			expect(legacyReprimeText).toContain("[reasoning]");
			expect(legacyReprimeText).toContain(THINKING_SENTINEL);
		} finally {
			await harness.dispose();
		}
	});
});
