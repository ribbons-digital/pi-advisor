import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
	engines?: { node?: string };
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

	it("documents official compatibility, install, update, and uninstall guidance", () => {
		expect(manifest.engines?.node).toBe(">=22.19.0");
		for (const packageName of [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
		]) {
			expect(manifest.peerDependencies?.[packageName], packageName).toBe(">=0.81.1 <0.85.0");
		}
		for (const document of compatibilityDocs) {
			expect(document.content, document.path).toContain(">=22.19.0");
			expect(document.content, document.path).toContain(">=0.81.1 <0.85.0");
			expect(document.content, document.path).toContain(
				"Pi 0.82.0 is the primary tested Pi release",
			);
			expect(document.content, document.path).toContain(
				"compatibility coverage retained for Pi 0.81.1, Pi 0.83.0, and Pi 0.84.1",
			);
		}
		expect(readme).toContain("Pi Advisor 0.4.1 requires Pi");
		expect(readme).toContain("Declared compatibility range: >=0.81.1 <0.85.0");
		expect(readme).toContain("Primary tested Pi release: 0.82.0");
		expect(readme).toContain("Compatibility-tested Pi releases: 0.81.1, 0.83.0, and 0.84.1");
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
		expect(configuration).toContain(
			"Pi 0.81 compatibility path omits the supplementary Executor text without changing selection or runtime behavior",
		);
	});

	it("keeps internal development history out of public documentation", () => {
		for (const document of publicDocs) {
			expect(document.content, document.path).not.toMatch(/\bSlice\s+\d/i);
			expect(document.content, document.path).not.toMatch(/^## Development$/m);
			expect(document.content, document.path).not.toContain("docs/internal");
		}
	});
});
