import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryCredentialStore, createProvider, type AuthResult } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
	ModelRuntimeCompatibilityError,
	resolveAdvisorModelRuntime,
	setRuntimeApiKeyWithoutNetwork,
} from "../../src/compatibility/model-runtime.js";
import {
	createAdvisorProvider,
	registerScriptedProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

const roots: string[] = [];

async function temporaryAgentDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-advisor-model-runtime-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const parityRegistrationOptions = {
	name: "Scripted Advisor",
	providerHeaders: { "X-Provider": "configured" },
	modelHeaders: { "X-Model": "selected" },
};

async function createHost(provider: ScriptedProvider): Promise<{
	runtime: ModelRuntime;
	registry: ModelRegistry;
}> {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	registerScriptedProvider(runtime, provider, parityRegistrationOptions);
	await setRuntimeApiKeyWithoutNetwork(runtime, provider.model.provider, "runtime-secret");
	return { runtime, registry: new ModelRegistry(runtime) };
}

function expectFieldFailure(cause: unknown, field: string): void {
	expect(cause).toBeInstanceOf(ModelRuntimeCompatibilityError);
	// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
	expect((cause as Error).message).toContain(field);
	// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
	expect((cause as Error).message).not.toContain("runtime-secret");
	// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
	expect((cause as Error).message.length).toBeLessThan(200);
}

describe("Advisor ModelRuntime compatibility resolver", () => {
	it("always requests allowNetwork:false on a default-parameter setRuntimeApiKey", async () => {
		const received: unknown[] = [];
		const runtime = {
			setRuntimeApiKey(
				_providerId: string,
				_apiKey: string,
				options: { allowNetwork?: boolean } = {},
			): Promise<void> {
				received.push(options);
				return Promise.resolve();
			},
		};
		expect(runtime.setRuntimeApiKey.length).toBe(2);
		await setRuntimeApiKeyWithoutNetwork(
			// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
			runtime as Pick<ModelRuntime, "setRuntimeApiKey">,
			"scripted",
			"runtime-secret",
		);
		expect(received).toEqual([{ allowNetwork: false }]);
	});

	it("mirrors provider configuration, copies runtime auth, preserves the selected model, and dispatches the custom stream", async () => {
		const provider = createAdvisorProvider([{ content: [{ type: "text", text: "nested" }] }]);
		const { registry } = await createHost(provider);
		const resolved = await resolveAdvisorModelRuntime({
			modelRegistry: registry,
			model: provider.model,
			agentDir: await temporaryAgentDir(),
		});

		expect(resolved.model).toBe(provider.model);
		expect(
			resolved.modelRuntime.getRegisteredNativeProvider(provider.model.provider),
		).toBeUndefined();
		const mirrored = resolved.modelRuntime.getRegisteredProviderConfig(provider.model.provider);
		expect(mirrored?.streamSimple).toBe(provider.streamSimple);
		expect(mirrored?.headers).toEqual({ "X-Provider": "configured" });
		expect(resolved.modelRuntime.getProviderAuthStatus(provider.model.provider).source).toBe(
			"runtime",
		);
		const auth = await resolved.modelRuntime.getAuth(provider.model);
		expect(auth?.auth.apiKey).toBe("runtime-secret");
		expect(auth?.auth.headers).toEqual({ "X-Provider": "configured", "X-Model": "selected" });

		const message = await resolved.modelRuntime.completeSimple(provider.model, { messages: [] });
		expect(message.content).toEqual([{ type: "text", text: "nested" }]);
		expect(provider.requests).toHaveLength(1);
		expect(provider.requests[0]).toMatchObject({
			modelId: provider.model.id,
			options: {
				apiKey: "runtime-secret",
				headers: { "X-Provider": "configured", "X-Model": "selected" },
			},
		});
	});

	it("preserves provider and API identity through the unchanged host model because Provider exposes no API discriminator", async () => {
		const provider = createAdvisorProvider([]);
		const { registry } = await createHost(provider);
		const resolved = await resolveAdvisorModelRuntime({
			modelRegistry: registry,
			model: provider.model,
			agentDir: await temporaryAgentDir(),
		});

		expect(resolved.model).toBe(provider.model);
		expect(resolved.model.provider).toBe(provider.model.provider);
		expect(resolved.model.api).toBe(provider.model.api);
		expect(resolved.model.baseUrl).toBe(provider.model.baseUrl);
		expect(resolved.modelRuntime.getProvider(provider.model.provider)?.id).toBe(
			provider.model.provider,
		);
	});

	it("rejects a selected provider identity mismatch", async () => {
		const provider = createAdvisorProvider([]);
		const { registry } = await createHost(provider);
		const original = registry.getProvider.bind(registry);
		const hostProvider = original(provider.model.provider);
		expect(hostProvider).toBeDefined();
		registry.getProvider = (providerId) => {
			const selected = original(providerId);
			if (providerId !== provider.model.provider || selected === undefined) return selected;
			return { ...selected, id: "different-provider-identity" };
		};

		try {
			await resolveAdvisorModelRuntime({
				modelRegistry: registry,
				model: provider.model,
				agentDir: await temporaryAgentDir(),
			});
			expect.fail("resolver should reject a provider identity mismatch");
		} catch (error) {
			expectFieldFailure(error, "provider identity");
		}
	});

	it("accepts the unchanged host-selected model even when the nested catalog cannot rediscover it", async () => {
		const provider = createAdvisorProvider([{ content: [{ type: "text", text: "dynamic" }] }]);
		const { registry } = await createHost(provider);
		const dynamicModel = {
			...provider.model,
			id: "host-snapshot-only",
			name: "Host snapshot only",
			headers: { "X-Model": "selected" },
		};
		const resolved = await resolveAdvisorModelRuntime({
			modelRegistry: registry,
			model: dynamicModel,
			agentDir: await temporaryAgentDir(),
		});

		expect(resolved.model).toBe(dynamicModel);
		expect(resolved.modelRuntime.getModel(dynamicModel.provider, dynamicModel.id)).toBeUndefined();
		expect(
			(await resolved.modelRuntime.completeSimple(dynamicModel, { messages: [] })).content,
		).toEqual([{ type: "text", text: "dynamic" }]);
		expect(provider.requests[0]?.modelId).toBe("host-snapshot-only");
	});

	it("uses a shared stored auth.json credential without copying it into runtime state", async () => {
		const provider = createAdvisorProvider([{ content: [{ type: "text", text: "stored" }] }]);
		const agentDir = await temporaryAgentDir();
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({
				[provider.model.provider]: { type: "api_key", key: "stored-secret" },
			}),
		);
		const hostRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		registerScriptedProvider(hostRuntime, provider, parityRegistrationOptions);
		const resolved = await resolveAdvisorModelRuntime({
			modelRegistry: new ModelRegistry(hostRuntime),
			model: provider.model,
			agentDir,
		});

		expect(resolved.modelRuntime.getProviderAuthStatus(provider.model.provider).source).toBe(
			"stored",
		);
		expect((await resolved.modelRuntime.getAuth(provider.model))?.auth.apiKey).toBe(
			"stored-secret",
		);
		expect(
			(await resolved.modelRuntime.completeSimple(provider.model, { messages: [] })).content,
		).toEqual([{ type: "text", text: "stored" }]);
	});

	it("requires strict OAuth token equality rather than token presence", async () => {
		const provider = createAdvisorProvider([]);
		const agentDir = await temporaryAgentDir();
		const authPath = join(agentDir, "auth.json");
		const credential = (access: string) => ({
			type: "oauth" as const,
			refresh: "refresh-token",
			access,
			expires: Date.now() + 60_000,
		});
		await writeFile(
			authPath,
			JSON.stringify({ [provider.model.provider]: credential("shared-oauth-secret") }),
		);
		const hostRuntime = await ModelRuntime.create({
			authPath,
			modelsPath: null,
			allowModelNetwork: false,
		});
		hostRuntime.registerProvider(provider.model.provider, {
			baseUrl: provider.model.baseUrl,
			api: provider.model.api,
			streamSimple: provider.streamSimple,
			oauth: {
				name: "Scripted OAuth",
				login: () => Promise.resolve(credential("login-secret")),
				refreshToken: (current) => Promise.resolve(current),
				getApiKey: (current) => current.access,
			},
			models: [
				{
					id: provider.model.id,
					name: provider.model.name,
					api: provider.model.api,
					baseUrl: provider.model.baseUrl,
					reasoning: provider.model.reasoning,
					input: provider.model.input,
					cost: provider.model.cost,
					contextWindow: provider.model.contextWindow,
					maxTokens: provider.model.maxTokens,
				},
			],
		});
		const registry = new ModelRegistry(hostRuntime);
		const original = registry.getProviderAuth.bind(registry);
		registry.getProviderAuth = async (providerId) => {
			const result = await original(providerId);
			return result === undefined
				? result
				: { ...result, auth: { ...result.auth, apiKey: "host-oauth-secret" } };
		};

		const resolved = await resolveAdvisorModelRuntime({
			modelRegistry: new ModelRegistry(hostRuntime),
			model: provider.model,
			agentDir,
		});
		expect(resolved.modelRuntime.getProviderAuthStatus(provider.model.provider).source).toBe(
			"stored",
		);
		expect((await resolved.modelRuntime.getAuth(provider.model))?.auth.apiKey).toBe(
			"shared-oauth-secret",
		);

		try {
			await resolveAdvisorModelRuntime({
				modelRegistry: registry,
				model: provider.model,
				agentDir,
			});
			expect.fail("resolver should reject different OAuth tokens");
		} catch (error) {
			expectFieldFailure(error, "provider API key");
			// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
			expect((error as Error).message).not.toContain("oauth-secret");
		}
	});

	it("mirrors a native provider by its registration base rather than the composed effective provider", async () => {
		const scripted = createAdvisorProvider([{ content: [] }]);
		const native = createProvider({
			id: scripted.model.provider,
			name: "Native scripted",
			baseUrl: scripted.model.baseUrl,
			auth: {
				apiKey: {
					name: "Native key",
					resolve: ({ credential }) =>
						Promise.resolve(
							credential?.type === "api_key" && credential.key
								? { auth: { apiKey: credential.key } }
								: undefined,
						),
				},
			},
			models: [scripted.model],
			api: {
				stream: scripted.streamSimple,
				streamSimple: scripted.streamSimple,
			},
		});
		const hostRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		hostRuntime.registerNativeProvider(native);
		await setRuntimeApiKeyWithoutNetwork(hostRuntime, scripted.model.provider, "runtime-secret");

		const resolved = await resolveAdvisorModelRuntime({
			modelRegistry: new ModelRegistry(hostRuntime),
			model: scripted.model,
			agentDir: await temporaryAgentDir(),
		});

		expect(resolved.modelRuntime.getRegisteredNativeProvider(scripted.model.provider)).toBe(native);
		expect(
			resolved.modelRuntime.getRegisteredProviderConfig(scripted.model.provider),
		).toBeUndefined();
	});

	it("normalizes header names and ordering during strict parity comparison", async () => {
		const provider = createAdvisorProvider([]);
		const { registry } = await createHost(provider);
		const original = registry.getProviderAuth.bind(registry);
		registry.getProviderAuth = async (providerId) => {
			const result = await original(providerId);
			if (result === undefined) return result;
			return {
				...result,
				auth: { ...result.auth, headers: { "x-provider": "configured" } },
			};
		};

		await expect(
			resolveAdvisorModelRuntime({
				modelRegistry: registry,
				model: provider.model,
				agentDir: await temporaryAgentDir(),
			}),
		).resolves.toMatchObject({ model: provider.model });
	});

	it.each([
		{
			field: "provider base URL",
			mutate: (registry: ModelRegistry) => {
				const original = registry.getProviderAuth.bind(registry);
				registry.getProviderAuth = async (providerId): Promise<AuthResult | undefined> => {
					const result = await original(providerId);
					return result === undefined
						? result
						: { ...result, auth: { ...result.auth, baseUrl: "https://different.invalid" } };
				};
			},
		},
		{
			field: "provider headers",
			mutate: (registry: ModelRegistry) => {
				const original = registry.getProviderAuth.bind(registry);
				registry.getProviderAuth = async (providerId): Promise<AuthResult | undefined> => {
					const result = await original(providerId);
					return result === undefined
						? result
						: { ...result, auth: { ...result.auth, headers: { authorization: "secret" } } };
				};
			},
		},
		{
			field: "provider environment",
			mutate: (registry: ModelRegistry) => {
				const original = registry.getProviderAuth.bind(registry);
				registry.getProviderAuth = async (providerId): Promise<AuthResult | undefined> => {
					const result = await original(providerId);
					return result === undefined ? result : { ...result, env: { REGION: "secret" } };
				};
			},
		},
		{
			field: "model headers",
			mutate: (registry: ModelRegistry) => {
				registry.getApiKeyAndHeaders = () =>
					Promise.resolve({
						ok: true as const,
						apiKey: "runtime-secret",
						headers: { "X-Model": "different" },
					});
			},
		},
	] as const)("fails safely on a $field mismatch", async ({ field, mutate }) => {
		const provider = createAdvisorProvider([]);
		const { registry } = await createHost(provider);
		mutate(registry);
		try {
			await resolveAdvisorModelRuntime({
				modelRegistry: registry,
				model: provider.model,
				agentDir: await temporaryAgentDir(),
			});
			expect.fail("resolver should reject mismatched parity");
		} catch (error) {
			expectFieldFailure(error, field);
		}
	});

	it("requires authentication-source parity even when the host credential resolves", async () => {
		const provider = createAdvisorProvider([]);
		const { registry } = await createHost(provider);
		const original = registry.getProviderAuthStatus.bind(registry);
		registry.getProviderAuthStatus = (providerId) => {
			const status = original(providerId);
			return providerId === provider.model.provider
				? { ...status, configured: true, source: "stored" }
				: status;
		};

		try {
			await resolveAdvisorModelRuntime({
				modelRegistry: registry,
				model: provider.model,
				agentDir: await temporaryAgentDir(),
			});
			expect.fail("resolver should reject different authentication sources");
		} catch (error) {
			expectFieldFailure(error, "authentication source");
		}
	});

	it("requires strict runtime API-key equality and keeps the diagnostic secret-free", async () => {
		const provider = createAdvisorProvider([]);
		const { registry } = await createHost(provider);
		registry.getApiKeyForProvider = () => Promise.resolve("different-secret");
		try {
			await resolveAdvisorModelRuntime({
				modelRegistry: registry,
				model: provider.model,
				agentDir: await temporaryAgentDir(),
			});
			expect.fail("resolver should reject a different credential");
		} catch (error) {
			expectFieldFailure(error, "provider API key");
			// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
			expect((error as Error).message).not.toContain("different-secret");
		}
	});

	it("allows one bounded retry to absorb a rotating credential resolution", async () => {
		const provider = createAdvisorProvider([]);
		const { registry } = await createHost(provider);
		const original = registry.getProviderAuth.bind(registry);
		let resolutions = 0;
		registry.getProviderAuth = async (providerId): Promise<AuthResult | undefined> => {
			const result = await original(providerId);
			resolutions++;
			if (resolutions !== 1 || result === undefined) return result;
			return { ...result, auth: { ...result.auth, apiKey: "rotated-once" } };
		};

		await expect(
			resolveAdvisorModelRuntime({
				modelRegistry: registry,
				model: provider.model,
				agentDir: await temporaryAgentDir(),
			}),
		).resolves.toMatchObject({ model: provider.model });
		expect(resolutions).toBe(2);
	});

	it("fails before session creation when the selected provider cannot be mirrored", async () => {
		const provider = createAdvisorProvider([]);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		try {
			await resolveAdvisorModelRuntime({
				modelRegistry: new ModelRegistry(runtime),
				model: provider.model,
				agentDir: await temporaryAgentDir(),
			});
			expect.fail("resolver should reject a missing provider");
		} catch (error) {
			expectFieldFailure(error, "selected provider");
		}
	});
});
