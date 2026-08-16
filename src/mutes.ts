import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parse, stringify } from "yaml";

import { readBounded } from "./configuration.js";
import { redactSecrets } from "./redaction.js";

/**
 * Durable user-scope mutes and the bounded recent-findings index (Q6-A1).
 *
 * Mutes are user data, not configuration: they live in a dedicated file next to
 * the User WATCHDOG configuration, survive epoch changes, branch resets,
 * compatible resumes, and new Pi sessions, and are never touched by
 * `/advisor configure` saves. A package downgrade cannot erase them because no
 * released package writes this file.
 */
export const MUTES_FILE_NAME = "mutes.yml";
export const MAX_MUTE_ENTRIES = 128;
export const MAX_FINDING_LABEL_CHARACTERS = 128;
export const MAX_MUTES_FILE_BYTES = 256 * 1_024;
export const MIN_MUTE_ID_PREFIX_CHARACTERS = 8;
export const MAX_MUTE_ID_PREFIX_CHARACTERS = 64;

export interface RecentFinding {
	/** Full lowercase SHA-256 findingKeyHash. */
	hash: string;
	/** Bounded redacted display label; never used as command input. */
	label: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function boundedText(input: string, maximumCharacters: number): string | undefined {
	const characters = Array.from(input).slice(0, maximumCharacters);
	return characters.length === 0 ? undefined : characters.join("");
}

/**
 * Bounds a raw `findingKey` for display: redacts first, then truncates to the
 * fixed 128-character retention bound. An empty result means the finding has no
 * usable display label and therefore no mute ID on its card.
 */
export function boundedFindingLabel(input: string): string | undefined {
	return boundedText(redactSecrets(input).text.trim(), MAX_FINDING_LABEL_CHARACTERS);
}

export function findingMuteId(hash: string): string {
	return hash.slice(0, 8);
}

export function isHexPrefix(value: string): boolean {
	return (
		value.length >= MIN_MUTE_ID_PREFIX_CHARACTERS &&
		value.length <= MAX_MUTE_ID_PREFIX_CHARACTERS &&
		/^[0-9a-f]+$/iu.test(value)
	);
}

function isRecentFinding(value: unknown): value is RecentFinding {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		Object.keys(entry).length === 2 &&
		typeof entry.hash === "string" &&
		HASH_PATTERN.test(entry.hash) &&
		typeof entry.label === "string" &&
		Array.from(entry.label).length > 0 &&
		Array.from(entry.label).length <= MAX_FINDING_LABEL_CHARACTERS &&
		redactSecrets(entry.label).text === entry.label
	);
}

/**
 * Bounded oldest-first index of the last delivered findings that carried a
 * findingKey. Powers fail-closed 8-to-64-character hex-prefix mute resolution.
 */
export class RecentFindingsIndex {
	private readonly items: RecentFinding[] = [];

	constructor(readonly capacity = MAX_MUTE_ENTRIES) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError("Recent-findings index capacity must be a positive integer");
		}
	}

	add(hash: string, label: string): void {
		if (!HASH_PATTERN.test(hash))
			throw new TypeError("Recent-findings hash must be 64 lowercase hex");
		const bounded = boundedText(label, MAX_FINDING_LABEL_CHARACTERS);
		if (bounded === undefined) throw new TypeError("Recent-findings label must not be empty");
		this.remove(hash);
		this.items.push({ hash, label: bounded });
		if (this.items.length > this.capacity) this.items.shift();
	}

	remove(hash: string): boolean {
		const index = this.items.findIndex((entry) => entry.hash === hash);
		if (index < 0) return false;
		this.items.splice(index, 1);
		return true;
	}

	entries(): readonly RecentFinding[] {
		return this.items.map((entry) => ({ ...entry }));
	}

	restore(entries: readonly RecentFinding[]): void {
		this.items.length = 0;
		for (const entry of entries) {
			if (!isRecentFinding(entry)) continue;
			this.items.push({ ...entry });
		}
		while (this.items.length > this.capacity) this.items.shift();
	}

	resolve(prefix: string): RecentFinding[] {
		const normalized = prefix.toLocaleLowerCase("en-US");
		return this.items.filter((entry) => entry.hash.startsWith(normalized));
	}

	clear(): void {
		this.items.length = 0;
	}

	get length(): number {
		return this.items.length;
	}
}

function isMutesFileEntry(value: unknown): value is { id: string; label: string } {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		Object.keys(entry).length === 2 &&
		typeof entry.id === "string" &&
		HASH_PATTERN.test(entry.id) &&
		typeof entry.label === "string" &&
		Array.from(entry.label).length > 0 &&
		Array.from(entry.label).length <= MAX_FINDING_LABEL_CHARACTERS &&
		redactSecrets(entry.label).text === entry.label
	);
}

function isMutesDocument(value: unknown): value is { id: string; label: string }[] {
	if (!Array.isArray(value) || value.length > MAX_MUTE_ENTRIES) return false;
	if (!value.every(isMutesFileEntry)) return false;
	return new Set(value.map((entry) => entry.id)).size === value.length;
}

/**
 * Durable user-scope mute list backed by an atomically written YAML file.
 * The file is the source of truth; a failed save reverts the in-memory change.
 */
export class MutesFileChangedError extends Error {
	constructor() {
		super("The mutes file changed on disk since it was loaded; retry against the fresh content.");
		this.name = "MutesFileChangedError";
	}
}

/**
 * Shortest prefix per hash that is unique among the given hashes, starting at
 * `minimumLength`. Collision messages use these so the suggested remediation
 * is actionable even though cards and lists display only 8 hex characters.
 */
export function shortestUniquePrefixes(
	hashes: readonly string[],
	minimumLength = 8,
): ReadonlyMap<string, string> {
	const result = new Map<string, string>();
	for (const hash of hashes) {
		let length = minimumLength;
		while (length < hash.length) {
			const prefix = hash.slice(0, length);
			const collides = hashes.some((other) => other !== hash && other.startsWith(prefix));
			if (!collides) break;
			length++;
		}
		result.set(hash, hash.slice(0, length));
	}
	return result;
}

export class MuteStore {
	private entries: RecentFinding[];

	constructor(
		readonly path: string,
		entries: readonly RecentFinding[] = [],
	) {
		this.entries = entries.map((entry) => ({ ...entry }));
		if (this.entries.length > MAX_MUTE_ENTRIES) {
			this.entries = this.entries.slice(this.entries.length - MAX_MUTE_ENTRIES);
		}
	}

	isMuted(hash: string): boolean {
		return this.entries.some((entry) => entry.hash === hash);
	}

	list(): readonly RecentFinding[] {
		return this.entries.map((entry) => ({ ...entry }));
	}

	replace(entries: readonly RecentFinding[]): void {
		this.entries = entries.slice(0, MAX_MUTE_ENTRIES).map((entry) => ({ ...entry }));
	}

	/** Adds a mute with oldest-first replacement at the fixed 128-entry capacity. */
	mute(hash: string, label: string): boolean {
		if (!HASH_PATTERN.test(hash)) throw new TypeError("Mute id must be a 64-hex findingKeyHash");
		const bounded = boundedText(label, MAX_FINDING_LABEL_CHARACTERS);
		if (bounded === undefined) throw new TypeError("Mute label must not be empty");
		if (this.isMuted(hash)) return false;
		this.entries.push({ hash, label: bounded });
		if (this.entries.length > MAX_MUTE_ENTRIES) this.entries.shift();
		return true;
	}

	unmute(hash: string): boolean {
		const index = this.entries.findIndex((entry) => entry.hash === hash);
		if (index < 0) return false;
		this.entries.splice(index, 1);
		return true;
	}

	resolve(prefix: string): RecentFinding[] {
		const normalized = prefix.toLocaleLowerCase("en-US");
		return this.entries.filter((entry) => entry.hash.startsWith(normalized));
	}

	/**
	 * Atomic same-directory temp file, fsync, rename. When
	 * `expectFingerprint` is given, the current file content must still match
	 * it immediately before the rename; a concurrent writer makes the save
	 * throw {@link MutesFileChangedError} so the caller can reload and retry
	 * instead of clobbering the other session's mutes.
	 */
	async save(expectFingerprint?: string): Promise<void> {
		const serialized = stringify(
			this.entries.map((entry) => ({ id: entry.hash, label: entry.label })),
			{ lineWidth: 0 },
		);
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = join(dirname(this.path), `.${MUTES_FILE_NAME}.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
			const handle = await open(temporary, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
			if (expectFingerprint !== undefined) {
				const current = await MuteStore.fingerprint(this.path);
				if (current !== expectFingerprint) {
					throw new MutesFileChangedError();
				}
			}
			await rename(temporary, this.path);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}

	/**
	 * Loads the mutes file. A missing file is the normal first-run state and
	 * yields an empty store. A malformed or oversized file yields an error plus
	 * an empty store; the malformed file is never overwritten.
	 */
	/**
	 * Current raw file content as a fingerprint, or an empty string when the
	 * file is missing. Used by the freshness check before a rename.
	 */
	static async fingerprint(path: string): Promise<string> {
		try {
			return (await readBounded(path, MAX_MUTES_FILE_BYTES)) ?? "";
		} catch {
			return "";
		}
	}

	static async load(
		path: string,
	): Promise<{ store: MuteStore; error?: string; fingerprint?: string }> {
		let text: string | undefined;
		try {
			// Bounded read: at most MAX_MUTES_FILE_BYTES + 1 bytes are materialized,
			// so an oversized file is detected without loading its content.
			text = await readBounded(path, MAX_MUTES_FILE_BYTES);
		} catch {
			return {
				store: new MuteStore(path),
				error: `${path} could not be read; mutes are inactive until the file is repaired.`,
			};
		}
		if (text === undefined) {
			return { store: new MuteStore(path), fingerprint: "" };
		}
		if (Buffer.byteLength(text, "utf8") > MAX_MUTES_FILE_BYTES) {
			return {
				store: new MuteStore(path),
				error: `${path} exceeds the mutes file size bound and was ignored.`,
			};
		}
		try {
			const parsed: unknown = parse(text);
			if (!isMutesDocument(parsed)) {
				return {
					store: new MuteStore(path),
					error: `${path} is malformed; mutes are inactive until the file is repaired.`,
				};
			}
			const entries = parsed.map((entry) => ({ hash: entry.id, label: entry.label }));
			return { store: new MuteStore(path, entries), fingerprint: text };
		} catch {
			return {
				store: new MuteStore(path),
				error: `${path} is malformed; mutes are inactive until the file is repaired.`,
			};
		}
	}
}
