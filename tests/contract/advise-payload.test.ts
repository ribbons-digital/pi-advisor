import { createServer, type IncomingMessage, type Server } from "node:http";

import { normalizeContext, type Model, type Tool } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAI } from "@earendil-works/pi-ai/api/openai-responses";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { createStrictAdviseTool } from "../../src/advice.js";
import { probeConstrainedSamplingSupport } from "../../src/compatibility/constrained-sampling.js";
import { DEFAULT_ADVISOR_CONFIG } from "../../src/config.js";
import { isStringValue } from "../../src/value-guards.js";

interface CapturedToolPayload {
	type?: unknown;
	name?: unknown;
	strict?: unknown;
	parameters?: unknown;
	input_schema?: unknown;
}

interface CapturedRequestBody {
	tools?: unknown;
}

interface CapturedRequest {
	url: string;
	body: CapturedRequestBody;
}

const servers: Server[] = [];

async function readRequestBody(request: IncomingMessage): Promise<CapturedRequestBody> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		// SAFETY: Node IncomingMessage yields byte chunks compatible with Uint8Array.
		chunks.push(Buffer.from(chunk as Uint8Array));
	}
	// SAFETY: the capture server receives the provider request object exercised by this contract test.
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequestBody;
}

async function startCaptureServer(): Promise<{
	baseUrl: string;
	captured: Promise<CapturedRequest>;
}> {
	let resolveCapture: (request: CapturedRequest) => void = () => undefined;
	let rejectCapture: (cause: unknown) => void = () => undefined;
	const captured = new Promise<CapturedRequest>((resolve, reject) => {
		resolveCapture = resolve;
		rejectCapture = reject;
	});
	const server = createServer((request, response) => {
		void (async () => {
			try {
				resolveCapture({ url: request.url ?? "", body: await readRequestBody(request) });
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "captured" } }));
			} catch (error) {
				rejectCapture(error);
				response.destroy();
			}
		})();
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || isStringValue(address)) throw new Error("Expected TCP address");
	return { baseUrl: `http://127.0.0.1:${String(address.port)}`, captured };
}

function createTool() {
	return createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, {
		validCalls: 0,
		suppressedCalls: 0,
		memoryPolicySuppressedCalls: 0,
		memoryLimitSuppressedCalls: 0,
	});
}

function expectNullableAdviseSchema(schema: Parameters<typeof JSON.stringify>[0]): void {
	expect(schema).toMatchObject({
		type: "object",
		required: ["note", "intent", "severity", "findingKey", "memory"],
		properties: {
			intent: {
				type: ["string", "null"],
				enum: ["review", "memory-suggestion", null],
			},
			severity: {
				type: ["string", "null"],
				enum: ["nit", "concern", "blocker", null],
			},
			findingKey: { type: ["string", "null"] },
			memory: {
				type: ["object", "null"],
				additionalProperties: false,
				required: ["text", "category", "basis"],
				properties: {
					text: { type: ["string", "null"] },
					category: { type: ["string", "null"] },
					basis: { type: ["string", "null"] },
				},
			},
		},
	});
	expect(JSON.stringify(schema)).not.toContain('"anyOf"');
	// SAFETY: toMatchObject above verifies the properties and memory object shape before inspection.
	const properties = (
		schema as {
			properties: { memory?: { description?: unknown } };
		}
	).properties;
	expect(properties.memory?.description).toContain(
		"provide memory.text, memory.category, and memory.basis",
	);
}

const context = (tool: Tool) =>
	normalizeContext({
		systemPrompt: "Return advice.",
		messages: [{ role: "user" as const, content: "Review this.", timestamp: 1 }],
		tools: [tool],
	});

const modelBase = {
	id: "payload-contract-model",
	name: "Payload contract model",
	provider: "payload-contract",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_384,
	maxTokens: 64,
};

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error === undefined ? resolve() : reject(error)));
				}),
		),
	);
});

const runtimeSupportsConstrainedSampling = await probeConstrainedSamplingSupport();

describe("strict advise provider payload contract", () => {
	it("preserves nullable advise through OpenAI's preferred strict-sampling fallback", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const capture = await startCaptureServer();
		const model = {
			...modelBase,
			api: "openai-responses" as const,
			baseUrl: `${capture.baseUrl}/v1`,
			compat: { supportsStrictMode: true },
		};
		// SAFETY: this fixture supplies the complete OpenAI model fields consumed by the provider.
		const result = streamOpenAI(model as Model<"openai-responses">, context(createTool()), {
			apiKey: "dummy-openai-key",
			maxRetries: 0,
		});
		const request = await capture.captured;
		await result.result();

		expect(request.url).toBe("/v1/responses");
		// SAFETY: the captured request is emitted by the provider with its serialized tools array.
		const tools = request.body.tools as CapturedToolPayload[];
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ type: "function", name: "advise", strict: false });
		expect(tools[0]?.parameters).toHaveProperty("additionalProperties", false);
		expectNullableAdviseSchema(tools[0]?.parameters);
	});

	it("preserves nullable advise through Anthropic's preferred strict-sampling fallback", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const capture = await startCaptureServer();
		const model = {
			...modelBase,
			api: "anthropic-messages" as const,
			baseUrl: capture.baseUrl,
			compat: { supportsStrictTools: true },
		};
		// SAFETY: this fixture supplies the complete Anthropic model fields consumed by the provider.
		const result = streamAnthropic(model as Model<"anthropic-messages">, context(createTool()), {
			apiKey: "dummy-anthropic-key",
			maxRetries: 0,
		});
		const request = await capture.captured;
		await result.result();

		expect(request.url).toBe("/v1/messages?beta=true");
		// SAFETY: the captured request is emitted by the provider with its serialized tools array.
		const tools = request.body.tools as CapturedToolPayload[];
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "advise" });
		expect(tools[0]).not.toHaveProperty("strict");
		expect(tools[0]?.input_schema).not.toHaveProperty("additionalProperties");
		expectNullableAdviseSchema(tools[0]?.input_schema);
	});

	it.each(["openai-responses", "anthropic-messages"] as const)(
		"still enforces strict sampling for a supported scalar schema through %s",
		async (api) => {
			const capture = await startCaptureServer();
			const scalarTool: Tool = {
				name: "scalar-contract",
				description: "A supported strict-schema control, not the Advisor payload.",
				parameters: Type.Object({ note: Type.String() }, { additionalProperties: false }),
				constrainedSampling: { type: "json_schema", strict: "prefer" },
			};
			const options = { apiKey: "dummy-contract-key", maxRetries: 0 };
			const result =
				api === "openai-responses"
					? streamOpenAI(
							{
								...modelBase,
								api,
								baseUrl: `${capture.baseUrl}/v1`,
								compat: { supportsStrictMode: true },
							},
							context(scalarTool),
							options,
						)
					: streamAnthropic(
							{
								...modelBase,
								api,
								baseUrl: capture.baseUrl,
								compat: { supportsStrictTools: true },
							},
							context(scalarTool),
							options,
						);
			const request = await capture.captured;
			await result.result();
			// SAFETY: the captured request is emitted by the provider with its serialized tools array.
			const tools = request.body.tools as CapturedToolPayload[];
			expect(tools).toHaveLength(1);
			expect(tools[0]).toMatchObject({ name: "scalar-contract", strict: true });
			expect(
				api === "openai-responses" ? tools[0]?.parameters : tools[0]?.input_schema,
			).toMatchObject({
				type: "object",
				additionalProperties: false,
				required: ["note"],
				properties: { note: { type: "string" } },
			});
		},
	);
});
