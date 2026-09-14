/**
 * Shared experiment identity for F9 harness result records (run-context,
 * run-compare). Persisted results are only eligible for resume when the
 * recorded identity matches the current corpus/model/prompt/commit — otherwise
 * a regenerated corpus or changed config would silently mix unrelated results.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function gitHeadCommit(): string {
	try {
		// SAFETY: fixed-argument git query in the repo cwd; no user input is interpolated.
		return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

/** Local (`./x.js`) import specifier, resolved to `x.ts` next to the importing file. */
const LOCAL_IMPORT = /(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/gu;

/**
 * Content hash of the harness sources a given experiment actually depends on.
 *
 * `gitHeadCommit()` alone does not make resume safe: these scripts are edited
 * in place while an experiment is running, so a rerun before committing keeps
 * the same HEAD while the rendering or budget logic changed.
 *
 * The hash covers the entry script plus its transitive RELATIVE imports — both
 * inside `scripts/f9-experiment` and the production modules it pulls from
 * `src/` (rendering, prompt building, configuration), since an uncommitted
 * change there shifts what the model actually sees. It deliberately does NOT
 * hash the whole directory: an edit to an unrelated analyzer must not
 * invalidate persisted live results and re-spend a paid run. An unresolvable
 * relative import throws instead of degrading to a shorter file set, so a
 * missed dependency can never silently under-invalidate.
 */
export function f9HarnessHash(entryUrl: string): string {
	const entry = fileURLToPath(entryUrl);
	const contents = new Map<string, string>();
	const collect = (filePath: string): void => {
		if (contents.has(filePath)) return;
		const source = readFileSync(filePath, "utf8");
		contents.set(filePath, source);
		for (const match of source.matchAll(LOCAL_IMPORT)) {
			const specifier = match[1] ?? "";
			// Resolve against the IMPORTING file so `../` escapes (for example
			// `../../src/runtime.js`) reach the production module closure.
			const dependency = resolve(dirname(filePath), specifier.replace(/\.js$/u, ".ts"));
			try {
				readFileSync(dependency, "utf8");
			} catch {
				throw new Error(`${filePath} imports ${specifier} but ${dependency} is unreadable`);
			}
			collect(dependency);
		}
	};
	collect(entry);
	const hash = createHash("sha256");
	for (const filePath of [...contents.keys()].sort()) {
		// Paths are hashed relative to the entry's directory so the fingerprint is
		// reproducible across checkouts (absolute prefixes differ per machine).
		hash.update(relative(dirname(entry), filePath));
		hash.update("\u0000");
		hash.update(contents.get(filePath) ?? "");
		hash.update("\u0000");
	}
	return hash.digest("hex").slice(0, 16);
}

export function sha256Head16(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Identity fields every F9 harness records on each result row. */
export interface ExperimentIdentityBase {
	/** Hash of the semantic corpus payload (script-specific mapping). */
	datasetHash: string;
	model: string;
	promptHash: string;
	protocol: string;
	sourceCommit: string;
	/** Hash of the harness sources; a script edit invalidates resume without a new commit. */
	harnessHash: string;
}

/** Compare the shared base fields; scripts add their own extra fields on top. */
export function identityBaseMatches<B extends ExperimentIdentityBase>(
	stored: B | undefined,
	identity: B,
): boolean {
	if (stored === undefined) return false;
	return (
		stored.datasetHash === identity.datasetHash &&
		stored.model === identity.model &&
		stored.promptHash === identity.promptHash &&
		stored.protocol === identity.protocol &&
		stored.sourceCommit === identity.sourceCommit &&
		stored.harnessHash === identity.harnessHash
	);
}
