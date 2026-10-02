import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	getKeybindings,
	Input,
	Text,
	truncateToWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";

const MAX_VISIBLE_MODELS = 10;

export interface AdvisorModelOption {
	provider: string;
	id: string;
	name: string;
	reference: string;
}

export function advisorModelOptions(
	models: readonly { provider: string; id: string; name?: string }[],
	currentModel?: string,
): AdvisorModelOption[] {
	const byReference = new Map<string, AdvisorModelOption>();
	for (const model of models) {
		const reference = `${model.provider}/${model.id}`;
		if (byReference.has(reference)) continue;
		byReference.set(reference, {
			provider: model.provider,
			id: model.id,
			name: model.name ?? model.id,
			reference,
		});
	}
	const sorted = [...byReference.values()].sort((left, right) =>
		left.reference.localeCompare(right.reference, "en-US"),
	);
	if (currentModel === undefined) return sorted;
	const current = sorted.find((model) => model.reference === currentModel);
	return current === undefined
		? sorted
		: [current, ...sorted.filter((model) => model.reference !== currentModel)];
}

export class AdvisorModelPicker implements Component, Focusable {
	readonly input = new Input();
	focused = true;
	private filtered: AdvisorModelOption[];
	private selectedIndex = 0;

	constructor(
		private readonly models: readonly AdvisorModelOption[],
		private readonly tui: Pick<TUI, "requestRender">,
		private readonly theme: Theme,
		private readonly done: (result: string | undefined) => void,
		private readonly keybindings: KeybindingsManager = getKeybindings(),
	) {
		this.filtered = [...models];
	}

	private updateFilter(): void {
		const query = this.input.getValue();
		this.filtered =
			query.length === 0
				? [...this.models]
				: fuzzyFilter([...this.models], query, (model) =>
						`${model.provider}/${model.id} ${model.name}`.toLowerCase(),
					);
		this.selectedIndex = 0;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.filtered.length > 0) {
				this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.filtered.length > 0) {
				this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.filtered[this.selectedIndex];
			if (selected !== undefined) this.done(selected.reference);
			return;
		}
		const previous = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== previous) this.updateFilter();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		this.input.focused = this.focused;
		const lines = [
			truncateToWidth(this.theme.bold("Select Advisor model"), availableWidth),
			...this.input.render(availableWidth).map((line) => truncateToWidth(line, availableWidth)),
		];
		if (this.filtered.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("muted", "No matching models"), availableWidth));
		} else {
			const firstVisible = Math.min(
				Math.max(0, this.selectedIndex - MAX_VISIBLE_MODELS + 1),
				Math.max(0, this.filtered.length - MAX_VISIBLE_MODELS),
			);
			const visible = this.filtered.slice(firstVisible, firstVisible + MAX_VISIBLE_MODELS);
			for (const [offset, model] of visible.entries()) {
				const index = firstVisible + offset;
				const displayName = model.name === model.id ? "" : ` - ${model.name}`;
				const row = `${index === this.selectedIndex ? ">" : " "} ${model.reference}${displayName}`;
				lines.push(
					truncateToWidth(
						index === this.selectedIndex ? this.theme.fg("accent", row) : row,
						availableWidth,
					),
				);
			}
			if (this.filtered.length > MAX_VISIBLE_MODELS) {
				lines.push(
					truncateToWidth(
						this.theme.fg(
							"muted",
							`${String(this.selectedIndex + 1)}/${String(this.filtered.length)} matching models`,
						),
						availableWidth,
					),
				);
			}
		}
		lines.push(
			...new Text(
				this.theme.fg("muted", "Type to search · ↑/↓ navigate · Enter select · Esc cancel"),
				0,
				0,
			).render(availableWidth),
		);
		return lines;
	}
}
