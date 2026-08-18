import { createServer, type IncomingMessage, type Server } from "node:http";

import type { Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAI } from "@earendil-works/pi-ai/api/openai-responses";
import { afterEach, describe, expect, it } from "vitest";

import { createStrictAdviseTool } from "../../src/advice.js";
import { probeConstrainedSamplingSupport } from "../../src/compatibility/constrained-sampling.js";
import { DEFAULT_ADVISOR_CONFIG } from "../../src/config.js";

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
	for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequestBody;
}

async function startCaptureServer(): Promise<{
	baseUrl: string;
	captured: Promise<CapturedRequest>;
}> {
	let resolveCapture: (request: CapturedRequest) => void = () => undefined;
	let rejectCapture: (error: unknown) => void = () => undefined;
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
	if (address === null || typeof address === "string") throw new Error("Expected TCP address");
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

function expectStrictAdviseSchema(schema: unknown): void {
	expect(schema).toMatchObject({
		type: "object",
		additionalProperties: false,
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
	const properties = (
		schema as {
			properties: { memory?: { description?: unknown } };
		}
	).properties;
	expect(properties.memory?.description).toContain(
		"provide memory.text, memory.category, and memory.basis",
	);
}

const context = (tool: ReturnType<typeof createTool>) => ({
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
	it("serializes the strict schema and strict flag through OpenAI Responses", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const capture = await startCaptureServer();
		const model = {
			...modelBase,
			api: "openai-responses" as const,
			baseUrl: `${capture.baseUrl}/v1`,
			compat: { supportsStrictMode: true },
		};
		// Pi 0.81 omits the strict flag that its 0.82 runtime successor consumes.
		const result = streamOpenAI(model as Model<"openai-responses">, context(createTool()), {
			apiKey: "dummy-openai-key",
			maxRetries: 0,
		});
		const request = await capture.captured;
		await result.result();

		expect(request.url).toBe("/v1/responses");
		const tools = request.body.tools as CapturedToolPayload[];
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ type: "function", name: "advise", strict: true });
		expectStrictAdviseSchema(tools[0]?.parameters);
	});

	it("serializes the strict schema and Anthropic strict-tool marker", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const capture = await startCaptureServer();
		const model = {
			...modelBase,
			api: "anthropic-messages" as const,
			baseUrl: capture.baseUrl,
			compat: { supportsStrictTools: true },
		};
		// Pi 0.81 omits the strict flag that its 0.82 runtime successor consumes.
		const result = streamAnthropic(model as Model<"anthropic-messages">, context(createTool()), {
			apiKey: "dummy-anthropic-key",
			maxRetries: 0,
		});
		const request = await capture.captured;
		await result.result();

		expect(request.url).toBe("/v1/messages");
		const tools = request.body.tools as CapturedToolPayload[];
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "advise", strict: true });
		expectStrictAdviseSchema(tools[0]?.input_schema);
	});
});
