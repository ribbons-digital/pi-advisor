/**
 * Regression tests for the F9 experiment harness plumbing (issue #141 review).
 *
 * Two failure modes are covered because both silently re-bill already-completed
 * live reviews:
 *   1. `loadPersistedJsonl` must not degrade a corrupt results file to an empty
 *      set (that would re-run every completed pair), while still allowing the
 *      documented resume after a process was killed mid-`appendFile`.
 *   2. `f9HarnessHash` must invalidate persisted results when the scripts an
 *      experiment actually depends on change — and must NOT invalidate them for
 *      an unrelated analyzer edit, which would throw away paid results.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	f9HarnessHash,
	identityBaseMatches,
	type ExperimentIdentityBase,
} from "../../scripts/f9-experiment/experiment-identity.js";
import { loadPersistedJsonl } from "../../scripts/f9-experiment/harness.js";

const created: string[] = [];

async function scratchDir(): Promise<string> {
	const dir = join(tmpdir(), `f9-harness-test-${String(created.length)}-${String(Date.now())}`);
	await mkdir(dir, { recursive: true });
	created.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadPersistedJsonl (fail closed on corrupt resume state)", () => {
	it("treats a missing file as an empty first run", async () => {
		const dir = await scratchDir();
		await expect(loadPersistedJsonl(join(dir, "none.jsonl"), "[t]")).resolves.toEqual([]);
	});

	it("returns every row of a valid, newline-terminated file", async () => {
		const dir = await scratchDir();
		const path = join(dir, "ok.jsonl");
		await writeFile(path, '{"a":1}\n{"a":2}\n', "utf8");
		await expect(loadPersistedJsonl(path, "[t]")).resolves.toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("throws on a corrupt middle row instead of resuming from empty", async () => {
		const dir = await scratchDir();
		const path = join(dir, "mid.jsonl");
		await writeFile(path, '{"a":1}\n{"broken\n{"a":3}\n', "utf8");
		await expect(loadPersistedJsonl(path, "[t]")).rejects.toThrow(/mid\.jsonl:2/);
	});

	it("throws on a corrupt FINAL row when the file is newline-terminated", async () => {
		// A terminated file cannot be a torn append: the newline is written last,
		// so this row completed and its corruption is unrecoverable.
		const dir = await scratchDir();
		const path = join(dir, "final.jsonl");
		await writeFile(path, '{"a":1}\n{"a":2}\n{"oops"}\n', "utf8");
		await expect(loadPersistedJsonl(path, "[t]")).rejects.toThrow(/final\.jsonl:3/);
		// The corrupt row must not be quarantined as if it were a torn tail.
		await expect(readFile(`${path}.corrupt`, "utf8")).rejects.toThrow();
	});

	it("quarantines only a torn final append and resumes from the validated prefix", async () => {
		const dir = await scratchDir();
		const path = join(dir, "torn.jsonl");
		await writeFile(path, '{"a":1}\n{"a":2}\n{"a":3,"par', "utf8");
		await expect(loadPersistedJsonl(path, "[t]")).resolves.toEqual([{ a: 1 }, { a: 2 }]);
		await expect(readFile(`${path}.corrupt`, "utf8")).resolves.toBe('{"a":3,"par');
	});
});

describe("f9HarnessHash (scoped to an experiment's real dependencies)", () => {
	/** Build a scratch harness: entry -> shared, plus an unrelated sibling,
	 * plus a module OUTSIDE the script directory reached through `../`. */
	async function scratchHarness(): Promise<{
		entry: string;
		shared: string;
		unrelated: string;
		outside: string;
	}> {
		const dir = await scratchDir();
		const scriptsDir = join(dir, "scripts");
		const srcDir = join(dir, "src");
		await mkdir(scriptsDir, { recursive: true });
		await mkdir(srcDir, { recursive: true });
		const entry = join(scriptsDir, "entry.ts");
		const shared = join(scriptsDir, "shared.ts");
		const unrelated = join(scriptsDir, "unrelated.ts");
		const outside = join(srcDir, "runtime.ts");
		await writeFile(
			entry,
			'import { x } from "./shared.js";\nimport { render } from "../src/runtime.js";\nconsole.log(x, render);\n',
			"utf8",
		);
		await writeFile(shared, "export const x = 1;\n", "utf8");
		await writeFile(unrelated, "export const y = 2;\n", "utf8");
		await writeFile(outside, 'export const render = "v1";\n', "utf8");
		return { entry, shared, unrelated, outside };
	}

	it("is deterministic and distinct per entry point", async () => {
		const { entry, shared } = await scratchHarness();
		expect(f9HarnessHash(pathToFileURL(entry).href)).toBe(f9HarnessHash(pathToFileURL(entry).href));
		expect(f9HarnessHash(pathToFileURL(entry).href)).not.toBe(
			f9HarnessHash(pathToFileURL(shared).href),
		);
	});

	it("changes when a transitive dependency changes", async () => {
		const { entry, shared } = await scratchHarness();
		const before = f9HarnessHash(pathToFileURL(entry).href);
		await writeFile(shared, "export const x = 99;\n", "utf8");
		expect(f9HarnessHash(pathToFileURL(entry).href)).not.toBe(before);
	});

	it("does not change when an unrelated sibling script changes", async () => {
		const { entry, unrelated } = await scratchHarness();
		const before = f9HarnessHash(pathToFileURL(entry).href);
		await writeFile(unrelated, "export const y = 99;\n", "utf8");
		expect(f9HarnessHash(pathToFileURL(entry).href)).toBe(before);
	});

	it("changes when a production module outside the script directory changes", async () => {
		// The rendering/prompt modules under src/ decide what the model sees, so an
		// uncommitted edit there must invalidate resume just like a harness edit.
		const { entry, outside } = await scratchHarness();
		const before = f9HarnessHash(pathToFileURL(entry).href);
		await writeFile(outside, 'export const render = "v2";\n', "utf8");
		expect(f9HarnessHash(pathToFileURL(entry).href)).not.toBe(before);
	});

	it("throws instead of silently under-hashing an unresolvable local import", async () => {
		const dir = await scratchDir();
		const entry = join(dir, "entry.ts");
		await writeFile(entry, 'import { gone } from "./missing.js";\n', "utf8");
		expect(() => f9HarnessHash(pathToFileURL(entry).href)).toThrow(/missing/);
	});
});

describe("identityBaseMatches (resume eligibility)", () => {
	const base: ExperimentIdentityBase = {
		datasetHash: "d",
		model: "m",
		promptHash: "p",
		protocol: "proto",
		sourceCommit: "c",
		harnessHash: "h",
	};

	it("accepts an exact identity match", () => {
		expect(identityBaseMatches(base, { ...base })).toBe(true);
	});

	it("rejects a missing or harness-changed identity", () => {
		expect(identityBaseMatches(undefined, base)).toBe(false);
		expect(identityBaseMatches({ ...base, harnessHash: "other" }, base)).toBe(false);
		expect(identityBaseMatches({ ...base, datasetHash: "other" }, base)).toBe(false);
	});
});
