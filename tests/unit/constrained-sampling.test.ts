import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
	probeConstrainedSamplingSupport,
	resolveAdviseSchemaMode,
	type ConstrainedSamplingImporter,
} from "../../src/compatibility/constrained-sampling.js";
import { isFunctionValue } from "../../src/value-guards.js";

interface StrictCompatFlags {
	supportsStrictMode?: boolean;
	supportsStrictTools?: boolean;
}

function model(api: Api, compat?: StrictCompatFlags): Model<Api> {
	const value: Model<Api> = {
		provider: "test",
		id: `test-${api}`,
		name: `Test ${api}`,
		api,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
	if (compat !== undefined) value.compat = compat;
	return value;
}

const supportsStrict = (): Promise<boolean> => Promise.resolve(true);
const lacksRuntimeSupport = (): Promise<boolean> => Promise.resolve(false);

describe("constrained-sampling runtime probe", () => {
	it("detects whether the installed Pi runtime exports the resolver", async () => {
		const moduleName = "@earendil-works/pi-ai/api/constrained-sampling";
		let expected = false;
		try {
			const runtime: unknown = await import(moduleName);
			expected = isFunctionValue(
				// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
				(runtime as { resolveJsonSchemaStrictSampling?: unknown }).resolveJsonSchemaStrictSampling,
			);
		} catch {
			// Pi 0.81 does not expose this subpath.
		}
		await expect(probeConstrainedSamplingSupport()).resolves.toBe(expected);
	});

	it("accepts an injected module exposing the strict sampling resolver", async () => {
		const importer = () => Promise.resolve({ resolveJsonSchemaStrictSampling: () => true });
		await expect(probeConstrainedSamplingSupport(importer)).resolves.toBe(true);
	});

	it.each([
		["missing export", () => Promise.resolve({})],
		["non-function export", () => Promise.resolve({ resolveJsonSchemaStrictSampling: true })],
		["module resolution rejection", () => Promise.reject(new Error("not found"))],
		[
			"synchronous load failure",
			() => {
				throw new Error("load failed");
			},
		],
	] as const)("fails closed for %s", async (_label, importer) => {
		await expect(probeConstrainedSamplingSupport(importer)).resolves.toBe(false);
	});

	it("caches the probe result", async () => {
		const importer = vi
			.fn<ConstrainedSamplingImporter>()
			.mockResolvedValue({ resolveJsonSchemaStrictSampling: () => true });
		await expect(probeConstrainedSamplingSupport(importer)).resolves.toBe(true);
		await expect(probeConstrainedSamplingSupport(importer)).resolves.toBe(true);
		expect(importer).toHaveBeenCalledTimes(1);
	});
});

describe("advise schema mode resolution", () => {
	it("selects strict for explicit Anthropic support", async () => {
		await expect(
			resolveAdviseSchemaMode(
				model("anthropic-messages", { supportsStrictTools: true }),
				supportsStrict,
			),
		).resolves.toBe("strict");
	});

	it.each(["openai-responses", "openai-completions"] as const)(
		"selects strict for explicit %s support",
		async (api) => {
			await expect(
				resolveAdviseSchemaMode(model(api, { supportsStrictMode: true }), supportsStrict),
			).resolves.toBe("strict");
		},
	);

	it("selects strict for explicit Bedrock support", async () => {
		await expect(
			resolveAdviseSchemaMode(
				model("bedrock-converse-stream", { supportsStrictMode: true }),
				supportsStrict,
			),
		).resolves.toBe("strict");
	});

	it.each([
		["anthropic-messages", undefined],
		["anthropic-messages", { supportsStrictTools: false }],
		["openai-responses", undefined],
		["openai-responses", { supportsStrictMode: false }],
		["bedrock-converse-stream", undefined],
		["bedrock-converse-stream", { supportsStrictMode: false }],
	] as const)("uses portable for missing or false flags on %s", async (api, compat) => {
		await expect(resolveAdviseSchemaMode(model(api, compat), supportsStrict)).resolves.toBe(
			"portable",
		);
	});

	it.each([
		"google-generative-ai",
		"google-vertex",
		"mistral-conversations",
		"azure-openai-responses",
		"openai-codex-responses",
		"unknown-api",
	] as const)("uses portable for ineligible API %s", async (api) => {
		await expect(
			resolveAdviseSchemaMode(model(api, { supportsStrictMode: true }), supportsStrict),
		).resolves.toBe("portable");
	});

	it("uses portable for ambiguous custom API capability flags", async () => {
		await expect(
			resolveAdviseSchemaMode(
				model("custom-api", { supportsStrictMode: true, supportsStrictTools: true }),
				supportsStrict,
			),
		).resolves.toBe("portable");
	});

	it("never selects strict from model capability when the runtime probe fails", async () => {
		await expect(
			resolveAdviseSchemaMode(
				model("openai-responses", { supportsStrictMode: true }),
				lacksRuntimeSupport,
			),
		).resolves.toBe("portable");
	});

	it("fails closed when the injected runtime probe throws", async () => {
		await expect(
			resolveAdviseSchemaMode(model("anthropic-messages", { supportsStrictTools: true }), () => {
				throw new Error("probe failed");
			}),
		).resolves.toBe("portable");
	});
});
