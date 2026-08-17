import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const SCRIPTED_API = "pi-advisor-scripted" as Api;
export const ADVISOR_SCRIPTED_API = "pi-advisor-scripted-advisor" as Api;

export interface ScriptedUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	costUsd?: number;
}

export type ScriptedContent =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface ScriptedResponse {
	content?: ScriptedContent[];
	delayMs?: number;
	waitFor?: Promise<void>;
	waitAfterAbort?: Promise<void>;
	stopReason?: StopReason;
	errorMessage?: string;
	usage?: ScriptedUsage;
}

export interface ObservedRequest {
	modelId: string;
	context: Context;
	options: SimpleStreamOptions | undefined;
	startedAt: number;
}

export interface ScriptedProviderOptions {
	providerId: string;
	modelId: string;
	responses: ScriptedResponse[];
	api?: Api;
	contextWindow?: number;
	maxTokens?: number;
	cost?: Model<Api>["cost"];
}

export interface ScriptedProviderRegistrationOptions {
	name?: string;
	providerHeaders?: Record<string, string>;
	modelHeaders?: Record<string, string>;
}

export function registerScriptedProvider(
	modelRuntime: ModelRuntime,
	provider: ScriptedProvider,
	options: ScriptedProviderRegistrationOptions = {},
): void {
	type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
	type ProviderModel = NonNullable<ProviderConfig["models"]>[number];
	const model: ProviderModel = {
		id: provider.model.id,
		name: provider.model.name,
		api: provider.model.api,
		baseUrl: provider.model.baseUrl,
		reasoning: provider.model.reasoning,
		input: provider.model.input,
		cost: provider.model.cost,
		contextWindow: provider.model.contextWindow,
		maxTokens: provider.model.maxTokens,
	};
	if (options.modelHeaders !== undefined) model.headers = options.modelHeaders;
	const config: ProviderConfig = {
		baseUrl: provider.model.baseUrl,
		api: provider.model.api,
		streamSimple: provider.streamSimple,
		models: [model],
	};
	if (options.name !== undefined) config.name = options.name;
	if (options.providerHeaders !== undefined) config.headers = options.providerHeaders;
	modelRuntime.registerProvider(provider.model.provider, config);
}

function copyContext(context: Context): Context {
	const copied: Context = {
		messages: structuredClone(context.messages),
	};
	if (context.systemPrompt !== undefined) copied.systemPrompt = context.systemPrompt;
	if (context.tools !== undefined) {
		copied.tools = context.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: JSON.parse(JSON.stringify(tool.parameters)) as typeof tool.parameters,
		}));
	}
	return copied;
}

function toUsage(scripted: ScriptedUsage | undefined): Usage {
	const input = scripted?.input ?? 0;
	const output = scripted?.output ?? 0;
	const cacheRead = scripted?.cacheRead ?? 0;
	const cacheWrite = scripted?.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: scripted?.costUsd ?? 0,
		},
	};
}

function wait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(new DOMException("Scripted request aborted", "AbortError"));
	}
	if (delayMs <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, delayMs);
		const abort = () => {
			clearTimeout(timer);
			reject(new DOMException("Scripted request aborted", "AbortError"));
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

async function waitForBarrier(
	barrier: Promise<void>,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal?.aborted) {
		throw new DOMException("Scripted request aborted", "AbortError");
	}
	let abort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new DOMException("Scripted request aborted", "AbortError"));
		signal?.addEventListener("abort", abort, { once: true });
	});
	try {
		await Promise.race([barrier, aborted]);
	} finally {
		if (abort !== undefined) signal?.removeEventListener("abort", abort);
	}
}

export class ScriptedProvider {
	readonly model: Model<Api>;
	readonly requests: ObservedRequest[] = [];
	activeRequests = 0;
	maxConcurrentRequests = 0;
	private readonly responses: ScriptedResponse[];
	private responseIndex = 0;

	constructor(options: ScriptedProviderOptions) {
		this.responses = options.responses.map((response) => {
			const copied: ScriptedResponse = { ...response };
			if (response.content !== undefined) copied.content = structuredClone(response.content);
			return copied;
		});
		this.model = {
			id: options.modelId,
			name: options.modelId,
			api: options.api ?? SCRIPTED_API,
			provider: options.providerId,
			baseUrl: "https://scripted.invalid",
			reasoning: true,
			input: ["text"],
			cost: options.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: options.contextWindow ?? 128_000,
			maxTokens: options.maxTokens ?? 8_192,
		};
	}

	readonly streamSimple = (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const response = this.responses[this.responseIndex++];
		this.requests.push({
			modelId: model.id,
			context: copyContext(context),
			options: options === undefined ? undefined : { ...options },
			startedAt: Date.now(),
		});

		this.activeRequests++;
		this.maxConcurrentRequests = Math.max(this.maxConcurrentRequests, this.activeRequests);
		void this.emit(stream, model, response, options?.signal).finally(() => {
			this.activeRequests--;
		});
		return stream;
	};

	private async emit(
		stream: AssistantMessageEventStream,
		model: Model<Api>,
		response: ScriptedResponse | undefined,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: toUsage(response?.usage),
			stopReason: response?.stopReason ?? "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });

		try {
			if (response === undefined) throw new Error("Scripted provider response queue exhausted");
			await wait(response.delayMs ?? 0, signal);
			if (response.waitFor !== undefined) await waitForBarrier(response.waitFor, signal);
			if (response.errorMessage !== undefined) throw new Error(response.errorMessage);

			for (const block of response.content ?? []) {
				const contentIndex = message.content.length;
				if (block.type === "text") {
					message.content.push({ type: "text", text: block.text });
					stream.push({ type: "text_start", contentIndex, partial: message });
					stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
				} else if (block.type === "thinking") {
					message.content.push({ type: "thinking", thinking: block.thinking });
					stream.push({ type: "thinking_start", contentIndex, partial: message });
					stream.push({
						type: "thinking_delta",
						contentIndex,
						delta: block.thinking,
						partial: message,
					});
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: message,
					});
				} else {
					const toolCall: ToolCall = {
						type: "toolCall",
						id: block.id,
						name: block.name,
						arguments: block.arguments,
					};
					message.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({
						type: "toolcall_delta",
						contentIndex,
						delta: JSON.stringify(block.arguments),
						partial: message,
					});
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
				}
			}

			stream.push({
				type: "done",
				reason: message.stopReason as "stop" | "length" | "toolUse",
				message,
			});
			stream.end();
		} catch (error) {
			if (signal?.aborted && response?.waitAfterAbort !== undefined) {
				await response.waitAfterAbort;
			}
			message.stopReason = signal?.aborted ? "aborted" : "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: message.stopReason, error: message });
			stream.end();
		}
	}
}

export function createPrimaryProvider(responses: ScriptedResponse[]): ScriptedProvider {
	return new ScriptedProvider({
		providerId: "pi-advisor-fixture-primary",
		modelId: "primary-scripted",
		responses,
	});
}

export function createAdvisorProvider(responses: ScriptedResponse[]): ScriptedProvider {
	return new ScriptedProvider({
		providerId: "pi-advisor-fixture-advisor",
		modelId: "advisor-scripted",
		api: ADVISOR_SCRIPTED_API,
		responses,
	});
}
