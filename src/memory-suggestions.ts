import { isStringValue } from "./value-guards.js";

export const MEMORY_SUGGESTION_CATEGORIES = ["preference", "project"] as const;
export type MemorySuggestionCategory = (typeof MEMORY_SUGGESTION_CATEGORIES)[number];

export const MEMORY_SUGGESTION_BASES = [
	"gate-milestone",
	"human-correction",
	"durable-preference",
	"workflow-change",
	"repeated-mistake",
	"project-procedure",
	"project-constraint",
] as const;
export type MemorySuggestionBasis = (typeof MEMORY_SUGGESTION_BASES)[number];

export function isMemorySuggestionCategory<T>(value: T): value is T & MemorySuggestionCategory {
	return (
		isStringValue(value) && MEMORY_SUGGESTION_CATEGORIES.some((category) => category === value)
	);
}

export function isMemorySuggestionBasis<T>(value: T): value is T & MemorySuggestionBasis {
	return isStringValue(value) && MEMORY_SUGGESTION_BASES.some((basis) => basis === value);
}
