import { isFunctionValue, isRecordValue, isStringValue } from "../value-guards.js";

export type CapabilityState = "available" | "absent" | "inactive" | "malformed" | "incompatible";

export interface ToolDescriptor {
	name: string;
	parameters?: unknown;
}

export interface MemorySuggestCapability {
	state: CapabilityState;
	reason?: string;
}

interface JsonSchemaNode {
	type?: unknown;
	enum?: unknown;
	const?: unknown;
	anyOf?: unknown;
	oneOf?: unknown;
	properties?: unknown;
	required?: unknown;
}

interface MemorySuggestSchemaProperties {
	text?: unknown;
	category?: unknown;
	status?: unknown;
}

function asSchema(value: Parameters<typeof isRecordValue>[0]): JsonSchemaNode | undefined {
	return isRecordValue<JsonSchemaNode>(value) ? value : undefined;
}

function supportsString(schema: JsonSchemaNode | undefined): boolean {
	return schema?.type === "string";
}

function supportedLiteralValues(schema: JsonSchemaNode | undefined): Set<string> {
	const values = new Set<string>();
	if (isStringValue(schema?.const)) values.add(schema.const);
	if (Array.isArray(schema?.enum)) {
		const enumValues: unknown[] = schema.enum;
		for (const value of enumValues) if (isStringValue(value)) values.add(value);
	}
	for (const branchKey of ["anyOf", "oneOf"] as const) {
		const branches = schema?.[branchKey];
		if (!Array.isArray(branches)) continue;
		for (const branch of branches) {
			for (const value of supportedLiteralValues(asSchema(branch))) values.add(value);
		}
	}
	return values;
}

/**
 * Inspect the active Executor tool inventory without invoking a tool or importing
 * any Memory Lane package.
 */
export function detectMemorySuggestCapability(
	tools: readonly ToolDescriptor[],
	activeToolNames: readonly string[],
): MemorySuggestCapability {
	const tool = tools.find((candidate) => candidate.name === "memory_suggest");
	if (tool === undefined) return { state: "absent", reason: "memory_suggest is not registered" };
	if (!activeToolNames.includes("memory_suggest")) {
		return { state: "inactive", reason: "memory_suggest is registered but inactive" };
	}

	const schema = asSchema(tool.parameters);
	if (schema?.type !== "object") {
		return { state: "malformed", reason: "memory_suggest parameters are not an object schema" };
	}
	if (!isRecordValue<MemorySuggestSchemaProperties>(schema.properties)) {
		return { state: "malformed", reason: "memory_suggest schema has no properties object" };
	}
	const properties = schema.properties;
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((item) => isStringValue(item)) : [],
	);
	if (!required.has("text") || !supportsString(asSchema(properties.text))) {
		return { state: "incompatible", reason: "text must be a required string" };
	}

	const categories = supportedLiteralValues(asSchema(properties.category));
	if (!categories.has("preference") || !categories.has("project")) {
		return {
			state: "incompatible",
			reason: "category must explicitly support preference and project",
		};
	}
	const statuses = supportedLiteralValues(asSchema(properties.status));
	if (!statuses.has("pending")) {
		return { state: "incompatible", reason: "status must explicitly support pending" };
	}
	return { state: "available" };
}

export const CRITICAL_EXTENSION_METHODS = [
	"registerTool",
	"registerCommand",
	"registerFlag",
	"getFlag",
	"getActiveTools",
	"getAllTools",
	"setActiveTools",
	"sendMessage",
	"appendEntry",
	"registerMessageRenderer",
	"registerEntryRenderer",
] as const;

export const CRITICAL_CONTEXT_METHODS = [
	"isIdle",
	"hasPendingMessages",
	"getContextUsage",
	"isProjectTrusted",
] as const;

export interface CriticalCapabilityResult {
	active: boolean;
	missing: string[];
	reason?: string;
}

interface CriticalCapabilitySurface {
	registerTool?: unknown;
	registerCommand?: unknown;
	registerFlag?: unknown;
	getFlag?: unknown;
	getActiveTools?: unknown;
	getAllTools?: unknown;
	setActiveTools?: unknown;
	sendMessage?: unknown;
	appendEntry?: unknown;
	registerMessageRenderer?: unknown;
	registerEntryRenderer?: unknown;
	isIdle?: unknown;
	hasPendingMessages?: unknown;
	getContextUsage?: unknown;
	isProjectTrusted?: unknown;
}

function missingMethods(
	target: Parameters<typeof isRecordValue>[0],
	names: readonly (keyof CriticalCapabilitySurface)[],
	prefix: string,
): string[] {
	if (!isRecordValue<CriticalCapabilitySurface>(target))
		return names.map((name) => `${prefix}.${name}`);
	const surface = target;
	return names.filter((name) => !isFunctionValue(surface[name])).map((name) => `${prefix}.${name}`);
}

/** Fail closed before any nested session or background work is created. */
export function checkCriticalCapabilities(
	extensionApi: Parameters<typeof isRecordValue>[0],
	context: Parameters<typeof isRecordValue>[0],
): CriticalCapabilityResult {
	const missing = [
		...missingMethods(extensionApi, CRITICAL_EXTENSION_METHODS, "ExtensionAPI"),
		...missingMethods(context, CRITICAL_CONTEXT_METHODS, "ExtensionContext"),
	];
	return missing.length === 0
		? { active: true, missing }
		: {
				active: false,
				missing,
				reason: `Unsupported Pi runtime; missing ${missing.join(", ")}`,
			};
}
