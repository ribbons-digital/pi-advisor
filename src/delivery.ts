import type { ActiveIdleSeverity } from "./config.js";
import type { AdviceSeverity } from "./advice.js";

export const MAX_PENDING_ADVICE_ITEMS = 4_096;
export const MAX_PENDING_ADVICE_BYTES = 1_000_000;
export const MAX_DEFERRED_DELIVERY_BYTES = 64 * 1_024;
export const REVIEW_FOLLOW_UP_SESSION_CAP = 5;

export type QueueAdmission = "accepted" | "duplicate" | "capacity";
export type AdviceDispatch = "deferred" | "steer" | "followUp";

export interface AdviceDispatchState {
	forceDeferred: boolean;
	aborted: boolean;
	idle: boolean;
	newerInstructionInput: boolean;
	memorySuggestion: boolean;
	memoryCapabilityAvailable: boolean;
	reviewSeverity?: AdviceSeverity;
	activeIdleSeverities: readonly ActiveIdleSeverity[];
	reviewFollowUpPending: boolean;
	reviewFollowUpCapExhausted: boolean;
}

export function selectAdviceDispatch(state: AdviceDispatchState): AdviceDispatch {
	if (state.forceDeferred || state.aborted) return "deferred";
	if (!state.idle) return "steer";
	if (state.memorySuggestion && !state.newerInstructionInput && state.memoryCapabilityAvailable) {
		return "followUp";
	}
	if (
		!state.memorySuggestion &&
		state.reviewSeverity !== undefined &&
		!state.reviewFollowUpPending &&
		!state.reviewFollowUpCapExhausted &&
		!state.newerInstructionInput &&
		state.activeIdleSeverities.some((severity) => severity === state.reviewSeverity)
	) {
		return "followUp";
	}
	return "deferred";
}

export interface RenderedQueueItem<T> {
	key: string;
	value: T;
	bytes: number;
	rendered: string;
}

interface QueueEntry<T> {
	key: string;
	value: T;
	bytes: number;
}

export class BoundedKeyedByteFifo<T> {
	private readonly entries: QueueEntry<T>[] = [];
	private readonly keys = new Set<string>();
	private bytes = 0;

	constructor(
		readonly maxItems: number,
		readonly maxBytes: number,
	) {
		if (!Number.isInteger(maxItems) || maxItems < 1) {
			throw new RangeError("FIFO item bound must be a positive integer");
		}
		if (!Number.isInteger(maxBytes) || maxBytes < 1) {
			throw new RangeError("FIFO byte bound must be a positive integer");
		}
	}

	has(key: string): boolean {
		return this.keys.has(key);
	}

	enqueue(key: string, value: T, bytes: number): QueueAdmission {
		if (!Number.isInteger(bytes) || bytes < 0) {
			throw new RangeError("FIFO entry bytes must be a non-negative integer");
		}
		if (this.keys.has(key)) return "duplicate";
		if (this.entries.length >= this.maxItems || this.bytes + bytes > this.maxBytes) {
			return "capacity";
		}
		this.entries.push({ key, value, bytes });
		this.keys.add(key);
		this.bytes += bytes;
		return "accepted";
	}

	peek(): { key: string; value: T; bytes: number } | undefined {
		const entry = this.entries[0];
		return entry === undefined ? undefined : { ...entry };
	}

	shift(): { key: string; value: T; bytes: number } | undefined {
		const entry = this.entries.shift();
		if (entry === undefined) return undefined;
		this.keys.delete(entry.key);
		this.bytes -= entry.bytes;
		return entry;
	}

	remove(key: string): { key: string; value: T; bytes: number } | undefined {
		const index = this.entries.findIndex((entry) => entry.key === key);
		if (index < 0) return undefined;
		const [entry] = this.entries.splice(index, 1);
		if (entry === undefined) return undefined;
		this.keys.delete(entry.key);
		this.bytes -= entry.bytes;
		return entry;
	}

	values(): T[] {
		return this.entries.map((entry) => entry.value);
	}

	clear(): void {
		this.entries.length = 0;
		this.keys.clear();
		this.bytes = 0;
	}

	get length(): number {
		return this.entries.length;
	}

	get totalBytes(): number {
		return this.bytes;
	}
}

export function takeRenderedPrefix<T>(
	queue: BoundedKeyedByteFifo<T>,
	maxBytes: number,
	render: (value: T) => string,
): RenderedQueueItem<T>[] {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) {
		throw new RangeError("Rendered prefix byte bound must be a positive integer");
	}
	const renderedPrefix: string[] = [];
	let selectedBytes = 0;
	for (const value of queue.values()) {
		const rendered = render(value);
		const renderedBytes = Buffer.byteLength(rendered, "utf8");
		if (renderedBytes > maxBytes) {
			throw new RangeError("One rendered FIFO entry exceeds the prefix byte bound");
		}
		const separatorBytes = renderedPrefix.length === 0 ? 0 : Buffer.byteLength("\n\n", "utf8");
		if (renderedPrefix.length > 0 && selectedBytes + separatorBytes + renderedBytes > maxBytes) {
			break;
		}
		renderedPrefix.push(rendered);
		selectedBytes += separatorBytes + renderedBytes;
	}

	return renderedPrefix.map((rendered) => {
		const shifted = queue.shift();
		if (shifted === undefined) {
			throw new Error("Rendered FIFO prefix changed before dequeue");
		}
		return { ...shifted, rendered };
	});
}
