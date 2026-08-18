import type { CustomEntry, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	type Component,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";

import type {
	AdviceDelivery,
	AdviceDedupeTag,
	AdviceSeverity,
	MemorySuggestionQueueState,
} from "./advice.js";
import { HARD_LIMITS } from "./config.js";
import { findingMuteId } from "./mutes.js";
import { sanitizeTerminalText } from "./redaction.js";
import {
	isMemorySuggestionBasis,
	isMemorySuggestionCategory,
	type MemorySuggestionBasis,
	type MemorySuggestionCategory,
} from "./memory-suggestions.js";
import { MAX_DEFERRED_DELIVERY_BYTES, MAX_PENDING_ADVICE_ITEMS } from "./delivery.js";
import { isBooleanValue, isNumberValue, isRecordValue, isStringValue } from "./value-guards.js";

export const ADVISOR_LATE_ENTRY_TYPE = "pi-advisor-late-note";

interface AdvicePresentationBase {
	note: string;
	delivery: AdviceDelivery;
	stale?: boolean;
	truncated: boolean;
	originalCharacters: number;
	originalEstimatedTokens: number;
	createdAt: number;
	deliveryId?: string;
	reviewId?: string;
	displayedInEntry?: boolean;
	restoredAfterResume?: boolean;
}

export interface ReviewAdvicePresentationNote extends AdvicePresentationBase {
	intent: "review";
	severity: AdviceSeverity;
	tag?: AdviceDedupeTag;
	/** First 8 hex characters of the findingKeyHash; shown only with a display label. */
	muteId?: string;
	/** Bounded redacted display label of the raw findingKey; never command input. */
	findingKey?: string;
	/**
	 * Opaque SHA-256 findingKeyHash, carried through the delivered-message
	 * details so restart recovery can rebuild the dedupe identity and the
	 * recent-findings mute index from the branch note.
	 */
	findingKeyHash?: string;
}

export interface MemorySuggestionPresentationNote extends AdvicePresentationBase {
	intent: "memory-suggestion";
	memory: {
		text: string;
		category: MemorySuggestionCategory;
		basis: MemorySuggestionBasis;
	};
	queueState?: MemorySuggestionQueueState;
}

export type AdvicePresentationNote =
	| ReviewAdvicePresentationNote
	| MemorySuggestionPresentationNote;

export interface AdviceMessageDetails extends Partial<AdvicePresentationBase> {
	notes: AdvicePresentationNote[];
	intent?: AdvicePresentationNote["intent"];
	severity?: AdviceSeverity;
	tag?: AdviceDedupeTag;
	muteId?: string;
	findingKey?: string;
	findingKeyHash?: string;
	memory?: MemorySuggestionPresentationNote["memory"];
	queueState?: MemorySuggestionQueueState;
}

export interface LateAdviceEntryData {
	note: AdvicePresentationNote;
	displayedAt: number;
}

function sanitizeXmlCharacters(input: string): string {
	let output = "";
	for (const character of input) {
		const codePoint = character.codePointAt(0) ?? 0;
		const valid =
			codePoint === 0x9 ||
			codePoint === 0xa ||
			codePoint === 0xd ||
			(codePoint >= 0x20 && codePoint <= 0xd7ff) ||
			(codePoint >= 0xe000 && codePoint <= 0xfffd) ||
			(codePoint >= 0x10000 && codePoint <= 0x10ffff);
		output += valid ? character : "\uFFFD";
	}
	return output;
}

export function escapeXmlText(input: string): string {
	return sanitizeXmlCharacters(input)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function escapeXmlAttribute(input: string): string {
	return escapeXmlText(input).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

const INLINE_PAREN_NUMBERED_MARKER = /(?:^|[\t\n ;:])(\d{1,2}\))[ \t]+(?=\S)/gu;
const INLINE_DOT_NUMBERED_MARKER = /(?:^|[\t\n;:])(\d{1,2}\.)[ \t]+(?=\S)/gu;

function cleanAdviceListItem(text: string): string {
	return text
		.replace(/[,;]?\s+and\s*$/iu, "")
		.replace(/[,;:]\s*$/u, "")
		.trim();
}

function hasAlternativeConjunction(text: string): boolean {
	return /(?:^|[,;:\s])or\s*$/iu.test(text.trim());
}

function hasExistingMarkdownList(block: string): boolean {
	return /^(?: {0,3}(?:\d+[.)]|[-*+])\s+\S)/mu.test(block) && block.includes("\n");
}

const SENTENCE_ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|vs|etc|mr|ms|mrs|dr|fig|no|v)\.$/iu;

function isSentenceBoundary(prefix: string, remainder: string): boolean {
	if (!/^[A-Z`"'(]/u.test(remainder)) return false;
	if (/(?:^|\s)\d\.$/u.test(prefix)) return false;
	if (prefix.endsWith("..")) return false;
	return !SENTENCE_ABBREVIATION.test(prefix);
}

function hasUnbalancedInlineCode(text: string): boolean {
	let ticks = 0;
	for (const character of text) {
		if (character === "`") ticks++;
	}
	return ticks % 2 === 1;
}

function splitLeadFromBody(block: string): string {
	if (block.includes("\n") || hasExistingMarkdownList(block)) return block;
	const colon = /^([^:\n]{8,80}):\s+([A-Za-z`"'(].{19,})$/u.exec(block);
	if (
		colon?.[1] !== undefined &&
		colon[2] !== undefined &&
		!colon[1].includes("//") &&
		!/\d$/u.test(colon[1]) &&
		!hasUnbalancedInlineCode(colon[1])
	) {
		return `${colon[1]}:\n\n${colon[2]}`;
	}
	const match = /^([\s\S]+?[.?!])\s+([\s\S]+)$/u.exec(block);
	if (match?.[1] === undefined || match[2] === undefined) return block;
	if (match[1].length > 140 || match[2].length < 24) return block;
	if (!isSentenceBoundary(match[1], match[2]) || hasUnbalancedInlineCode(match[1])) return block;
	return `${match[1]}\n\n${match[2]}`;
}

function splitInlineNumberedItems(
	block: string,
	pattern: RegExp,
): { intro: string; items: { marker: string; text: string }[] } | undefined {
	const matches = [...block.matchAll(pattern)];
	if (matches.length < 2) return undefined;
	const items: { marker: string; text: string }[] = [];
	for (const [index, match] of matches.entries()) {
		const marker = match[1];
		if (marker === undefined) return undefined;
		const previous = items.at(-1);
		const number = Number.parseInt(marker, 10);
		if (
			!Number.isInteger(number) ||
			number !== index + 1 ||
			(previous !== undefined && number !== Number.parseInt(previous.marker, 10) + 1)
		) {
			return undefined;
		}
		const textStart = match.index + match[0].length;
		const nextMatch = matches[index + 1];
		const textEnd = nextMatch === undefined ? block.length : nextMatch.index;
		const rawText = block.slice(textStart, textEnd);
		if (nextMatch !== undefined && hasAlternativeConjunction(rawText)) return undefined;
		const text = cleanAdviceListItem(rawText);
		if (text.length === 0) return undefined;
		items.push({ marker, text });
	}
	const first = matches[0];
	if (first === undefined) return undefined;
	const intro = block.slice(0, first.index).trim();
	if (hasAlternativeConjunction(intro)) return undefined;
	return { intro, items };
}

export function formatAdviceCardMarkdown(input: string): string {
	const sanitized = sanitizeTerminalText(input).trim();
	if (sanitized.length === 0) return sanitized;
	return sanitized
		.split(/\n{2,}/u)
		.map((block) => {
			const normalized = block.trim();
			if (normalized.length === 0 || hasExistingMarkdownList(normalized)) return normalized;
			const split =
				splitInlineNumberedItems(normalized, INLINE_PAREN_NUMBERED_MARKER) ??
				splitInlineNumberedItems(normalized, INLINE_DOT_NUMBERED_MARKER);
			if (split === undefined) return splitLeadFromBody(normalized);
			const list = split.items.map((item) => `${item.marker} ${item.text}`).join("\n");
			const intro = splitLeadFromBody(cleanAdviceListItem(split.intro));
			return intro.length === 0 ? list : `${intro}\n\n${list}`;
		})
		.filter((block) => block.length > 0)
		.join("\n\n");
}

function markdownThemeFrom(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		underline: (text) => theme.underline(text),
		strikethrough: (text) => theme.strikethrough(text),
	};
}

function renderAdviceCardMarkdown(text: string, theme: Theme): Component {
	return new Markdown(
		formatAdviceCardMarkdown(text),
		0,
		0,
		markdownThemeFrom(theme),
		{ color: (value) => theme.fg("customMessageText", value) },
		{ preserveOrderedListMarkers: true },
	);
}

export function reviewNoteMuteId(advice: {
	intent: "review";
	findingKeyHash?: string;
	findingKey?: string;
}): string | undefined {
	return advice.findingKeyHash !== undefined && advice.findingKey !== undefined
		? findingMuteId(advice.findingKeyHash)
		: undefined;
}

function isAdviceSeverity<T>(value: T): value is T & AdviceSeverity {
	return value === "nit" || value === "concern" || value === "blocker";
}

function isMuteId<T>(value: T): value is T & string {
	return isStringValue(value) && /^[a-f0-9]{8}$/u.test(value);
}

function isFindingLabel<T>(value: T): value is T & string {
	return isStringValue(value) && Array.from(value).length > 0 && Array.from(value).length <= 128;
}

function isAdviceDelivery<T>(value: T): value is T & AdviceDelivery {
	return value === "active" || value === "deferred";
}

function isFiniteNonNegative<T>(value: T): value is T & number {
	return isNumberValue(value) && Number.isFinite(value) && value >= 0;
}

function isRenderableTimestamp<T>(value: T): value is T & number {
	return isFiniteNonNegative(value) && value <= 8_640_000_000_000_000;
}

function textFitsBound<T>(value: T, maximumCharacters: number): value is T & string {
	if (!isStringValue(value) || value.length > maximumCharacters * 2) return false;
	return Array.from(value).length <= maximumCharacters;
}

interface UnvalidatedPresentationNote {
	note?: unknown;
	delivery?: unknown;
	truncated?: unknown;
	originalCharacters?: unknown;
	originalEstimatedTokens?: unknown;
	createdAt?: unknown;
	stale?: unknown;
	deliveryId?: unknown;
	reviewId?: unknown;
	displayedInEntry?: unknown;
	restoredAfterResume?: unknown;
	intent?: unknown;
	severity?: unknown;
	tag?: unknown;
	muteId?: unknown;
	findingKey?: unknown;
	memory?: unknown;
	queueState?: unknown;
}

interface UnvalidatedPresentationMemory {
	text?: unknown;
	category?: unknown;
	basis?: unknown;
}

function parsePresentationBase(
	note: UnvalidatedPresentationNote,
): AdvicePresentationBase | undefined {
	if (
		!textFitsBound(note.note, HARD_LIMITS.maxAdviceCharacters) ||
		!isAdviceDelivery(note.delivery) ||
		!isBooleanValue(note.truncated) ||
		!isFiniteNonNegative(note.originalCharacters) ||
		!isFiniteNonNegative(note.originalEstimatedTokens) ||
		!isRenderableTimestamp(note.createdAt)
	) {
		return undefined;
	}
	const base: AdvicePresentationBase = {
		note: note.note,
		delivery: note.delivery,
		truncated: note.truncated,
		originalCharacters: note.originalCharacters,
		originalEstimatedTokens: note.originalEstimatedTokens,
		createdAt: note.createdAt,
	};
	if (note.stale === true) base.stale = true;
	if (isStringValue(note.deliveryId) && note.deliveryId.length <= 512) {
		base.deliveryId = note.deliveryId;
	}
	if (isStringValue(note.reviewId) && note.reviewId.length <= 128) {
		base.reviewId = note.reviewId;
	}
	if (note.displayedInEntry === true) base.displayedInEntry = true;
	if (note.restoredAfterResume === true) base.restoredAfterResume = true;
	return base;
}

function parsePresentationNote(value: unknown): AdvicePresentationNote | undefined {
	if (!isRecordValue<UnvalidatedPresentationNote>(value)) return undefined;
	const note = value;
	const base = parsePresentationBase(note);
	if (base === undefined) return undefined;
	if (note.intent === "review" && isAdviceSeverity(note.severity)) {
		const review: ReviewAdvicePresentationNote = {
			...base,
			intent: "review",
			severity: note.severity,
		};
		if (note.tag === "possible-duplicate" || note.tag === "re-raised") review.tag = note.tag;
		if (note.muteId !== undefined && isMuteId(note.muteId)) review.muteId = note.muteId;
		if (note.findingKey !== undefined && isFindingLabel(note.findingKey)) {
			review.findingKey = note.findingKey;
		}
		return review;
	}
	if (
		note.intent !== "memory-suggestion" ||
		!isRecordValue<UnvalidatedPresentationMemory>(note.memory)
	) {
		return undefined;
	}
	const memory = note.memory;
	if (
		!textFitsBound(memory.text, HARD_LIMITS.maxProposedMemoryCharacters) ||
		!isMemorySuggestionCategory(memory.category) ||
		!isMemorySuggestionBasis(memory.basis) ||
		(note.queueState !== undefined && note.queueState !== "could-not-queue")
	) {
		return undefined;
	}
	const suggestion: MemorySuggestionPresentationNote = {
		...base,
		intent: "memory-suggestion",
		memory: { text: memory.text, category: memory.category, basis: memory.basis },
	};
	if (note.queueState === "could-not-queue") suggestion.queueState = note.queueState;
	return suggestion;
}

export function adviceNotesFromDetails(details: unknown): AdvicePresentationNote[] {
	if (!isRecordValue<{ notes?: unknown }>(details)) return [];
	const values = details.notes;
	if (!Array.isArray(values) || values.length > MAX_PENDING_ADVICE_ITEMS) return [];
	const notes: AdvicePresentationNote[] = [];
	let retainedBytes = Buffer.byteLength("[]", "utf8");
	for (const value of values) {
		const note = parsePresentationNote(value);
		if (note === undefined) return [];
		const separatorBytes = notes.length === 0 ? 0 : Buffer.byteLength(",", "utf8");
		retainedBytes += separatorBytes + Buffer.byteLength(JSON.stringify(note), "utf8");
		if (retainedBytes > MAX_DEFERRED_DELIVERY_BYTES) return [];
		notes.push(note);
	}
	return notes;
}

function formatAge(createdAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - createdAt) / 1_000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${String(seconds)}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${String(minutes)}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${String(hours)}h ago`;
	return `${String(Math.floor(hours / 24))}d ago`;
}

function severityColor(severity: AdviceSeverity): "accent" | "warning" | "error" {
	if (severity === "blocker") return "error";
	if (severity === "concern") return "warning";
	return "accent";
}

function formatDeliveryLabel(delivery: AdviceDelivery): string {
	return delivery === "active" ? "active guidance" : "next-turn guidance";
}

class AdvisorCardBorder implements Component {
	constructor(
		private readonly child: Component,
		private readonly theme: Theme,
		private readonly color: "accent" | "warning" | "error",
	) {}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const prefix = `${this.theme.fg(this.color, "│")} `;
		return this.child
			.render(Math.max(1, availableWidth - 2))
			.map((line) => truncateToWidth(`${prefix}${line}`, availableWidth));
	}
}

export function renderAdviceCards(
	notes: readonly AdvicePresentationNote[],
	expanded: boolean,
	theme: Theme,
	now = Date.now(),
): Component {
	const container = new Container();
	for (const [index, note] of notes.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		const color = note.intent === "review" ? severityColor(note.severity) : "accent";
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const label =
			note.intent === "review"
				? note.severity.toUpperCase()
				: note.queueState === "could-not-queue"
					? "MEMORY SUGGESTION - COULD NOT QUEUE"
					: "MEMORY SUGGESTION";
		const heading = `${theme.fg(color, theme.bold("Advisor"))} ${theme.fg(color, label)}`;
		box.addChild(new Text(heading, 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(renderAdviceCardMarkdown(note.note, theme));
		if (note.intent === "memory-suggestion") {
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("muted", "Proposed memory"), 0, 0));
			box.addChild(renderAdviceCardMarkdown(note.memory.text, theme));
		}
		const metadata = [
			formatDeliveryLabel(note.delivery),
			formatAge(note.createdAt, now),
			...(note.intent === "memory-suggestion" ? [note.memory.category, note.memory.basis] : []),
			...(note.stale ? ["potentially stale"] : []),
			...(note.restoredAfterResume ? ["restored after resume"] : []),
			...(note.intent === "review" && note.tag === "possible-duplicate"
				? ["possible duplicate"]
				: []),
			...(note.intent === "review" && note.tag === "re-raised" ? ["re-raised"] : []),
			...(note.intent === "review" && note.muteId !== undefined ? [`mute ${note.muteId}`] : []),
		];
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg(note.stale ? "warning" : "muted", metadata.join(" · ")), 0, 0));
		if (expanded) {
			const details = [
				`created ${new Date(note.createdAt).toISOString()}`,
				`${String(note.originalCharacters)} characters`,
				`~${String(note.originalEstimatedTokens)} tokens`,
				...(note.truncated ? ["note truncated"] : []),
			];
			box.addChild(new Text(theme.fg("dim", details.join(" · ")), 0, 0));
		}
		container.addChild(new AdvisorCardBorder(box, theme, color));
	}
	return container;
}

export function renderAdviceMessage(
	message: Parameters<MessageRenderer>[0],
	options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	const notes = adviceNotesFromDetails(message.details).filter(
		(note) => note.displayedInEntry !== true,
	);
	return notes.length === 0 ? undefined : renderAdviceCards(notes, options.expanded, theme);
}

export function renderLateAdviceEntry(
	entry: CustomEntry<LateAdviceEntryData>,
	options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	const note = parsePresentationNote(entry.data?.note);
	return note === undefined ? undefined : renderAdviceCards([note], options.expanded, theme);
}
