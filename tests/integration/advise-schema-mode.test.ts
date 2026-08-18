import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	ADVISE_WIRE_SCHEMA,
	ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	formatAdvisorDiagnosticsDump,
	formatAdvisorStatus,
	STRICT_ADVISE_WIRE_SCHEMA,
	type AdvisorConfig,
	type AdvisorRuntime,
} from "../../src/index.js";
import { runtimeInternals } from "../fixtures/runtime-internals.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import { probeConstrainedSamplingSupport } from "../../src/compatibility/constrained-sampling.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

function configFor(provider: ScriptedProvider): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.defaultEnabled = true;
	config.model = `${provider.model.provider}/${provider.model.id}`;
	return config;
}

function advisorExtension(
	config: AdvisorConfig,
	onRuntime: (runtime: AdvisorRuntime) => void,
): InlineExtension {
	return {
		name: "pi-advisor-schema-mode-under-test",
		factory: createPiAdvisorExtension({ config, hooks: { onRuntime } }),
	};
}

interface InspectedAdviseTool {
	parameters: unknown;
	constrainedSampling?: unknown;
}

function inspectAdviseTool(tool: InspectedAdviseTool): InspectedAdviseTool;
function inspectAdviseTool(
	tool: InspectedAdviseTool | { name?: string },
): InspectedAdviseTool | { name?: string } {
	return tool;
}

function nestedAdviseTool(runtime: AdvisorRuntime): InspectedAdviseTool {
	const tool = runtimeInternals(runtime).session?.getToolDefinition("advise");
	if (tool === undefined) throw new Error("Expected nested advise tool");
	return inspectAdviseTool(tool);
}

function strictCompatibleModel<T>(model: T): T {
	// SAFETY: Pi 0.81 types omit supportsStrictTools, but supported newer runtimes consume it.
	return {
		...model,
		api: "anthropic-messages",
		compat: { supportsStrictTools: true },
	} as T;
}

const runtimeSupportsConstrainedSampling = await probeConstrainedSamplingSupport();

describe.sequential("Advisor advise schema mode", () => {
	it("selects the strict closed schema for an explicitly eligible model", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(configFor(advisor), (value) => (runtime = value))],
			beforeBind: (modelRuntime) => {
				const registration = modelRuntime.getRegisteredProviderConfig(advisor.model.provider);
				if (registration === undefined) throw new Error("Expected registered Advisor provider");
				const models = registration.models;
				if (models === undefined) throw new Error("Expected registered Advisor models");
				modelRuntime.registerProvider(advisor.model.provider, {
					...registration,
					api: "anthropic-messages",
					models: models.map((model) =>
						model.id === advisor.model.id ? strictCompatibleModel(model) : model,
					),
				});
			},
			tools: [],
			mode: "rpc",
		});
		try {
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			expect(runtime.getStatus()).toMatchObject({
				active: true,
				adviseSchemaMode: "strict",
			});
			expect(runtime.getStatus().nestedActiveTools).toContain("advise");
			const tool = nestedAdviseTool(runtime);
			expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
			expect(tool.parameters).toEqual(STRICT_ADVISE_WIRE_SCHEMA);
			expect(tool.parameters).toMatchObject({
				additionalProperties: false,
				required: ["note", "intent", "severity", "findingKey", "memory"],
			});
		} finally {
			await harness.dispose();
		}
	});

	it("fails closed to portable and reports only the non-persisted selected mode", async () => {
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([
			{ content: [{ type: "text", text: "silent portable review" }] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const config = configFor(advisor);
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [advisorExtension(config, (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			expect(runtime.getStatus()).toMatchObject({ active: true, adviseSchemaMode: "portable" });
			const tool = nestedAdviseTool(runtime);
			expect(tool).not.toHaveProperty("constrainedSampling");
			expect(tool.parameters).toEqual(ADVISE_WIRE_SCHEMA);

			const statusText = formatAdvisorStatus(runtime.getStatus());
			expect(statusText).toContain("Advise schema: portable");
			const dump = formatAdvisorDiagnosticsDump(runtime.getStatus(), config);
			// SAFETY: formatAdvisorDiagnosticsDump emits the status object inspected by this integration test.
			const diagnosticPayload = JSON.parse(dump.slice(dump.indexOf("\n") + 1)) as {
				status: { adviseSchemaMode?: unknown };
			};
			expect(diagnosticPayload.status.adviseSchemaMode).toBe("portable");
			expect(diagnosticPayload.status).not.toHaveProperty("arguments");
			expect(diagnosticPayload.status).not.toHaveProperty("validationOutput");
			expect(diagnosticPayload.status).not.toHaveProperty("discardedKeys");

			await harness.session.prompt("persist without schema mode");
			const persistedStates = harness.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			expect(persistedStates.length).toBeGreaterThan(0);
			for (const entry of persistedStates) {
				expect(JSON.stringify(entry)).not.toContain("adviseSchemaMode");
			}
		} finally {
			await harness.dispose();
		}
	});
});
