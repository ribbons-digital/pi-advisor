import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isRecordValue } from "../../src/value-guards.js";

interface PackResult {
	name: string;
	version: string;
	filename: string;
	files: { path: string }[];
}

interface SchemaProbe {
	type?: unknown;
	required?: unknown;
	properties?: unknown;
	additionalProperties?: unknown;
}

interface RpcRecord {
	id?: string;
	success?: boolean;
	data?: { commands?: unknown };
	entry?: unknown;
}

interface CommandProbe {
	name?: unknown;
	source?: unknown;
}

interface AdviseToolProbe {
	constrainedSampling?: unknown;
	parameters?: unknown;
}

interface PersistedEntryProbe {
	customType?: unknown;
}

const projectRoot = process.cwd();
const piExecutable = join(projectRoot, "node_modules", ".bin", "pi");
// SAFETY: repository package.json is controlled by this test checkout.
const projectManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
	devDependencies?: Record<string, string>;
};
const expectedPiVersion =
	process.env.PI_EXPECTED_VERSION ??
	projectManifest.devDependencies?.["@earendil-works/pi-coding-agent"];

function runPi(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) {
	return spawnSync(piExecutable, args, {
		cwd,
		env,
		encoding: "utf8",
		input,
	});
}

describe("packed Pi package", () => {
	it("uses the intended installed Pi version", () => {
		expect(expectedPiVersion).toMatch(/^0\.8[1-4]\.\d+$/);
		// SAFETY: the installed package.json is controlled by pnpm.
		const installedManifest = JSON.parse(
			readFileSync(
				join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
				"utf8",
			),
		) as { version?: string };
		expect(installedManifest.version).toBe(expectedPiVersion);
		expect(existsSync(piExecutable)).toBe(true);
	});

	it("installs through Pi and applies WATCHDOG activation only in approved run modes", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-advisor-packed-e2e-"));
		const unpacked = join(root, "unpacked");
		const installDir = join(root, "install");
		const agentDir = join(root, "agent");
		const archive = join(root, "pi-advisor-package.tgz");
		mkdirSync(unpacked, { recursive: true });
		mkdirSync(installDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
		};

		try {
			// SAFETY: pnpm pack --json defines the PackResult payload consumed here.
			const pack = JSON.parse(
				execFileSync("pnpm", ["pack", "--out", archive, "--json"], {
					cwd: projectRoot,
					encoding: "utf8",
				}),
			) as PackResult;
			const paths = pack.files.map((file) => file.path);
			expect(pack).toMatchObject({ name: "@ribbons-digital/pi-advisor", version: "0.4.0" });
			expect(paths).toContain("src/index.ts");
			expect(paths).toContain("docs/configuration.md");
			expect(paths).toContain("docs/assets/advisor-in-action.png");
			expect(paths).toContain("LICENSE");
			expect(paths).toContain("THIRD_PARTY_NOTICES.md");
			expect(paths.some((path) => path === "CONTEXT.md" || path.startsWith("docs/internal/"))).toBe(
				false,
			);

			expect(resolve(pack.filename)).toBe(resolve(archive));
			execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
			const packedPackageDir = join(unpacked, "package");
			// SAFETY: the packed package.json is produced from this repository manifest.
			const packedManifest = JSON.parse(
				execFileSync(
					"node",
					[
						"-e",
						"process.stdout.write(JSON.stringify(require(process.argv[1])))",
						join(packedPackageDir, "package.json"),
					],
					{
						encoding: "utf8",
					},
				),
			) as {
				private?: boolean;
				dependencies?: Record<string, string>;
				pi?: { extensions?: string[] };
				publishConfig?: object;
			};
			expect(packedManifest.private).not.toBe(true);
			expect(packedManifest.dependencies).toMatchObject({ typebox: "1.1.38", yaml: "^2.9.0" });
			expect(packedManifest.pi?.extensions).toEqual(["./src/index.ts"]);
			expect(packedManifest.publishConfig).toMatchObject({ access: "public", provenance: true });

			writeFileSync(
				join(installDir, "package.json"),
				`${JSON.stringify(
					{
						private: true,
						packageManager: "pnpm@10.0.0",
						dependencies: {
							"@earendil-works/pi-agent-core": `file:${join(projectRoot, "node_modules", "@earendil-works", "pi-agent-core")}`,
							"@earendil-works/pi-ai": `file:${join(projectRoot, "node_modules", "@earendil-works", "pi-ai")}`,
							"@earendil-works/pi-coding-agent": `file:${join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent")}`,
							"@earendil-works/pi-tui": `file:${join(projectRoot, "node_modules", "@earendil-works", "pi-tui")}`,
							"@ribbons-digital/pi-advisor": `file:${archive}`,
						},
					},
					null,
					2,
				)}\n`,
			);
			execFileSync("pnpm", ["install", "--ignore-workspace", "--config.auto-install-peers=false"], {
				cwd: installDir,
				encoding: "utf8",
			});
			const installedPackageDir = join(
				installDir,
				"node_modules",
				"@ribbons-digital",
				"pi-advisor",
			);
			const installedRequire = createRequire(
				join(realpathSync(installedPackageDir), "package.json"),
			);
			for (const dependency of ["typebox", "yaml"]) {
				const dependencyEntry = installedRequire.resolve(dependency);
				expect(existsSync(dependencyEntry)).toBe(true);
				expect(dependencyEntry).not.toContain(projectRoot);
			}

			const compatibilityUrl = pathToFileURL(
				join(realpathSync(installedPackageDir), "src", "compatibility", "constrained-sampling.ts"),
			).href;
			const adviceUrl = pathToFileURL(
				join(realpathSync(installedPackageDir), "src", "advice.ts"),
			).href;
			const configUrl = pathToFileURL(
				join(realpathSync(installedPackageDir), "src", "config.ts"),
			).href;
			// SAFETY: the probe script emits the exact packaged compatibility payload.
			const packagedProbe = JSON.parse(
				execFileSync(
					join(projectRoot, "node_modules", ".bin", "tsx"),
					[
						"--eval",
						`void (async () => {
const compatibility = await import(${JSON.stringify(compatibilityUrl)});
const advice = await import(${JSON.stringify(adviceUrl)});
const { DEFAULT_ADVISOR_CONFIG } = await import(${JSON.stringify(configUrl)});
const model = { api: "anthropic-messages", compat: { supportsStrictTools: true } };
const mode = await compatibility.resolveAdviseSchemaMode(model);
const tool = mode === "strict"
  ? advice.createStrictAdviseTool(DEFAULT_ADVISOR_CONFIG, { validCalls: 0, suppressedCalls: 0, memoryPolicySuppressedCalls: 0, memoryLimitSuppressedCalls: 0 })
  : advice.createAdviseTool(DEFAULT_ADVISOR_CONFIG, { validCalls: 0, suppressedCalls: 0, memoryPolicySuppressedCalls: 0, memoryLimitSuppressedCalls: 0 });
process.stdout.write(JSON.stringify({ mode, constrainedSampling: tool.constrainedSampling, parameters: tool.parameters }));
})();`,
					],
					{ cwd: installDir, encoding: "utf8" },
				),
			) as {
				mode: string;
				constrainedSampling?: unknown;
				parameters: SchemaProbe;
			};
			if (expectedPiVersion === "0.81.1") {
				expect(packagedProbe.mode).toBe("portable");
				expect(packagedProbe).not.toHaveProperty("constrainedSampling");
				expect(packagedProbe.parameters).not.toHaveProperty("additionalProperties");
				expect(packagedProbe.parameters).toMatchObject({
					type: "object",
					required: ["note"],
					properties: {
						note: { type: "string", minLength: 1 },
						intent: { type: "string", enum: ["review", "memory-suggestion"] },
					},
				});
			} else {
				expect(packagedProbe.mode).toBe("strict");
				expect(packagedProbe.constrainedSampling).toEqual({
					type: "json_schema",
					strict: "prefer",
				});
				expect(packagedProbe.parameters).toMatchObject({
					required: ["note", "intent", "severity", "findingKey", "memory"],
				});
			}

			const install = runPi(["install", installedPackageDir, "--approve"], root, env);
			expect(install.status, install.stderr).toBe(0);

			const rpc = runPi(
				[
					"--mode",
					"rpc",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-tools",
				],
				root,
				env,
				`${JSON.stringify({ id: "state", type: "get_state" })}\n${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
			);
			expect(rpc.status, rpc.stderr).toBe(0);
			// SAFETY: Pi RPC emits one protocol record per parsed line.
			const records = rpc.stdout
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as unknown) as RpcRecord[];
			const state = records.find((record) => record.id === "state");
			const commands = records.find((record) => record.id === "commands");
			expect(state?.success).toBe(true);
			expect(state?.data).toMatchObject({
				isStreaming: false,
				messageCount: 0,
				pendingMessageCount: 0,
			});
			expect(commands?.success).toBe(true);
			const commandList = commands?.data?.commands;
			expect(Array.isArray(commandList)).toBe(true);
			const commandRecords: unknown[] = Array.isArray(commandList) ? commandList : [];
			expect(
				commandRecords.some((command) => {
					if (!isRecordValue<CommandProbe>(command)) return false;
					const record = command;
					return record.name === "advisor" && record.source === "extension";
				}),
			).toBe(true);

			const userYaml = join(agentDir, "WATCHDOG.yml");
			const scriptedExtension = join(root, "packed-scripted-provider.ts");
			const requestMarker = join(root, "packed-scripted-requests.txt");
			const adviseToolMarker = join(root, "packed-advise-tool.json");
			const piAiEntry = pathToFileURL(
				realpathSync(
					join(projectRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
				),
			).href;
			writeFileSync(
				scriptedExtension,
				`import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from ${JSON.stringify(piAiEntry)};

let advisorCalls = 0;
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function emit(model, content, stopReason) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    for (let index = 0; index < content.length; index++) {
      const part = content[index];
      if (part.type === "text") {
        stream.push({ type: "text_start", contentIndex: index, partial: message });
        stream.push({ type: "text_delta", contentIndex: index, delta: part.text, partial: message });
        stream.push({ type: "text_end", contentIndex: index, content: part.text, partial: message });
      } else {
        stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(part.arguments), partial: message });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: part, partial: message });
      }
    }
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}

export default function(pi) {
  pi.registerProvider("packed-scripted", {
    name: "Packed scripted provider",
    baseUrl: "https://packed-scripted.invalid",
    apiKey: "packed-scripted-key",
    api: "packed-scripted-api",
    streamSimple(model, context) {
      appendFileSync(${JSON.stringify(requestMarker)}, model.id + "\\n");
      if (model.id === "advisor") {
        const advise = context.tools?.find((tool) => tool.name === "advise");
        if (advise) appendFileSync(${JSON.stringify(adviseToolMarker)}, JSON.stringify(advise));
        advisorCalls++;
        return advisorCalls === 1
          ? emit(model, [{
              type: "toolCall",
              id: "packed-advice",
              name: "advise",
              arguments: {
                note: "Packed nested review completed through the scripted provider.",
                severity: "concern",
                intent: "review",
                findingKey: "packed-e2e-review",
              },
            }], "toolUse")
          : emit(model, [], "stop");
      }
      return emit(model, [{ type: "text", text: "Packed primary response." }], "stop");
    },
    models: [
      {
        id: "primary",
        name: "Packed primary",
        api: "packed-scripted-api",
        baseUrl: "https://packed-scripted.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 2000,
      },
      {
        id: "advisor",
        name: "Packed advisor",
        api: "packed-scripted-api",
        baseUrl: "https://packed-scripted.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 2000,
      },
      {
        id: "advisor-portable",
        name: "Packed portable advisor",
        api: "packed-scripted-api",
        baseUrl: "https://packed-scripted.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 2000,
      },
    ],
  });
}
`,
			);
			writeFileSync(
				userYaml,
				"version: 1\ndefaultEnabled: true\nmodel: packed-scripted/advisor\neffort: off\ntools: []\n",
			);
			const activeReview = runPi(
				[
					"--mode",
					"rpc",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-tools",
					"--extension",
					scriptedExtension,
					"--model",
					"packed-scripted/primary",
					"--thinking",
					"off",
				],
				root,
				env,
				`${JSON.stringify({ id: "review", type: "prompt", message: "Run one review." })}\n${JSON.stringify({ id: "schema-status", type: "prompt", message: "/advisor status full" })}\n`,
			);
			expect(activeReview.status, activeReview.stderr).toBe(0);
			expect(activeReview.stdout).toContain('"statusText":"Advisor active (Packed advisor)"');
			expect(activeReview.stdout).toContain("Advise schema: portable");
			expect(activeReview.stdout).toContain('"kind":"review-outcome"');
			expect(activeReview.stdout).toContain('"outcome":"accepted"');
			expect(activeReview.stdout).toContain(
				"Packed nested review completed through the scripted provider.",
			);
			expect(readFileSync(requestMarker, "utf8")).toContain("advisor");
			// SAFETY: the scripted provider writes the captured advise tool shape.
			const adviseTool = JSON.parse(readFileSync(adviseToolMarker, "utf8")) as AdviseToolProbe;
			// SAFETY: the captured advise tool always exposes its schema parameters.
			const adviseParameters = adviseTool.parameters as SchemaProbe;
			expect(adviseTool).not.toHaveProperty("constrainedSampling");
			expect(adviseParameters).toMatchObject({
				type: "object",
				required: ["note"],
			});
			expect(adviseParameters.properties).toMatchObject({
				note: { type: "string", minLength: 1 },
				intent: { type: "string", enum: ["review", "memory-suggestion"] },
			});
			// SAFETY: Pi RPC emits one protocol record per parsed line.
			const persistedStates = activeReview.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as RpcRecord)
				.filter((record) => {
					const entry = record.entry;
					return (
						isRecordValue<PersistedEntryProbe>(entry) &&
						entry.customType === "pi-advisor-runtime-state"
					);
				});
			expect(persistedStates.length).toBeGreaterThan(0);
			for (const state of persistedStates) {
				const serialized = JSON.stringify(state);
				expect(serialized).not.toMatch(/adviseSchemaMode|schemaMode|schemaVariant/iu);
			}

			if (expectedPiVersion !== "0.81.1") {
				writeFileSync(
					userYaml,
					"version: 1\ndefaultEnabled: true\nmodel: packed-scripted/advisor-portable\neffort: off\ntools: []\n",
				);
				const portableModel = runPi(
					[
						"--mode",
						"rpc",
						"--no-session",
						"--no-context-files",
						"--no-skills",
						"--no-prompt-templates",
						"--no-themes",
						"--no-tools",
						"--extension",
						scriptedExtension,
						"--model",
						"packed-scripted/primary",
					],
					root,
					env,
					`${JSON.stringify({ id: "portable-status", type: "prompt", message: "/advisor status full" })}\n`,
				);
				expect(portableModel.status, portableModel.stderr).toBe(0);
				expect(portableModel.stdout).toContain("Advise schema: portable");
			}

			const defaultRecordingConfig =
				"version: 1\ndefaultEnabled: true\nmodel: missing/provider\neffort: low\n";
			writeFileSync(userYaml, defaultRecordingConfig);
			const persistedRpc = runPi(
				[
					"--mode",
					"rpc",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-tools",
				],
				root,
				env,
				`${JSON.stringify({ id: "persisted-status", type: "prompt", message: "/advisor status full" })}\n`,
			);
			expect(persistedRpc.status, persistedRpc.stderr).toBe(0);
			expect(persistedRpc.stdout).toContain("Effort: low");
			expect(persistedRpc.stdout).toContain("Local redacted activity record: enabled");
			expect(readFileSync(userYaml, "utf8")).toBe(defaultRecordingConfig);
			expect(persistedRpc.stdout).toContain(
				"Configured Advisor model missing/provider is unavailable. No fallback was selected.",
			);

			const persistedJson = runPi(
				[
					"--mode",
					"json",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-tools",
					"-p",
					"/advisor status",
				],
				root,
				env,
			);
			expect(persistedJson.status, persistedJson.stderr).toBe(0);
			expect(persistedJson.stdout).not.toContain("No fallback was selected");

			writeFileSync(
				userYaml,
				"version: 1\ndefaultEnabled: true\nmodel: missing/provider\npersistence:\n  transcript: false\n",
			);
			const optedOut = runPi(
				[
					"--mode",
					"rpc",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-tools",
				],
				root,
				env,
				`${JSON.stringify({ id: "opted-out-status", type: "prompt", message: "/advisor status full" })}\n`,
			);
			expect(optedOut.status, optedOut.stderr).toBe(0);
			expect(optedOut.stdout).toContain("Local redacted activity record: disabled");

			writeFileSync(userYaml, "version: [malformed\n");
			const malformed = runPi(
				[
					"--mode",
					"rpc",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-tools",
				],
				root,
				env,
				`${JSON.stringify({ id: "malformed-status", type: "prompt", message: "/advisor status full" })}\n`,
			);
			expect(malformed.status, malformed.stderr).toBe(0);
			expect(malformed.stdout).toContain("contains malformed YAML and was ignored");
			expect(malformed.stdout).toContain("Local redacted activity record: disabled");
			expect(malformed.stdout).not.toContain("No fallback was selected");

			rmSync(userYaml);
			const explicit = runPi(
				[
					"--mode",
					"rpc",
					"--advisor",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-tools",
				],
				root,
				env,
				`${JSON.stringify({ id: "explicit-state", type: "get_state" })}\n`,
			);
			expect(explicit.status, explicit.stderr).toBe(0);
			expect(explicit.stdout).toContain('"id":"explicit-state"');
			expect(explicit.stdout).toContain('"messageCount":0');

			// The package is unpublished and this E2E is intentionally offline, so the local
			// package source exercises Pi's update and removal lifecycle. The release-surface
			// contract separately pins the documented unversioned npm source and commands.
			const update = runPi(["update", "--extensions"], root, env);
			expect(update.status, update.stderr).toBe(0);

			const remove = runPi(["remove", installedPackageDir], root, env);
			expect(remove.status, remove.stderr).toBe(0);

			const removedRpc = runPi(
				[
					"--mode",
					"rpc",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-tools",
				],
				root,
				env,
				`${JSON.stringify({ id: "removed-commands", type: "get_commands" })}\n`,
			);
			expect(removedRpc.status, removedRpc.stderr).toBe(0);
			// SAFETY: Pi RPC emits one protocol record per parsed line.
			const removedRecords = removedRpc.stdout
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { id?: string; data?: { commands?: unknown[] } });
			const removedCommands = removedRecords.find((record) => record.id === "removed-commands")
				?.data?.commands;
			expect(Array.isArray(removedCommands)).toBe(true);
			expect(
				removedCommands?.some(
					(command) => isRecordValue<CommandProbe>(command) && command.name === "advisor",
				),
			).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
