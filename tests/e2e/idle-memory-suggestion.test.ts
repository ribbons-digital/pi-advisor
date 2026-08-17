import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_ADVISOR_CONFIG,
	type AdvisorConfig,
	type AdvisorRuntime,
	type PiAdvisorExtensionOptions,
} from "../../src/index.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import { createAdvisorProvider, createPrimaryProvider } from "../fixtures/scripted-provider.js";

interface PackedAdvisorModule {
	createPiAdvisorExtension(options?: PiAdvisorExtensionOptions): ExtensionFactory;
}

function packedConfig(advisorModel: string): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.defaultEnabled = true;
	config.model = advisorModel;
	config.memorySuggestions.minTurnsBetweenSuggestions = 0;
	config.memorySuggestions.minIntervalMs = 0;
	return config;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

function createBarrier() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const proposed = "Use sfw-prefixed pnpm commands for package installation in this project.";

function packedMemorySuggestion() {
	return {
		content: [
			{
				type: "toolCall" as const,
				id: "packed-memory-suggestion",
				name: "advise",
				arguments: {
					note: "This verified project constraint will matter in future sessions.",
					intent: "memory-suggestion",
					memory: {
						text: proposed,
						category: "project",
						basis: "project-constraint",
					},
				},
			},
		],
		stopReason: "toolUse" as const,
	};
}

describe.sequential("packed idle Memory suggestion delivery", () => {
	it("loads the packed extension and triggers only the capability-backed pending flow", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-advisor-packed-memory-e2e-"));
		const archive = join(root, "pi-advisor-package.tgz");
		const unpacked = join(root, "unpacked");
		mkdirSync(unpacked, { recursive: true });
		try {
			execFileSync("pnpm", ["pack", "--out", archive, "--json"], {
				cwd: process.cwd(),
				encoding: "utf8",
			});
			execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
			const packedNodeModules = join(unpacked, "package", "node_modules", "@earendil-works");
			mkdirSync(packedNodeModules, { recursive: true });
			for (const peer of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) {
				symlinkSync(
					realpathSync(join(process.cwd(), "node_modules", "@earendil-works", peer)),
					join(packedNodeModules, peer),
					"dir",
				);
			}
			for (const dependency of ["typebox", "yaml"]) {
				symlinkSync(
					realpathSync(join(process.cwd(), "node_modules", dependency)),
					join(unpacked, "package", "node_modules", dependency),
					"dir",
				);
			}
			const packed = (await import(
				pathToFileURL(join(unpacked, "package", "src", "index.ts")).href
			)) as PackedAdvisorModule;

			const adviseStarted = createBarrier();
			const afterAdvise = createBarrier();
			const executorBarrier = createBarrier();
			const submit = vi.fn();
			const inspectTool = defineTool({
				name: "inspect",
				label: "inspect",
				description: "Produce intermediate Executor evidence.",
				parameters: Type.Object({}),
				execute: () =>
					Promise.resolve({
						content: [{ type: "text" as const, text: "intermediate cleanup completed" }],
						details: {},
					}),
			});
			const memoryTool = defineTool({
				name: "memory_suggest",
				label: "memory_suggest",
				description: "Queue a pending memory suggestion.",
				parameters: Type.Object({
					text: Type.String(),
					category: StringEnum(["preference", "project"] as const),
					status: StringEnum(["pending"] as const),
				}),
				execute: (_id, params) => {
					submit(params);
					return Promise.resolve({
						content: [{ type: "text" as const, text: "Queued for review." }],
						details: {},
					});
				},
			});
			const primary = createPrimaryProvider([
				{
					content: [
						{ type: "toolCall", id: "packed-intermediate-inspect", name: "inspect", arguments: {} },
					],
					stopReason: "toolUse",
				},
				{
					waitFor: executorBarrier.promise,
					content: [{ type: "text", text: "terminal answer after newer Executor activity" }],
				},
				{
					content: [
						{
							type: "toolCall",
							id: "packed-submit-memory",
							name: "memory_suggest",
							arguments: { text: proposed, category: "project", status: "pending" },
						},
					],
					stopReason: "toolUse",
				},
				{ content: [{ type: "text", text: "Queued the pending memory." }] },
			]);
			const advisor = createAdvisorProvider([
				packedMemorySuggestion(),
				{ content: [] },
				{ content: [] },
				{ content: [] },
			]);
			let runtime: AdvisorRuntime | undefined;
			const harness = await createSessionHarness({
				provider: primary,
				advisorProvider: advisor,
				extensions: [
					{
						name: "packed-pi-advisor",
						factory: packed.createPiAdvisorExtension({
							config: packedConfig(`${advisor.model.provider}/${advisor.model.id}`),
							hooks: {
								onRuntime: (value) => (runtime = value),
								onAdviseExecutionStart: async () => {
									adviseStarted.release();
									await afterAdvise.promise;
								},
							},
						}),
					},
				],
				customTools: [inspectTool, memoryTool],
				tools: ["inspect", "memory_suggest"],
				mode: "rpc",
			});
			try {
				const executorTurn = harness.session.prompt("produce a late durable suggestion");
				await adviseStarted.promise;
				await waitFor(() => primary.activeRequests === 1 && primary.requests.length === 2);
				executorBarrier.release();
				await executorTurn;
				afterAdvise.release();
				await expect.poll(() => primary.requests.length, { timeout: 5_000, interval: 10 }).toBe(4);
				await waitFor(() => submit.mock.calls.length === 1);
				await waitFor(() => advisor.requests.length === 4);
				expect(submit).toHaveBeenCalledTimes(1);
				expect(submit).toHaveBeenCalledWith({
					text: proposed,
					category: "project",
					status: "pending",
				});
				expect(JSON.stringify(primary.requests[2]?.context)).toContain('delivery=\\"active\\"');
				expect(JSON.stringify(primary.requests[2]?.context)).toContain('stale=\\"false\\"');
				const delivered = harness.sessionManager
					.getEntries()
					.find(
						(entry) => entry.type === "custom_message" && entry.customType === "pi-advisor-note",
					);
				expect(delivered?.type === "custom_message" ? delivered.details : undefined).toMatchObject({
					delivery: "active",
					intent: "memory-suggestion",
				});
				expect(
					delivered?.type === "custom_message" ? delivered.details : undefined,
				).not.toHaveProperty("stale");
				expect(advisor.requests).toHaveLength(4);
				expect(runtime?.getStatus()).toMatchObject({
					memorySuggestionsDelivered: 1,
					deferredNotesPending: 0,
				});
			} finally {
				executorBarrier.release();
				afterAdvise.release();
				await harness.dispose();
			}

			const noCapabilityPrimary = createPrimaryProvider([
				{ content: [{ type: "text", text: "ordinary terminal answer" }] },
			]);
			const noCapabilityAdvisor = createAdvisorProvider([packedMemorySuggestion()]);
			let noCapabilityRuntime: AdvisorRuntime | undefined;
			const noCapabilityHarness = await createSessionHarness({
				provider: noCapabilityPrimary,
				advisorProvider: noCapabilityAdvisor,
				extensions: [
					{
						name: "packed-pi-advisor-no-memory",
						factory: packed.createPiAdvisorExtension({
							config: packedConfig(
								`${noCapabilityAdvisor.model.provider}/${noCapabilityAdvisor.model.id}`,
							),
							hooks: { onRuntime: (value) => (noCapabilityRuntime = value) },
						}),
					},
				],
				tools: [],
				mode: "rpc",
			});
			try {
				await noCapabilityHarness.session.prompt("review without Memory capability");
				await waitFor(() => noCapabilityRuntime?.getStatus().reviewsCompleted === 1);
				expect(noCapabilityPrimary.requests).toHaveLength(1);
				expect(noCapabilityRuntime?.getStatus()).toMatchObject({
					memorySuggestionCapability: { state: "absent" },
					memorySuggestionsDelivered: 0,
					warnings: 0,
				});
			} finally {
				await noCapabilityHarness.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
