import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import {
	AdvisorModelPicker,
	advisorModelOptions,
	type AdvisorModelOption,
} from "../../src/index.js";

function theme(): Theme {
	// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
	} as Theme;
}

function picker(models: AdvisorModelOption[]) {
	const done = vi.fn<(result: string | undefined) => void>();
	const requestRender = vi.fn();
	const component = new AdvisorModelPicker(
		models,
		{ requestRender },
		theme(),
		done,
		getKeybindings(),
	);
	return { component, done, requestRender };
}

describe("Advisor searchable model picker", () => {
	it("deduplicates exact references and keeps current model first in deterministic order", () => {
		const options = advisorModelOptions(
			[
				{ provider: "zeta", id: "model-z", name: "Zeta" },
				{ provider: "alpha", id: "model-b", name: "Beta" },
				{ provider: "alpha", id: "model-a", name: "Alpha" },
				{ provider: "alpha", id: "model-a", name: "Duplicate" },
			],
			"alpha/model-b",
		);
		expect(options.map((model) => model.reference)).toEqual([
			"alpha/model-b",
			"alpha/model-a",
			"zeta/model-z",
		]);
		expect(options[1]?.name).toBe("Alpha");
	});

	it("searches provider, id, and display name and supports editing and paste", () => {
		const models = advisorModelOptions([
			{ provider: "anthropic", id: "claude-opus-4", name: "Claude Opus" },
			{ provider: "openai", id: "gpt-5", name: "GPT Five" },
		]);
		const { component, done } = picker(models);

		component.handleInput("anthr");
		expect(component.render(60).join("\n")).toContain("anthropic/claude-opus-4");
		component.handleInput("\u0015");
		component.handleInput("gpt5");
		expect(component.render(60).join("\n")).toContain("openai/gpt-5");
		component.handleInput("\u0015");
		component.handleInput("five");
		expect(component.render(60).join("\n")).toContain("openai/gpt-5");
		component.handleInput("\u0015");
		component.handleInput("gpf");
		component.handleInput("\u007f");
		component.handleInput("\u001b[200~ive\u001b[201~");
		expect(component.input.getValue()).toBe("gpive");
		component.handleInput("\u0015");
		component.handleInput("opus");
		component.handleInput("\r");
		expect(done).toHaveBeenCalledWith("anthropic/claude-opus-4");
	});

	it("wraps navigation and selects the highlighted result", () => {
		const models = advisorModelOptions([
			{ provider: "alpha", id: "one" },
			{ provider: "beta", id: "two" },
		]);
		const { component, done } = picker(models);
		component.handleInput("\u001b[A");
		component.handleInput("\r");
		expect(done).toHaveBeenCalledWith("beta/two");
	});

	it.each(["\u001b", "\u0003"])("cancels with %j", (key) => {
		const { component, done } = picker(advisorModelOptions([{ provider: "alpha", id: "one" }]));
		component.handleInput(key);
		expect(done).toHaveBeenCalledOnce();
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("shows no results without submitting and restores results when cleared", () => {
		const { component, done } = picker(advisorModelOptions([{ provider: "alpha", id: "one" }]));
		component.handleInput("not-present");
		expect(component.render(60).join("\n")).toContain("No matching models");
		component.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		component.handleInput("\u0015");
		expect(component.render(60).join("\n")).toContain("alpha/one");
	});

	it("propagates focus for the IME cursor and stays within narrow widths", () => {
		const many = advisorModelOptions(
			Array.from({ length: 14 }, (_, index) => ({
				provider: "provider-with-a-long-name",
				id: `model-with-a-long-name-${String(index).padStart(2, "0")}`,
				name: `Long display name ${String(index)}`,
			})),
		);
		const { component } = picker(many);
		let lines = component.render(60);
		expect(lines.join("\n")).toContain(CURSOR_MARKER);
		expect(lines.join("\n")).toContain("1/14 matching models");
		expect(lines.length).toBeLessThanOrEqual(14);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);

		component.focused = false;
		lines = component.render(24);
		expect(lines.join("\n")).not.toContain(CURSOR_MARKER);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});
});
