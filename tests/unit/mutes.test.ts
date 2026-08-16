import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	boundedFindingLabel,
	findingMuteId,
	isHexPrefix,
	MAX_MUTE_ENTRIES,
	MuteStore,
	RecentFindingsIndex,
} from "../../src/mutes.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("Quality Slice Q6 bounded finding labels and mute IDs", () => {
	it("redacts and truncates raw findingKey text to the fixed 128-character bound", () => {
		expect(boundedFindingLabel("migration rollback defect")).toBe("migration rollback defect");
		expect(boundedFindingLabel("  ")).toBeUndefined();
		expect(boundedFindingLabel("secret API_KEY=sk-live-12345 value")).toBe(
			"secret API_KEY=[REDACTED] value",
		);
		const long = `x${"y".repeat(300)}`;
		const bounded = boundedFindingLabel(long);
		expect(bounded).toBeDefined();
		expect(Array.from(bounded ?? "").length).toBe(128);
	});

	it("derives the 8-hex mute ID and validates hex prefixes from 8 to 64 characters", () => {
		expect(findingMuteId(HASH_A)).toBe("a".repeat(8));
		expect(isHexPrefix("a".repeat(8))).toBe(true);
		expect(isHexPrefix("a".repeat(64))).toBe(true);
		expect(isHexPrefix("A1B2C3D4")).toBe(true);
		expect(isHexPrefix("a".repeat(7))).toBe(false);
		expect(isHexPrefix("a".repeat(65))).toBe(false);
		expect(isHexPrefix("xyzabc12")).toBe(false);
		expect(isHexPrefix("")).toBe(false);
	});
});

describe("Quality Slice Q6 recent-findings index (Q6-A1)", () => {
	it("keeps the last 128 delivered findings and replaces the oldest first", () => {
		const index = new RecentFindingsIndex();
		for (let i = 0; i < MAX_MUTE_ENTRIES + 10; i++) {
			index.add(i.toString(16).padStart(64, "0"), `label-${String(i)}`);
		}
		expect(index.length).toBe(MAX_MUTE_ENTRIES);
		const entries = index.entries();
		expect(entries[0]?.label).toBe("label-10");
		expect(entries.at(-1)?.label).toBe(`label-${String(MAX_MUTE_ENTRIES + 9)}`);
	});

	it("refreshes a re-delivered finding to the newest position", () => {
		const index = new RecentFindingsIndex();
		index.add(HASH_A, "label-a");
		index.add(HASH_B, "label-b");
		index.add(HASH_A, "label-a-updated");
		expect(index.entries().map((entry) => entry.label)).toEqual(["label-b", "label-a-updated"]);
	});

	it("resolves unique prefixes and reports every collision", () => {
		const index = new RecentFindingsIndex();
		index.add(HASH_A, "alpha");
		index.add(HASH_B, "beta");
		expect(index.resolve("a".repeat(8)).map((entry) => entry.label)).toEqual(["alpha"]);
		expect(index.resolve("b".repeat(8)).map((entry) => entry.label)).toEqual(["beta"]);
		expect(index.resolve("c".repeat(8))).toEqual([]);
		const forced = new RecentFindingsIndex();
		forced.add("3acae8117b9278b6abcd0af81be30e421e0f8f274c6dff6fae7b34aed748788b", "first");
		forced.add("3acae811e1737ad5fc3f01ceb252dad1df95e3729b89966d410e69352564839c", "second");
		expect(forced.resolve("3acae811")).toHaveLength(2);
		expect(forced.resolve("3acae8117b")).toHaveLength(1);
		// Uppercase prefixes normalize before matching.
		expect(forced.resolve("3ACAE811").length).toBeGreaterThan(1);
	});

	it("restores persisted entries within the capacity bound and skips malformed ones", () => {
		const index = new RecentFindingsIndex(2);
		index.restore([
			{ hash: HASH_A, label: "alpha" },
			{ hash: HASH_B, label: "beta" },
			{ hash: "c".repeat(64), label: "gamma" },
		]);
		expect(index.entries().map((entry) => entry.label)).toEqual(["beta", "gamma"]);
	});
});

describe("Quality Slice Q6 durable mutes file (Q6-D2)", () => {
	it("round-trips atomically through save and load with the fixed capacity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-advisor-mutes-"));
		const path = join(directory, "mutes.yml");
		const store = new MuteStore(path);
		for (let i = 0; i < MAX_MUTE_ENTRIES + 5; i++) {
			store.mute(i.toString(16).padStart(64, "0"), `muted-${String(i)}`);
		}
		expect(store.list()).toHaveLength(MAX_MUTE_ENTRIES);
		expect(store.list()[0]?.label).toBe("muted-5");
		await store.save();
		const loaded = await MuteStore.load(path);
		expect(loaded.error).toBeUndefined();
		expect(loaded.store.list()).toEqual(store.list());
		expect(loaded.store.isMuted("5".repeat(64))).toBe(false);
		expect(loaded.store.isMuted(`${"0".repeat(63)}5`)).toBe(true);
		const raw = await readFile(path, "utf8");
		expect(raw).toContain("muted-5");
	});

	it("treats a missing file as the empty first-run state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-advisor-mutes-"));
		const loaded = await MuteStore.load(join(directory, "mutes.yml"));
		expect(loaded.error).toBeUndefined();
		expect(loaded.store.list()).toEqual([]);
	});

	it("fails closed on a malformed file without overwriting it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-advisor-mutes-"));
		const path = join(directory, "mutes.yml");
		await writeFile(path, "not: [valid\n  - yaml: {", "utf8");
		const loaded = await MuteStore.load(path);
		expect(loaded.error).toContain("malformed");
		expect(loaded.store.list()).toEqual([]);
		expect(await readFile(path, "utf8")).toContain("not: [valid");
	});

	it("rejects invalid entries, duplicate ids, secrets, and oversized labels", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-advisor-mutes-"));
		const path = join(directory, "mutes.yml");
		const cases = [
			[{ id: "short", label: "x" }],
			[
				{ id: HASH_A, label: "x" },
				{ id: HASH_A, label: "y" },
			],
			[{ id: HASH_A, label: "API_KEY=sk-live-12345" }],
			[{ id: HASH_A, label: "z".repeat(129) }],
			[{ id: HASH_A }],
			[{ id: HASH_A, label: "x", extra: "y" }],
			[{ id: HASH_A, label: "" }],
		];
		for (const [index, document] of cases.entries()) {
			await writeFile(path, JSON.stringify(document), "utf8");
			const loaded = await MuteStore.load(path);
			expect(loaded.error, `case ${String(index)}`).toBeDefined();
			expect(loaded.store.list(), `case ${String(index)}`).toEqual([]);
		}
	});

	it("fails closed on an oversized file without materializing its content", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-advisor-mutes-"));
		const path = join(directory, "mutes.yml");
		await writeFile(
			path,
			`${JSON.stringify({ id: HASH_A, label: "alpha" })}\n`.repeat(1_000_000),
			"utf8",
		);
		const loaded = await MuteStore.load(path);
		expect(loaded.error).toContain("size bound");
		expect(loaded.store.list()).toEqual([]);
	});

	it("unmutes by exact hash and ignores unknown hashes", () => {
		const store = new MuteStore("/unused");
		store.mute(HASH_A, "alpha");
		expect(store.unmute(HASH_B)).toBe(false);
		expect(store.unmute(HASH_A)).toBe(true);
		expect(store.list()).toEqual([]);
	});

	it("resolves muted entries by hex prefix with fail-closed collisions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-advisor-mutes-"));
		const path = join(directory, "mutes.yml");
		const store = new MuteStore(path);
		store.mute("3acae8117b9278b6abcd0af81be30e421e0f8f274c6dff6fae7b34aed748788b", "first");
		store.mute("3acae811e1737ad5fc3f01ceb252dad1df95e3729b89966d410e69352564839c", "second");
		await store.save();
		const loaded = await MuteStore.load(path);
		expect(loaded.store.resolve("3acae811")).toHaveLength(2);
		expect(loaded.store.resolve("3acae8117b")).toHaveLength(1);
		expect(loaded.store.resolve("f".repeat(8))).toHaveLength(0);
	});
});
