import { describe, expect, it, vi } from "vitest";

import {
	checkCriticalCapabilities,
	CRITICAL_CONTEXT_METHODS,
	CRITICAL_EXTENSION_METHODS,
	detectMemorySuggestCapability,
} from "../../src/compatibility/capabilities.js";

const compatibleSchema = {
	type: "object",
	properties: {
		text: { type: "string" },
		category: { anyOf: [{ const: "preference" }, { const: "project" }] },
		status: { enum: ["pending"] },
	},
	required: ["text"],
};

describe("memory_suggest capability detection", () => {
	it("accepts the exact active pending-review contract without invoking the tool", () => {
		const execute = vi.fn();
		const result = detectMemorySuggestCapability(
			// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
			[{ name: "memory_suggest", parameters: compatibleSchema, execute } as never],
			["memory_suggest"],
		);
		expect(result).toEqual({ state: "available" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("distinguishes absent, inactive, malformed, and incompatible tools", () => {
		expect(detectMemorySuggestCapability([], [])).toMatchObject({ state: "absent" });
		expect(
			detectMemorySuggestCapability([{ name: "memory_suggest", parameters: compatibleSchema }], []),
		).toMatchObject({ state: "inactive" });
		expect(
			detectMemorySuggestCapability(
				[{ name: "memory_suggest", parameters: { type: "string" } }],
				["memory_suggest"],
			),
		).toMatchObject({ state: "malformed" });
		expect(
			detectMemorySuggestCapability(
				[
					{
						name: "memory_suggest",
						parameters: {
							...compatibleSchema,
							properties: { ...compatibleSchema.properties, status: { enum: ["approved"] } },
						},
					},
				],
				["memory_suggest"],
			),
		).toMatchObject({ state: "incompatible" });
	});
});

describe("critical capability activation", () => {
	it("fails safely inactive before partial runtime construction", () => {
		const extensionApi = Object.fromEntries(
			CRITICAL_EXTENSION_METHODS.map((name) => [name, vi.fn()]),
		);
		const context = Object.fromEntries(CRITICAL_CONTEXT_METHODS.map((name) => [name, vi.fn()]));
		delete extensionApi.sendMessage;

		const result = checkCriticalCapabilities(extensionApi, context);
		expect(result.active).toBe(false);
		expect(result.missing).toEqual(["ExtensionAPI.sendMessage"]);
		expect(result.reason).toContain("Unsupported Pi runtime");
	});

	it("activates only when all initial critical methods exist", () => {
		const extensionApi = Object.fromEntries(
			CRITICAL_EXTENSION_METHODS.map((name) => [name, vi.fn()]),
		);
		const context = Object.fromEntries(CRITICAL_CONTEXT_METHODS.map((name) => [name, vi.fn()]));
		expect(checkCriticalCapabilities(extensionApi, context)).toEqual({ active: true, missing: [] });
	});
});
