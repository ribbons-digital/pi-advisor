import { execFile, type ExecFileException } from "node:child_process";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, matchesGlob, normalize, relative, resolve, sep } from "node:path";

import {
	createReadToolDefinition,
	defineTool,
	truncateHead,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AdvisorConfig, ReadOnlyToolName } from "./config.js";

const BLOCKED_DIRECTORY_NAMES = new Set([
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	"private-keys-v1.d",
]);
const BLOCKED_FILE_NAMES = new Set([
	".npmrc",
	".pypirc",
	".credentials",
	"credentials.json",
	"auth.json",
	"docker-config.json",
	"login data",
	"keychain-db",
]);
const BLOCKED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks"];
const BLOCKED_HOME_PATHS = [
	resolve(homedir(), ".config", "gcloud"),
	resolve(homedir(), ".docker", "config.json"),
	resolve(homedir(), ".pi", "agent", "auth.json"),
];
const MAX_TRAVERSAL_DIRECTORIES = 2_000;
const MAX_TRAVERSAL_ENTRIES = 20_000;
const MAX_GREP_FILES = 500;
const MAX_GREP_FILE_BYTES = 1_000_000;
const MAX_GREP_TOTAL_BYTES = 5_000_000;
const GREP_TIMEOUT_MS = 2_000;

function stripAtAlias(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function comparePath(path: string): string {
	const normalized = normalize(path);
	return process.platform === "win32" || process.platform === "darwin"
		? normalized.toLocaleLowerCase("en-US")
		: normalized;
}

function isWithin(candidate: string, root: string): boolean {
	const comparedCandidate = comparePath(candidate);
	const comparedRoot = comparePath(root);
	const rootPrefix = comparedRoot.endsWith(sep) ? comparedRoot : `${comparedRoot}${sep}`;
	return comparedCandidate === comparedRoot || comparedCandidate.startsWith(rootPrefix);
}

async function canonicalize(path: string): Promise<string> {
	let current = path;
	const suffix: string[] = [];
	for (;;) {
		try {
			const existing = await realpath(current);
			return resolve(existing, ...suffix.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			suffix.push(basename(current));
			current = parent;
		}
	}
}

function hasBlockedDefault(path: string): boolean {
	const comparable = comparePath(path);
	const parts = comparable.split(sep).filter(Boolean);
	const fileName = parts.at(-1) ?? "";
	if (fileName === ".env" || fileName.startsWith(".env.")) return true;
	if (BLOCKED_FILE_NAMES.has(fileName)) return true;
	if (BLOCKED_EXTENSIONS.some((extension) => fileName.endsWith(extension))) return true;
	if (parts.some((part) => BLOCKED_DIRECTORY_NAMES.has(part))) return true;
	if (parts.includes(".ssh") && fileName.startsWith("id_")) return true;
	return BLOCKED_HOME_PATHS.some((protectedPath) => isWithin(path, protectedPath));
}

export class ProtectedPathPolicy {
	private readonly additional: string[];
	private readonly additionalTargets: Promise<string[]>;
	private readonly exceptions: string[];
	private readonly exceptionTargets: Promise<string[]>;

	constructor(
		private readonly cwd: string,
		security: AdvisorConfig["security"],
	) {
		this.additional = security.additionalProtectedPaths.map((path) =>
			resolve(cwd, stripAtAlias(path)),
		);
		this.additionalTargets = Promise.all(this.additional.map(canonicalize));
		this.exceptions = security.protectedPathExceptions.map((path) =>
			resolve(cwd, stripAtAlias(path)),
		);
		this.exceptionTargets = Promise.all(this.exceptions.map(canonicalize));
	}

	async allows(inputPath: string): Promise<boolean> {
		const requested = resolve(this.cwd, stripAtAlias(inputPath));
		const canonical = await canonicalize(requested);
		const [additionalTargets, exceptionTargets] = await Promise.all([
			this.additionalTargets,
			this.exceptionTargets,
		]);
		const excepted = this.exceptions.some(
			(exception, index) =>
				comparePath(exception) === comparePath(requested) ||
				comparePath(exceptionTargets[index] ?? exception) === comparePath(canonical),
		);
		if (excepted) return true;
		const candidates = [requested, canonical];
		return !candidates.some(
			(candidate) =>
				hasBlockedDefault(candidate) ||
				this.additional.some(
					(protectedPath, index) =>
						isWithin(candidate, protectedPath) ||
						isWithin(candidate, additionalTargets[index] ?? protectedPath),
				),
		);
	}
}

function blockedResult() {
	return {
		content: [{ type: "text" as const, text: "Access blocked by Advisor protected-path policy." }],
		details: { blocked: true },
	};
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	const truncation = truncateHead(text);
	return {
		content: [{ type: "text" as const, text: truncation.content }],
		details: { blocked: false, ...details, ...(truncation.truncated ? { truncation } : {}) },
	};
}

interface CollectedFiles {
	files: string[];
	truncated: boolean;
	visitedDirectories: number;
	examinedEntries: number;
}

async function collectFiles(
	root: string,
	policy: ProtectedPathPolicy,
	maxFiles: number,
	maxDirectories = MAX_TRAVERSAL_DIRECTORIES,
	maxEntries = MAX_TRAVERSAL_ENTRIES,
): Promise<CollectedFiles> {
	const files: string[] = [];
	const pending = [root];
	const visited = new Set<string>();
	let examinedEntries = 0;
	let budgetReached = false;
	while (pending.length > 0 && files.length < maxFiles && !budgetReached) {
		const current = pending.pop();
		if (current === undefined || !(await policy.allows(current))) continue;
		let info;
		try {
			info = await lstat(current);
		} catch {
			continue;
		}
		if (info.isSymbolicLink()) {
			try {
				const target = await realpath(current);
				if (!(await policy.allows(target))) continue;
				const targetInfo = await stat(target);
				if (targetInfo.isDirectory()) pending.push(target);
				else if (targetInfo.isFile()) files.push(current);
			} catch {
				continue;
			}
			continue;
		}
		if (info.isFile()) {
			files.push(current);
			continue;
		}
		if (!info.isDirectory()) continue;
		const canonical = await canonicalize(current);
		if (visited.has(canonical)) continue;
		if (visited.size >= maxDirectories) {
			budgetReached = true;
			break;
		}
		visited.add(canonical);
		let directory;
		try {
			directory = await opendir(current);
		} catch {
			continue;
		}
		for await (const entry of directory) {
			if (examinedEntries >= maxEntries) {
				budgetReached = true;
				break;
			}
			examinedEntries++;
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const child = resolve(current, entry.name);
			if (await policy.allows(child)) pending.push(child);
		}
	}
	return {
		files: files.slice(0, maxFiles),
		truncated: budgetReached || pending.length > 0 || files.length > maxFiles,
		visitedDirectories: visited.size,
		examinedEntries,
	};
}

function displayPath(cwd: string, path: string): string {
	const value = relative(cwd, path);
	return value.length === 0 ? "." : value;
}

function createReadTool(cwd: string, policy: ProtectedPathPolicy) {
	const base = createReadToolDefinition(cwd);
	return defineTool({
		name: base.name,
		label: base.label,
		description: base.description,
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
			offset: Type.Optional(Type.Number({ description: "Line number to start reading from" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			if (!(await policy.allows(params.path))) return blockedResult();
			const result = await base.execute(id, params, signal, onUpdate, ctx);
			return { ...result, details: { blocked: false, ...(result.details ?? {}) } };
		},
	});
}

function createLsTool(cwd: string, policy: ProtectedPathPolicy) {
	return defineTool({
		name: "ls",
		label: "ls",
		description: "List an allowed directory without revealing protected paths.",
		parameters: Type.Object({
			path: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const requested = params.path ?? ".";
			if (!(await policy.allows(requested))) return blockedResult();
			const absolute = resolve(cwd, stripAtAlias(requested));
			const limit = Math.max(1, Math.min(params.limit ?? 500, 2_000));
			const scanBudget = Math.min(5_000, Math.max(100, limit * 4));
			const visible: string[] = [];
			let scanned = 0;
			let entryLimitReached = false;
			try {
				const directory = await opendir(absolute);
				for await (const entry of directory) {
					if (scanned >= scanBudget || visible.length >= limit) {
						entryLimitReached = true;
						break;
					}
					scanned++;
					if (await policy.allows(resolve(absolute, entry.name))) visible.push(entry.name);
				}
			} catch {
				return textResult("Unable to list the allowed path.", { entryLimitReached: false });
			}
			return textResult(visible.sort().join("\n"), { entryLimitReached, scanned });
		},
	});
}

function createFindTool(cwd: string, policy: ProtectedPathPolicy) {
	return defineTool({
		name: "find",
		label: "find",
		description: "Find files under an allowed path without revealing protected paths.",
		parameters: Type.Object({
			pattern: Type.String(),
			path: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const requested = params.path ?? ".";
			if (!(await policy.allows(requested))) return blockedResult();
			const root = resolve(cwd, stripAtAlias(requested));
			const limit = Math.max(1, Math.min(params.limit ?? 1_000, 2_000));
			const collected = await collectFiles(root, policy, limit * 4);
			const matches = collected.files
				.filter((file) => {
					const fromRoot = displayPath(root, file);
					return (
						matchesGlob(fromRoot, params.pattern) || matchesGlob(basename(file), params.pattern)
					);
				})
				.slice(0, limit)
				.map((file) => displayPath(cwd, file));
			return textResult(matches.join("\n"), {
				resultLimitReached: matches.length >= limit || collected.truncated,
				traversalTruncated: collected.truncated,
				visitedDirectories: collected.visitedDirectories,
				examinedEntries: collected.examinedEntries,
			});
		},
	});
}

interface RipgrepResult {
	stdout: string;
	code: number | string | null | undefined;
	timedOut: boolean;
}

function runRipgrep(
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<RipgrepResult> {
	return new Promise((resolveResult) => {
		const child = execFile(
			"rg",
			args,
			{ cwd, encoding: "utf8", maxBuffer: 2_000_000, timeout: GREP_TIMEOUT_MS },
			(error: ExecFileException | null, stdout: string) => {
				resolveResult({
					stdout,
					code: error?.code,
					timedOut: error?.killed === true,
				});
			},
		);
		if (signal?.aborted) child.kill();
		else signal?.addEventListener("abort", () => child.kill(), { once: true });
	});
}

function replaceAbsolutePaths(output: string, files: string[], cwd: string): string {
	const replacements = [...files]
		.sort((left, right) => right.length - left.length)
		.flatMap((file) => [
			[`${file}:`, `${displayPath(cwd, file)}:`] as const,
			[`${file}-`, `${displayPath(cwd, file)}-`] as const,
		]);
	return output
		.split("\n")
		.map((line) => {
			const replacement = replacements.find(([prefix]) => line.startsWith(prefix));
			return replacement === undefined
				? line
				: `${replacement[1]}${line.slice(replacement[0].length)}`;
		})
		.join("\n");
}

async function readBoundedUtf8(
	file: string,
	maxBytes: number,
): Promise<{ text: string; bytes: number } | undefined> {
	if (maxBytes <= 0) return undefined;
	let handle;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > maxBytes) return undefined;
		return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead };
	} catch {
		return undefined;
	} finally {
		if (handle !== undefined) await handle.close().catch(() => undefined);
	}
}

async function runLiteralGrepFallback(
	files: string[],
	cwd: string,
	pattern: string,
	ignoreCase: boolean,
	context: number,
	limit: number,
): Promise<{ output: string; limitReached: boolean; totalBytes: number }> {
	const output: string[] = [];
	let totalBytes = 0;
	const needle = ignoreCase ? pattern.toLocaleLowerCase("en-US") : pattern;
	for (const file of files) {
		const content = await readBoundedUtf8(
			file,
			Math.min(MAX_GREP_FILE_BYTES, MAX_GREP_TOTAL_BYTES - totalBytes),
		);
		if (content === undefined) continue;
		totalBytes += content.bytes;
		if (content.text.includes("\0")) continue;
		const lines = content.text.split("\n");
		const matches = lines.flatMap((line, index) => {
			const candidate = ignoreCase ? line.toLocaleLowerCase("en-US") : line;
			return candidate.includes(needle) ? [index] : [];
		});
		const included = new Set<number>();
		const matched = new Set(matches);
		for (const match of matches) {
			for (
				let index = Math.max(0, match - context);
				index <= Math.min(lines.length - 1, match + context);
				index++
			) {
				if (included.has(index)) continue;
				included.add(index);
				const separator = matched.has(index) ? ":" : "-";
				output.push(
					`${displayPath(cwd, file)}${separator}${String(index + 1)}${separator}${lines[index] ?? ""}`,
				);
				if (output.length >= limit) {
					return { output: output.join("\n"), limitReached: true, totalBytes };
				}
			}
		}
	}
	return { output: output.join("\n"), limitReached: false, totalBytes };
}

function createGrepTool(cwd: string, policy: ProtectedPathPolicy) {
	return defineTool({
		name: "grep",
		label: "grep",
		description: "Search bounded allowed text files without reading or revealing protected paths.",
		parameters: Type.Object({
			pattern: Type.String(),
			path: Type.Optional(Type.String()),
			glob: Type.Optional(Type.String()),
			ignoreCase: Type.Optional(Type.Boolean()),
			literal: Type.Optional(Type.Boolean()),
			context: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal) {
			const requested = params.path ?? ".";
			if (!(await policy.allows(requested))) return blockedResult();
			const root = resolve(cwd, stripAtAlias(requested));
			const limit = Math.max(1, Math.min(params.limit ?? 100, 2_000));
			let rootInfo;
			try {
				rootInfo = await stat(root);
			} catch {
				return textResult("Unable to search the allowed path.", { matchLimitReached: false });
			}
			const collected = rootInfo.isFile()
				? { files: [root], truncated: false, visitedDirectories: 0, examinedEntries: 1 }
				: await collectFiles(root, policy, MAX_GREP_FILES, 1_000, 10_000);
			const files: string[] = [];
			let totalBytes = 0;
			for (const file of collected.files) {
				if (!(await policy.allows(file))) continue;
				const shown = displayPath(cwd, file);
				if (
					params.glob &&
					!matchesGlob(shown, params.glob) &&
					!matchesGlob(basename(file), params.glob)
				) {
					continue;
				}
				try {
					const size = (await stat(file)).size;
					if (size > MAX_GREP_FILE_BYTES) continue;
					if (totalBytes + size > MAX_GREP_TOTAL_BYTES) break;
					totalBytes += size;
					files.push(file);
				} catch {
					continue;
				}
			}
			if (files.length === 0) {
				return textResult("", {
					matchLimitReached: false,
					traversalTruncated: collected.truncated,
					totalBytes,
				});
			}
			const context = Math.max(0, Math.min(params.context ?? 0, 20));
			const arguments_ = [
				"--line-number",
				"--no-heading",
				"--color",
				"never",
				"--with-filename",
				"--max-count",
				String(limit),
				...(params.literal ? ["--fixed-strings"] : []),
				...(params.ignoreCase ? ["--ignore-case"] : []),
				...(context > 0 ? ["--context", String(context)] : []),
				"--",
				params.pattern,
				...files,
			];
			const result = await runRipgrep(arguments_, cwd, signal);
			if (result.timedOut) {
				return textResult("Grep pattern timed out within the bounded search.", {
					patternTimedOut: true,
				});
			}
			if (result.code === "ENOENT") {
				if (!params.literal) {
					return textResult("Regex grep is unavailable in this Pi environment.", {
						unavailable: true,
					});
				}
				const fallback = await runLiteralGrepFallback(
					files,
					cwd,
					params.pattern,
					params.ignoreCase ?? false,
					context,
					limit,
				);
				return textResult(fallback.output, {
					matchLimitReached: fallback.limitReached,
					traversalTruncated: collected.truncated,
					totalBytes: fallback.totalBytes,
					literalFallback: true,
				});
			}
			if (typeof result.code === "string") {
				return textResult("Grep failed in this Pi environment.", { systemError: true });
			}
			if (typeof result.code === "number" && result.code > 1) {
				return textResult("Invalid or unsupported grep pattern.", { patternError: true });
			}
			const normalizedOutput = replaceAbsolutePaths(result.stdout, files, cwd);
			const lines = normalizedOutput.split("\n").filter(Boolean).slice(0, limit);
			return textResult(lines.join("\n"), {
				matchLimitReached: lines.length >= limit,
				traversalTruncated: collected.truncated,
				totalBytes,
			});
		},
	});
}

export function createProtectedAdvisorTools(cwd: string, config: AdvisorConfig): ToolDefinition[] {
	const policy = new ProtectedPathPolicy(cwd, config.security);
	const factories = {
		read: () => createReadTool(cwd, policy),
		grep: () => createGrepTool(cwd, policy),
		find: () => createFindTool(cwd, policy),
		ls: () => createLsTool(cwd, policy),
	} satisfies Record<ReadOnlyToolName, () => ToolDefinition>;
	return config.tools.map((name) => factories[name]());
}

export function isAdvisorReadOnlyTool(name: string): name is ReadOnlyToolName {
	return name === "read" || name === "grep" || name === "find" || name === "ls";
}

export type AdvisorToolContext = ExtensionContext;
