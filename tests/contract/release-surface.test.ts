import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowDefinition {
	on: { workflow_dispatch?: { inputs: { tag: { description: string } } } };
	jobs: Record<
		string,
		{
			name?: string;
			environment?: { name: string };
			strategy?: { matrix: { node: string[] } };
			steps: { run?: string; uses?: string; with?: { "node-version"?: string } }[];
		}
	>;
}

// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
	name: string;
	version: string;
	private?: boolean;
	keywords?: string[];
	files?: string[];
	publishConfig?: { access?: string; provenance?: boolean; tag?: string };
	pi?: { extensions?: string[]; image?: string };
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
	bundledDependencies?: string[] | boolean;
	bundleDependencies?: string[] | boolean;
	engines?: { node?: string };
	scripts?: Record<string, string>;
};
const readme = readFileSync("README.md", "utf8");
const configuration = readFileSync("docs/configuration.md", "utf8");
const compatibilityDocs = ["README.md", "docs/configuration.md", "docs/security.md"].map(
	(path) => ({ path, content: readFileSync(path, "utf8") }),
);
const publicDocs = [
	"README.md",
	"THIRD_PARTY_NOTICES.md",
	"docs/configuration.md",
	"docs/security.md",
].map((path) => ({ path, content: readFileSync(path, "utf8") }));

describe("public release surface", () => {
	it("declares discoverable publishable 0.4.1 metadata", () => {
		expect(manifest).toMatchObject({
			name: "@ribbons-digital/pi-advisor",
			version: "0.4.1",
			publishConfig: { access: "public", provenance: true },
			pi: {
				extensions: ["./src/index.ts"],
				image:
					"https://raw.githubusercontent.com/ribbons-digital/pi-advisor/66cd0253c6ee84471a9870dfce806fc767f26bd3/docs/assets/advisor-in-action.png",
			},
		});
		expect(manifest.private).not.toBe(true);
		expect(manifest.publishConfig?.tag).toBeUndefined();
		expect(manifest.keywords).toEqual(expect.arrayContaining(["pi-package", "pi-extension"]));
		expect(manifest.files).toEqual([
			"src/",
			"README.md",
			"LICENSE",
			"THIRD_PARTY_NOTICES.md",
			"docs/assets/advisor-in-action.png",
			"docs/configuration.md",
			"docs/security.md",
		]);
	});

	it("uses wildcard host peers and pinned Pi 1.0.0 development dependencies", () => {
		for (const packageName of [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
			"typebox",
		]) {
			expect(manifest.peerDependencies?.[packageName], packageName).toBe("*");
			expect(manifest.dependencies, packageName).not.toHaveProperty(packageName);
			expect(manifest.devDependencies?.[packageName], packageName).toBe(
				packageName === "typebox" ? "1.3.27" : "1.0.0",
			);
		}
		expect(manifest.dependencies).toEqual({ yaml: "^2.9.0" });
		expect(manifest.bundledDependencies).toBeUndefined();
		expect(manifest.bundleDependencies).toBeUndefined();
	});

	it("rejects invalid host dependency declarations and bundled host modules", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-advisor-pack-contract-"));
		const pack = {
			name: manifest.name,
			version: manifest.version,
			filename: "pi-advisor-package.tgz",
			files: [
				"LICENSE",
				"README.md",
				"THIRD_PARTY_NOTICES.md",
				"package.json",
				"src/index.ts",
				"docs/configuration.md",
				"docs/security.md",
			].map((path) => ({ path })),
		};
		const cases = [
			{
				manifest: {
					...manifest,
					peerDependencies: { ...manifest.peerDependencies, typebox: "^1.3.27" },
				},
				pack,
				error: "typebox must be a wildcard peer dependency",
			},
			{
				manifest: { ...manifest, dependencies: { ...manifest.dependencies, typebox: "1.3.27" } },
				pack,
				error: "typebox must not be a runtime dependency",
			},
			{
				manifest: { ...manifest, bundledDependencies: ["typebox"] },
				pack,
				error: "typebox must not be bundled",
			},
			{
				manifest: { ...manifest, bundleDependencies: ["@earendil-works/pi-ai"] },
				pack,
				error: "pi-ai must not be bundled",
			},
			{
				manifest,
				pack: { ...pack, files: [...pack.files, { path: "node_modules/typebox/index.js" }] },
				error: "Forbidden packed files: node_modules/typebox/index.js",
			},
		];
		try {
			for (const fixture of cases) {
				writeFileSync(join(root, "package.json"), JSON.stringify(fixture.manifest));
				writeFileSync(join(root, "pack.json"), JSON.stringify(fixture.pack));
				const result = spawnSync(
					join(process.cwd(), "node_modules", ".bin", "tsx"),
					[join(process.cwd(), "scripts", "validate-pack.ts"), "pack.json"],
					{ cwd: root, encoding: "utf8", timeout: 10_000 },
				);
				expect(result.error).toBeUndefined();
				expect(result.status, fixture.error).toBe(1);
				expect(result.stderr).toContain(fixture.error);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("separates the unreleased Pi 1.0 target from pinned published releases", () => {
		expect(manifest.engines?.node).toBe(">=22.19.0");
		for (const document of compatibilityDocs) {
			expect(document.content, document.path).toContain(">=22.19.0");
			expect(document.content, document.path).toContain("This unreleased build targets Pi 1.0.0");
			expect(document.content, document.path).toContain("Planned release: v0.5.0 (unreleased).");
			expect(document.content, document.path).toContain(
				"Wildcard peers are a host-module loading contract, not a compatibility range.",
			);
			expect(document.content, document.path).toContain("Published Pi Advisor 0.4.1");
			expect(document.content, document.path).toContain("npm:@ribbons-digital/pi-advisor@0.4.1");
			expect(document.content, document.path).toContain(
				"Live model-service compatibility remains unverified.",
			);
		}
		expect(readme).toContain("Supported Pi release for this build: 1.0.0");
		expect(readme).not.toContain("Declared compatibility range: >=0.81.1 <0.85.0");
		expect(readme).toContain(
			"The npm commands below install the published release, not this unreleased Pi 1.0 build.",
		);
		expect(readme).toContain("Pi Advisor 0.1.3 is the legacy release for Pi 0.80.7");
		expect(readme).toContain(
			"unverifiable provider parity leave Advisor inactive without fallback",
		);
		expect(readme).toContain("pi install npm:@ribbons-digital/pi-advisor");
		expect(readme).toContain("pi update --extensions");
		expect(readme).toContain("pi update npm:@ribbons-digital/pi-advisor");
		expect(readme).toContain("pi remove npm:@ribbons-digital/pi-advisor");
		expect(readme).toContain("version-pinned");
		expect(readme).toContain("intentionally skipped by package updates");
	});

	it("documents model-aware independent Advisor reasoning configuration", () => {
		expect(configuration).toContain(
			"Advisor reasoning choices are derived from the selected model's supported levels",
		);
		expect(configuration).toContain("unsupported levels are omitted");
		expect(configuration).toContain("without reasoning support offers only `off`");
		expect(configuration).toContain("warns and requires a new supported selection");
		expect(configuration).toContain("current Executor reasoning level as supplementary context");
		expect(configuration).toContain("Advisor selection remains independent");
		expect(configuration).toContain("is not automatically coupled");
		expect(configuration).not.toContain("Pi 0.81 compatibility path");
	});

	it("gates CI and manual publication on the verified Pi and Node baselines", () => {
		// SAFETY: these workflow files are controlled by this repository.
		const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as WorkflowDefinition;
		// SAFETY: this release workflow is controlled by this repository.
		const release = parse(
			readFileSync(".github/workflows/release.yml", "utf8"),
		) as WorkflowDefinition;
		expect(Object.keys(ci.jobs)).toEqual(["verify-pi-1-0-0"]);
		expect(
			Object.keys(manifest.scripts ?? {}).filter((name) => name.startsWith("compat:")),
		).toEqual([]);
		expect(existsSync("scripts/verify-pi-compat.sh")).toBe(false);
		const job = ci.jobs["verify-pi-1-0-0"];
		expect(job?.name).toBe("Verify Pi 1.0.0 on Node ${{ matrix.node }}");
		expect(job?.strategy?.matrix.node).toEqual(["22.19.0", "22.22.3"]);
		expect(
			job?.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with?.[
				"node-version"
			],
		).toBe("${{ matrix.node }}");
		const commands = job?.steps.map((step) => step.run ?? "").join("\n");
		for (const command of [
			"pnpm install --frozen-lockfile",
			"pnpm verify",
			"PI_EXPECTED_VERSION=1.0.0 pnpm test:e2e",
			"pnpm pack:validate",
			'test "$actual_version" = "1.0.0"',
		])
			expect(commands).toContain(command);
		expect(commands).not.toContain("publish");
		expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
		expect(release.jobs.publish?.environment?.name).toBe("npm-release");
		expect(release.on.workflow_dispatch?.inputs.tag.description).toContain("approved");
		expect(
			release.jobs.publish?.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
				?.with?.["node-version"],
		).toBe("22.22.3");
		expect(release.jobs.publish?.steps.map((step) => step.run ?? "").join("\n")).toContain(
			"PI_EXPECTED_VERSION=1.0.0 pnpm test:e2e",
		);
	});

	it("documents recovered-instruction checks and the separate release approval gate", () => {
		expect(configuration).toContain("changed or missing fingerprint");
		expect(configuration).toContain("successful nested Memory calls");
		const releasing = readFileSync("docs/releasing.md", "utf8");
		expect(releasing).toContain("A clean review does not authorize a merge or publication.");
		expect(releasing).toContain("Do not republish 0.4.1");
		expect(releasing).toContain("Planned release: v0.5.0 (unreleased).");
		expect(releasing).toContain(
			"The planned release tag is `v0.5.0`; do not create it before approval.",
		);
		expect(releasing).toContain("Live model-service compatibility remains unverified.");
		expect(releasing).toContain("Verify Pi 1.0.0 on Node 22.19.0");
		expect(releasing).toContain("Verify Pi 1.0.0 on Node 22.22.3");
		expect(releasing).toContain("does not authorize changing repository protections");
		expect(releasing).toContain("workflow_dispatch");
		expect(releasing).toContain("Pi 1.0.0");
	});

	it("keeps internal development history out of public documentation", () => {
		for (const document of publicDocs) {
			expect(document.content, document.path).not.toMatch(/\bSlice\s+\d/i);
			expect(document.content, document.path).not.toMatch(/^## Development$/m);
			expect(document.content, document.path).not.toContain("docs/internal");
		}
	});
});
