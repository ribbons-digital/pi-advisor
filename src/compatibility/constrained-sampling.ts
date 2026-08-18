import type { Api, Model } from "@earendil-works/pi-ai";

import { isFunctionValue, isRecordValue } from "../value-guards.js";

export type AdviseSchemaMode = "strict" | "portable";
export interface ConstrainedSamplingModule {
	readonly resolveJsonSchemaStrictSampling?: unknown;
}
export type ConstrainedSamplingImporter = () => Promise<ConstrainedSamplingModule>;
export type ConstrainedSamplingProbe = () => Promise<boolean>;

const CONSTRAINED_SAMPLING_MODULE = "@earendil-works/pi-ai/api/constrained-sampling";

const defaultImporter: ConstrainedSamplingImporter = async () => {
	// SAFETY: this optional Pi subpath is untyped; the probe only checks whether
	// resolveJsonSchemaStrictSampling is a function.
	return (await import(CONSTRAINED_SAMPLING_MODULE)) as ConstrainedSamplingModule;
};

const probeCache = new WeakMap<ConstrainedSamplingImporter, Promise<boolean>>();

function hasStrictSamplingResolver(module: ConstrainedSamplingModule): boolean {
	return isFunctionValue(module.resolveJsonSchemaStrictSampling);
}

/**
 * Probe for Pi's constrained-sampling subpath without making older Pi versions
 * fail while loading this package. Results are cached per importer.
 */
export function probeConstrainedSamplingSupport(
	importModule: ConstrainedSamplingImporter = defaultImporter,
): Promise<boolean> {
	const cached = probeCache.get(importModule);
	if (cached !== undefined) return cached;

	const result = (async () => {
		try {
			return hasStrictSamplingResolver(await importModule());
		} catch {
			return false;
		}
	})();
	probeCache.set(importModule, result);
	return result;
}

interface StrictCapabilityFlags {
	supportsStrictTools?: unknown;
	supportsStrictMode?: unknown;
}

function hasExplicitStrictCapability(model: Model<Api>): boolean {
	const compat: unknown = model.compat;
	if (!isRecordValue<StrictCapabilityFlags>(compat)) return false;
	const flags = compat;

	switch (model.api) {
		case "anthropic-messages":
			return flags.supportsStrictTools === true;
		case "openai-responses":
		case "openai-completions":
		case "bedrock-converse-stream":
			return flags.supportsStrictMode === true;
		default:
			return false;
	}
}

/** Select strict schemas only when both Pi and the selected model explicitly support them. */
export async function resolveAdviseSchemaMode(
	model: Model<Api>,
	probe: ConstrainedSamplingProbe = probeConstrainedSamplingSupport,
): Promise<AdviseSchemaMode> {
	try {
		if (!hasExplicitStrictCapability(model)) return "portable";
		return (await probe()) ? "strict" : "portable";
	} catch {
		return "portable";
	}
}
