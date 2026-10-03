import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const hostPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

describe("packed host dependency contract", () => {
	it("loads through Pi without private host modules or dependency warnings", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-advisor-host-peers-"));
		const agentDir = join(root, "agent");
		const archive = join(root, "pi-advisor-package.tgz");
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				npmCommand: [
					join(projectRoot, "node_modules", ".bin", "npm"),
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
				],
				enableInstallTelemetry: false,
			}),
		);

		try {
			execFileSync("pnpm", ["pack", "--out", archive], { cwd: projectRoot });
			const install = spawnSync(
				join(projectRoot, "node_modules", ".bin", "pi"),
				["install", `npm:@ribbons-digital/pi-advisor@file:${archive}`],
				{
					cwd: root,
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
					encoding: "utf8",
					timeout: 60_000,
				},
			);
			expect(install.error).toBeUndefined();
			expect(install.status, install.stderr + install.stdout).toBe(0);

			const installedPackage = join(
				agentDir,
				"npm",
				"node_modules",
				"@ribbons-digital",
				"pi-advisor",
			);
			const manifestPath = join(installedPackage, "package.json");
			const installedRequire = createRequire(manifestPath);
			for (const name of hostPackages) {
				expect(() => installedRequire.resolve(name), name).toThrow();
			}
			expect(existsSync(installedRequire.resolve("yaml"))).toBe(true);

			const loader = new DefaultResourceLoader({
				cwd: root,
				agentDir,
				settingsManager: SettingsManager.create(root, agentDir),
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			expect(loaded.errors).toEqual([]);
			expect(loaded.warnings ?? []).toEqual([]);
			expect(loaded.extensions).toHaveLength(1);
			expect(loaded.extensions[0]?.commands.has("advisor")).toBe(true);

			// Restore the original manifest defect in this disposable install to prove detection.
			// SAFETY: Pi installed this repository's packed manifest with its declared dependencies.
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
				dependencies: Record<string, string>;
			};
			writeFileSync(
				manifestPath,
				JSON.stringify({
					...manifest,
					dependencies: { ...manifest.dependencies, typebox: "1.3.27" },
				}),
			);
			await loader.reload();
			expect(
				loader
					.getExtensions()
					.warnings?.some((entry) => entry.warning.includes("not dependencies: typebox")),
			).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);
});
