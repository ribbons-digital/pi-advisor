import { validateToolArguments } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";

import {
	ADVISE_WIRE_SCHEMA,
	createAdviseTool,
	createStrictAdviseTool,
	DEFAULT_ADVISOR_CONFIG,
	STRICT_ADVISE_WIRE_SCHEMA,
	type AdviceCollector,
} from "../../src/index.js";

function collector(memoryPolicy = false): AdviceCollector {
	return {
		validCalls: 0,
		suppressedCalls: 0,
		memoryPolicySuppressedCalls: 0,
		memoryLimitSuppressedCalls: 0,
		...(memoryPolicy
			? {
					memoryPolicy: {
						enabled: true,
						capabilityAvailable: true,
						turnNumber: 10,
						now: 1_000,
						admittedCount: 0,
						successfulMemoryTexts: new Set<string>(),
					},
				}
			: {}),
	};
}

function prepareAndValidate(
	tool: ReturnType<typeof createStrictAdviseTool>,
	raw: unknown,
): unknown {
	const prepared = tool.prepareArguments?.(raw);
	validateToolArguments(tool, {
		type: "toolCall",
		id: "strict-advise-validation",
		name: "advise",
		arguments: prepared as never,
	});
	return prepared;
}

async function executeStrict(tool: ReturnType<typeof createStrictAdviseTool>, raw: unknown) {
	const prepared = prepareAndValidate(tool, raw);
	return tool.execute("strict-advise", prepared, undefined, undefined, undefined as never);
}

function asRecord(value: unknown): Record<string, unknown> {
	expect(value).toBeTypeOf("object");
	expect(value).not.toBeNull();
	return value as Record<string, unknown>;
}

function lintStrictSchema(schema: unknown): void {
	const node = asRecord(schema);
	expect(node).not.toHaveProperty("anyOf");
	expect(node).not.toHaveProperty("oneOf");
	expect(node).not.toHaveProperty("allOf");

	const type = node.type;
	const isObject = type === "object" || (Array.isArray(type) && type.includes("object"));
	if (!isObject) return;

	const properties = asRecord(node.properties);
	expect(node.additionalProperties).toBe(false);
	expect(node.required).toEqual(Object.keys(properties));
	for (const property of Object.values(properties)) lintStrictSchema(property);
}

describe("strict advise wire contract", () => {
	it("keeps the portable #64 schema and tool surface unchanged", () => {
		const schema = asRecord(ADVISE_WIRE_SCHEMA);
		const properties = asRecord(schema.properties);
		const memory = asRecord(properties.memory);
		const tool = createAdviseTool(DEFAULT_ADVISOR_CONFIG, collector());

		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["note"]);
		expect(schema).not.toHaveProperty("additionalProperties");
		expect(Object.keys(properties)).toEqual(["note", "intent", "severity", "findingKey", "memory"]);
		expect(memory).not.toHaveProperty("additionalProperties");
		expect(memory).not.toHaveProperty("required");
		expect(tool).not.toHaveProperty("constrainedSampling");
		expect(schema).not.toHaveProperty("constrainedSampling");
	});

	it("uses closed, fully required objects and nullable primitive arrays without composition", () => {
		const schema = asRecord(STRICT_ADVISE_WIRE_SCHEMA);
		const properties = asRecord(schema.properties);
		const memory = asRecord(properties.memory);
		const memoryProperties = asRecord(memory.properties);

		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(["note", "intent", "severity", "findingKey", "memory"]);
		expect(memory.type).toEqual(["object", "null"]);
		expect(memory.additionalProperties).toBe(false);
		expect(memory.required).toEqual(["text", "category", "basis"]);
		expect(asRecord(properties.intent).type).toEqual(["string", "null"]);
		expect(asRecord(properties.intent).enum).toEqual(["review", "memory-suggestion", null]);
		expect(asRecord(properties.severity).type).toEqual(["string", "null"]);
		expect(asRecord(properties.severity).enum).toEqual(["nit", "concern", "blocker", null]);
		expect(asRecord(properties.findingKey).type).toEqual(["string", "null"]);
		expect(asRecord(memoryProperties.text).type).toEqual(["string", "null"]);
		expect(asRecord(memoryProperties.category).enum).toEqual(["preference", "project", null]);
		expect(asRecord(memoryProperties.basis).enum).toEqual([
			"gate-milestone",
			"human-correction",
			"durable-preference",
			"workflow-change",
			"repeated-mistake",
			"project-procedure",
			"project-constraint",
			null,
		]);
		expect(asRecord(properties.note)).not.toHaveProperty("minLength");
		expect(asRecord(properties.findingKey)).not.toHaveProperty("minLength");
		expect(asRecord(properties.findingKey)).not.toHaveProperty("maxLength");
		lintStrictSchema(schema);
	});

	it("requests only preferred constrained sampling and includes nullable memory guidance", () => {
		const tool = createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, collector());
		const properties = asRecord(asRecord(STRICT_ADVISE_WIRE_SCHEMA).properties);
		expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		for (const description of [
			tool.description,
			asRecord(properties.intent).description,
			asRecord(properties.memory).description,
		]) {
			expect(description).toContain(
				"When intent is memory-suggestion, provide memory.text, memory.category, and memory.basis. Otherwise use null for memory.",
			);
		}
	});

	it("fills omitted nullable fields and discards unknown root and nested keys", () => {
		const tool = createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, collector());
		expect(
			prepareAndValidate(tool, {
				note: "Check rollback behavior.",
				rootSecret: "must disappear",
			}),
		).toEqual({
			note: "Check rollback behavior.",
			intent: null,
			severity: null,
			findingKey: null,
			memory: { text: null, category: null, basis: null },
		});
		expect(
			prepareAndValidate(tool, {
				note: "A possible durable rule.",
				intent: "memory-suggestion",
				memory: {
					text: "Use the repository formatter.",
					category: "project",
					nestedSecret: "must disappear",
				},
			}),
		).toEqual({
			note: "A possible durable rule.",
			intent: "memory-suggestion",
			severity: null,
			findingKey: null,
			memory: {
				text: "Use the repository formatter.",
				category: "project",
				basis: null,
			},
		});
	});

	it("rejects invalid known values and non-object roots at the authoritative local gate", () => {
		const tool = createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, collector());
		for (const raw of [
			"not-an-object",
			["not-an-object"],
			{ note: 7 },
			{ note: "Material issue.", severity: "urgent" },
			{ note: "Material issue.", intent: "remember" },
			{ note: "Material issue.", memory: { text: 7 } },
			{ note: "Material issue.", memory: { category: "organization" } },
			{ note: "Material issue.", memory: { basis: "guess" } },
		]) {
			expect(() => tool.prepareArguments?.(raw)).toThrow(
				"Advise arguments did not match the internal schema",
			);
		}
	});

	it("retains local empty-note and finding-key bounds outside the strict provider schema", () => {
		const tool = createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, collector());
		expect(() => tool.prepareArguments?.({ note: "" })).toThrow();
		expect(() => tool.prepareArguments?.({ note: "Material issue.", findingKey: "" })).toThrow();
		expect(() =>
			tool.prepareArguments?.({ note: "Material issue.", findingKey: "k".repeat(201) }),
		).toThrow();
		expect(() =>
			prepareAndValidate(tool, {
				note: "Material issue.",
				findingKey: "👨‍👩‍👧‍👦".repeat(200),
			}),
		).not.toThrow();
	});

	it("passes Pi compilation with internally encoded null memory and complete memory", () => {
		const tool = createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, collector());
		expect(() =>
			prepareAndValidate(tool, {
				note: "Verify the rollback path.",
				intent: null,
				severity: null,
				findingKey: null,
				memory: null,
			}),
		).not.toThrow();
		expect(() =>
			prepareAndValidate(tool, {
				note: "This constraint will matter later.",
				intent: "memory-suggestion",
				memory: {
					text: "Use pnpm for package installation.",
					category: "project",
					basis: "project-constraint",
				},
			}),
		).not.toThrow();
	});

	it("pins the TypeBox [object, null] compile workaround on the pinned TypeBox version", () => {
		// Pinned TypeBox 1.1.38 compiles the object member of ["object", "null"] without a
		// null guard, so a raw null memory throws during compiled validation instead of
		// validating. prepareStrictAdviseArguments substitutes an equivalent
		// { text: null, category: null, basis: null } encoding to keep Pi validation safe.
		// When TypeBox fixes the compile behavior, this expectation fails and the workaround
		// in src/advice.ts can be removed together with this test.
		const compiled = Compile(STRICT_ADVISE_WIRE_SCHEMA);
		const nullMemory = {
			note: "Verify the rollback path.",
			intent: null,
			severity: null,
			findingKey: null,
			memory: null,
		};
		expect(() => compiled.Check(nullMemory)).toThrow();
		expect(
			compiled.Check({ ...nullMemory, memory: { text: null, category: null, basis: null } }),
		).toBe(true);
	});

	it("normalizes nulls and omissions to existing review defaults through the shared path", async () => {
		for (const raw of [
			{ note: "Verify the rollback path." },
			{
				note: "Verify the rollback path.",
				intent: null,
				severity: null,
				findingKey: null,
				memory: null,
			},
		]) {
			const state = collector();
			const started = vi.fn();
			const result = await executeStrict(
				createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, state, started),
				raw,
			);
			expect(state.validCalls).toBe(1);
			expect(state.accepted).toMatchObject({
				note: "Verify the rollback path.",
				intent: "review",
				severity: "concern",
			});
			expect(state.accepted).not.toHaveProperty("findingKeyHash");
			expect(result.terminate).toBe(true);
			expect(started).toHaveBeenCalledOnce();
		}
	});

	it("retains complete memory suggestions without propagating discarded values", async () => {
		const state = collector(true);
		await executeStrict(createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, state), {
			note: "This constraint will matter in later work.",
			intent: "memory-suggestion",
			severity: "blocker",
			findingKey: "ignored-review-key",
			rootSecret: "must disappear",
			memory: {
				text: "Use pnpm for package installation.",
				category: "project",
				basis: "project-constraint",
				nestedSecret: "must disappear",
			},
		});
		expect(state.accepted).toMatchObject({
			note: "This constraint will matter in later work.",
			intent: "memory-suggestion",
			memory: {
				text: "Use pnpm for package installation.",
				category: "project",
				basis: "project-constraint",
			},
		});
		expect(state.accepted).not.toHaveProperty("rootSecret");
		expect(state.accepted).not.toHaveProperty("severity");
		expect(state.accepted).not.toHaveProperty("findingKeyHash");
		expect(asRecord(state.accepted).memory).not.toHaveProperty("nestedSecret");
	});

	it.each([
		{ label: "null memory", memory: null },
		{ label: "missing text", memory: { category: "project", basis: "project-constraint" } },
		{
			label: "null text",
			memory: { text: null, category: "project", basis: "project-constraint" },
		},
		{ label: "missing category", memory: { text: "durable", basis: "project-constraint" } },
		{ label: "null basis", memory: { text: "durable", category: "project", basis: null } },
		{
			label: "empty text",
			memory: { text: "   ", category: "project", basis: "project-constraint" },
		},
	])("suppresses $label with existing memory semantics", async ({ memory }) => {
		const state = collector(true);
		await executeStrict(createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, state), {
			note: "Potential durable context.",
			intent: "memory-suggestion",
			memory,
		});
		expect(state.accepted).toBeUndefined();
		expect(state.suppressedCalls).toBe(1);
		expect(state.memoryPolicySuppressedCalls).toBe(1);
	});
});
