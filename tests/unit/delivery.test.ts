import { describe, expect, it } from "vitest";

import { selectAdviceDispatch, type AdviceDispatchState } from "../../src/index.js";

const idleMemory: AdviceDispatchState = {
	forceDeferred: false,
	aborted: false,
	idle: true,
	newerInstructionInput: false,
	memorySuggestion: true,
	memoryCapabilityAvailable: true,
	activeIdleSeverities: ["blocker"],
	reviewFollowUpPending: false,
	reviewFollowUpCapExhausted: false,
};

const idleReview: AdviceDispatchState = {
	...idleMemory,
	memorySuggestion: false,
	memoryCapabilityAvailable: false,
	reviewSeverity: "blocker",
};

describe("Advisor delivery selection", () => {
	it("steers any accepted advice while the Executor is running", () => {
		expect(selectAdviceDispatch({ ...idleMemory, idle: false })).toBe("steer");
		expect(
			selectAdviceDispatch({
				...idleMemory,
				idle: false,
				memoryCapabilityAvailable: false,
			}),
		).toBe("steer");
		expect(selectAdviceDispatch({ ...idleReview, idle: false })).toBe("steer");
	});

	it("follows up for an idle Memory suggestion without newer instruction input", () => {
		expect(selectAdviceDispatch(idleMemory)).toBe("followUp");
	});

	it("defers an idle Memory suggestion after newer instruction input", () => {
		expect(selectAdviceDispatch({ ...idleMemory, newerInstructionInput: true })).toBe("deferred");
	});

	it("follows up for an idle review note whose severity is eligible", () => {
		expect(selectAdviceDispatch(idleReview)).toBe("followUp");
		expect(
			selectAdviceDispatch({ ...idleReview, activeIdleSeverities: ["concern", "blocker"] }),
		).toBe("followUp");
		expect(
			selectAdviceDispatch({
				...idleReview,
				activeIdleSeverities: ["concern", "blocker"],
				reviewSeverity: "concern",
			}),
		).toBe("followUp");
	});

	it("defers an idle review note whose severity is ineligible", () => {
		expect(selectAdviceDispatch({ ...idleReview, reviewSeverity: "concern" })).toBe("deferred");
		expect(selectAdviceDispatch({ ...idleReview, activeIdleSeverities: [] })).toBe("deferred");
		expect(
			selectAdviceDispatch({
				...idleReview,
				activeIdleSeverities: ["concern"],
				reviewSeverity: "blocker",
			}),
		).toBe("deferred");
	});

	it("structurally prohibits nit from active-idle review dispatch", () => {
		expect(selectAdviceDispatch({ ...idleReview, reviewSeverity: "nit" })).toBe("deferred");
		expect(
			selectAdviceDispatch({
				...idleReview,
				reviewSeverity: "nit",
				activeIdleSeverities: ["concern", "blocker"],
			}),
		).toBe("deferred");
	});

	it("defers an idle eligible review note after newer instruction input", () => {
		expect(selectAdviceDispatch({ ...idleReview, newerInstructionInput: true })).toBe("deferred");
	});

	it("defers an idle eligible review note while a review follow-up is pending", () => {
		expect(selectAdviceDispatch({ ...idleReview, reviewFollowUpPending: true })).toBe("deferred");
	});

	it("defers an idle eligible review note when the follow-up session cap is exhausted", () => {
		expect(selectAdviceDispatch({ ...idleReview, reviewFollowUpCapExhausted: true })).toBe(
			"deferred",
		);
	});

	it("preserves forced and aborted deferral boundaries for review follow-ups", () => {
		expect(selectAdviceDispatch({ ...idleReview, forceDeferred: true })).toBe("deferred");
		expect(selectAdviceDispatch({ ...idleReview, aborted: true })).toBe("deferred");
	});

	it("gives Memory suggestion dispatch precedence over review dispatch", () => {
		expect(
			selectAdviceDispatch({
				...idleReview,
				memorySuggestion: true,
				memoryCapabilityAvailable: true,
			}),
		).toBe("followUp");
		expect(
			selectAdviceDispatch({
				...idleReview,
				memorySuggestion: true,
				memoryCapabilityAvailable: true,
				reviewFollowUpPending: true,
			}),
		).toBe("followUp");
	});

	it("never follows up for ordinary idle advice or unavailable capability", () => {
		expect(selectAdviceDispatch({ ...idleMemory, memorySuggestion: false })).toBe("deferred");
		expect(selectAdviceDispatch({ ...idleMemory, memoryCapabilityAvailable: false })).toBe(
			"deferred",
		);
		const ordinary = { ...idleReview };
		delete (ordinary as Partial<AdviceDispatchState>).reviewSeverity;
		expect(selectAdviceDispatch(ordinary)).toBe("deferred");
	});
});
