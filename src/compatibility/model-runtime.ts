import { join } from "node:path";

import type { Api, AuthResult, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";

const PARITY_RETRY_COUNT = 1;
type ProviderConfigInput = NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>>;

export interface ResolveAdvisorModelRuntimeOptions {
	modelRegistry: ModelRegistry;
	model: Model<Api>;
	agentDir?: string;
}

export interface ResolvedAdvisorModelRuntime {
	modelRuntime: ModelRuntime;
	model: Model<Api>;
}

export async function setRuntimeApiKeyWithoutNetwork(
	runtime: Pick<ModelRuntime, "setRuntimeApiKey">,
	providerId: string,
	apiKey: string,
): Promise<void> {
	const apply = runtime.setRuntimeApiKey.bind(runtime) as (
		providerId: string,
		apiKey: string,
		options?: { allowNetwork?: boolean },
	) => Promise<void>;
	try {
		await apply(providerId, apiKey, { allowNetwork: false });
	} catch (error) {
		if (error instanceof TypeError) {
			await apply(providerId, apiKey);
			return;
		}
		throw error;
	}
}

export class ModelRuntimeCompatibilityError extends Error {
	constructor(
		readonly field: string,
		kind: "compatibility" | "parity" = "compatibility",
	) {
		super(
			kind === "parity"
				? `Advisor ModelRuntime parity mismatch: ${field}`
				: `Advisor ModelRuntime compatibility failed: ${field}`,
		);
		this.name = "ModelRuntimeCompatibilityError";
	}
}

function normalizedRecord(
	value: Record<string, string> | ProviderHeaders | undefined,
	caseInsensitiveNames: boolean,
): string {
	if (value === undefined) return "{}";
	const entries = new Map<string, string>();
	for (const [name, item] of Object.entries(value)) {
		if (item === null) continue;
		entries.set(caseInsensitiveNames ? name.toLocaleLowerCase("en-US") : name, item);
	}
	return JSON.stringify([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function sameOptionalValue(left: string | undefined, right: string | undefined): boolean {
	return left === right;
}

function registrationReferencesMatch(
	registered: ProviderConfigInput | undefined,
	original: ProviderConfigInput,
): boolean {
	if (registered === undefined) return false;
	return (
		registered.streamSimple === original.streamSimple &&
		registered.oauth === original.oauth &&
		registered.refreshModels === original.refreshModels
	);
}

function compareProviderAuth(
	left: AuthResult | undefined,
	right: AuthResult | undefined,
): string | undefined {
	if ((left === undefined) !== (right === undefined)) return "provider authentication availability";
	if (left === undefined || right === undefined) return undefined;
	if (!sameOptionalValue(left.auth.apiKey, right.auth.apiKey)) return "provider API key";
	if (!sameOptionalValue(left.auth.baseUrl, right.auth.baseUrl)) return "provider base URL";
	if (normalizedRecord(left.auth.headers, true) !== normalizedRecord(right.auth.headers, true)) {
		return "provider headers";
	}
	if (normalizedRecord(left.env, false) !== normalizedRecord(right.env, false)) {
		return "provider environment";
	}
	return undefined;
}

async function compareParity(
	host: ModelRegistry,
	nestedRuntime: ModelRuntime,
	model: Model<Api>,
): Promise<string | undefined> {
	const providerId = model.provider;
	const hostProvider = host.getProvider(providerId);
	const nestedProvider = nestedRuntime.getProvider(providerId);
	if (hostProvider === undefined || nestedProvider === undefined) return "selected provider";
	if (hostProvider.id !== providerId || nestedProvider.id !== providerId)
		return "provider identity";
	if (!sameOptionalValue(hostProvider.baseUrl, nestedProvider.baseUrl)) return "provider base URL";
	if (
		normalizedRecord(hostProvider.headers, true) !== normalizedRecord(nestedProvider.headers, true)
	) {
		return "provider headers";
	}

	const hostStatus = host.getProviderAuthStatus(providerId);
	const nestedStatus = nestedRuntime.getProviderAuthStatus(providerId);
	if (
		hostStatus.configured !== nestedStatus.configured ||
		hostStatus.source !== nestedStatus.source
	) {
		return "authentication source";
	}

	const [hostProviderAuth, nestedProviderAuth] = await Promise.all([
		host.getProviderAuth(providerId),
		nestedRuntime.getAuth(providerId),
	]);
	const providerMismatch = compareProviderAuth(hostProviderAuth, nestedProviderAuth);
	if (providerMismatch !== undefined) return providerMismatch;

	const nestedRegistry = new ModelRegistry(nestedRuntime);
	const [hostModelAuth, nestedModelAuth] = await Promise.all([
		host.getApiKeyAndHeaders(model),
		nestedRegistry.getApiKeyAndHeaders(model),
	]);
	if (hostModelAuth.ok !== nestedModelAuth.ok) return "model authentication availability";
	if (!hostModelAuth.ok || !nestedModelAuth.ok) return "model authentication";
	if (!sameOptionalValue(hostModelAuth.apiKey, nestedModelAuth.apiKey)) return "model API key";
	if (
		normalizedRecord(hostModelAuth.headers, true) !==
		normalizedRecord(nestedModelAuth.headers, true)
	) {
		return "model headers";
	}
	return undefined;
}

function mirrorRegistrations(host: ModelRegistry, nestedRuntime: ModelRuntime): void {
	for (const providerId of host.getRegisteredProviderIds()) {
		const nativeProvider = host.getRegisteredNativeProvider(providerId);
		const providerConfig = host.getRegisteredProviderConfig(providerId);
		try {
			if (nativeProvider !== undefined) {
				nestedRuntime.registerNativeProvider(nativeProvider);
				if (nestedRuntime.getRegisteredNativeProvider(providerId) !== nativeProvider) {
					throw new ModelRuntimeCompatibilityError("native provider registration");
				}
			}
			if (providerConfig !== undefined) {
				nestedRuntime.registerProvider(providerId, providerConfig);
				if (
					!registrationReferencesMatch(
						nestedRuntime.getRegisteredProviderConfig(providerId),
						providerConfig,
					)
				) {
					throw new ModelRuntimeCompatibilityError("provider configuration registration");
				}
			}
		} catch (error) {
			if (error instanceof ModelRuntimeCompatibilityError) throw error;
			throw new ModelRuntimeCompatibilityError("provider registration");
		}
	}
}

/**
 * Build an isolated Pi runtime that preserves the host-selected model and proves
 * that the selected provider resolves identically before Advisor activation.
 */
export async function resolveAdvisorModelRuntime(
	options: ResolveAdvisorModelRuntimeOptions,
): Promise<ResolvedAdvisorModelRuntime> {
	const agentDir = options.agentDir ?? getAgentDir();
	let modelRuntime: ModelRuntime;
	try {
		modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
	} catch {
		throw new ModelRuntimeCompatibilityError("runtime creation");
	}

	mirrorRegistrations(options.modelRegistry, modelRuntime);
	if (modelRuntime.getProvider(options.model.provider) === undefined) {
		throw new ModelRuntimeCompatibilityError("selected provider");
	}

	const hostStatus = options.modelRegistry.getProviderAuthStatus(options.model.provider);
	if (hostStatus.source === "runtime") {
		let runtimeApiKey: string | undefined;
		try {
			runtimeApiKey = await options.modelRegistry.getApiKeyForProvider(options.model.provider);
		} catch {
			throw new ModelRuntimeCompatibilityError("runtime credential copy");
		}
		if (runtimeApiKey === undefined) {
			throw new ModelRuntimeCompatibilityError("runtime credential copy");
		}
		try {
			await setRuntimeApiKeyWithoutNetwork(modelRuntime, options.model.provider, runtimeApiKey);
		} catch {
			throw new ModelRuntimeCompatibilityError("runtime credential copy");
		}
	}

	let mismatch: string | undefined;
	for (let attempt = 0; attempt <= PARITY_RETRY_COUNT; attempt++) {
		try {
			mismatch = await compareParity(options.modelRegistry, modelRuntime, options.model);
		} catch {
			mismatch = "authentication resolution";
		}
		if (mismatch === undefined) return { modelRuntime, model: options.model };
	}
	throw new ModelRuntimeCompatibilityError(mismatch ?? "unknown field", "parity");
}
