import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface PackManifest {
	name: string;
	version: string;
	filename: string;
	files: { path: string }[];
}

interface PackageManifest {
	name: string;
	version: string;
	private?: boolean;
	license?: string;
	types?: string;
	exports?: {
		"."?: { types?: string; import?: string };
	};
	keywords?: string[];
	files?: string[];
	publishConfig?: { access?: string; provenance?: boolean };
	pi?: { extensions?: string[] };
	peerDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
	bundledDependencies?: string[] | boolean;
	bundleDependencies?: string[] | boolean;
	engines?: { node?: string };
}

const inputPath = process.argv[2] ?? "pack.json";
// SAFETY: pnpm pack writes the PackManifest shape consumed by this validation script.
const pack = JSON.parse(readFileSync(inputPath, "utf8")) as PackManifest;
// SAFETY: the repository package.json provides the PackageManifest fields validated below.
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
const paths = pack.files.map((file) => file.path);

if (pack.name !== manifest.name || pack.version !== manifest.version) {
	throw new Error(
		`Packed identity ${pack.name}@${pack.version} does not match ${manifest.name}@${manifest.version}`,
	);
}
if (manifest.name !== "@ribbons-digital/pi-advisor") {
	throw new Error(`Unexpected package name: ${manifest.name}`);
}
if (manifest.private === true) throw new Error("The public package manifest must not be private");
if (manifest.license !== "MIT") throw new Error("The package license must be MIT");
if (manifest.publishConfig?.access !== "public" || manifest.publishConfig.provenance !== true) {
	throw new Error("publishConfig must require public access and provenance");
}
if (!manifest.keywords?.includes("pi-package") || !manifest.keywords.includes("pi-extension")) {
	throw new Error("Package discovery keywords are incomplete");
}
if (manifest.pi?.extensions?.length !== 1 || manifest.pi.extensions[0] !== "./src/index.ts") {
	throw new Error("Pi extension metadata must point only to ./src/index.ts");
}
if (manifest.types !== "./src/index.ts" || manifest.exports?.["."] === undefined) {
	throw new Error("Package root TypeScript exports are incomplete");
}
for (const name of [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
] as const) {
	if (manifest.peerDependencies?.[name] !== "*") {
		throw new Error(`Host-provided ${name} must be a wildcard peer dependency`);
	}
	if (manifest.dependencies?.[name] !== undefined) {
		throw new Error(`Host-provided ${name} must not be a runtime dependency`);
	}
	for (const bundled of [manifest.bundledDependencies, manifest.bundleDependencies]) {
		if (Array.isArray(bundled) && bundled.includes(name)) {
			throw new Error(`Host-provided ${name} must not be bundled`);
		}
	}
}
if (manifest.engines?.node !== ">=22.19.0") {
	throw new Error("Node engine must be >=22.19.0");
}
if (manifest.dependencies?.yaml === undefined) {
	throw new Error("Runtime yaml dependency is missing");
}

const required = [
	"LICENSE",
	"README.md",
	"THIRD_PARTY_NOTICES.md",
	"package.json",
	"src/index.ts",
	"docs/assets/advisor-in-action.png",
	"docs/configuration.md",
	"docs/security.md",
];
for (const path of required) {
	if (!paths.includes(path)) throw new Error(`Missing packed file: ${path}`);
}

const forbidden = paths.filter(
	(path) =>
		path === "CONTEXT.md" ||
		(path.startsWith("docs/") && !required.includes(path)) ||
		(/\.md$/iu.test(path) && !required.includes(path)) ||
		path.startsWith("tests/") ||
		path.startsWith("scripts/") ||
		path.startsWith(".github/") ||
		/^node_modules\/(?:@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)|typebox)(?:\/|$)/u.test(
			path,
		),
);
if (forbidden.length > 0) throw new Error(`Forbidden packed files: ${forbidden.join(", ")}`);

for (const path of required.filter((file) => file.endsWith(".md"))) {
	const content = execFileSync("tar", ["-xOf", pack.filename, `package/${path}`], {
		encoding: "utf8",
	});
	if (
		/\b(?:unreleased|unpublished)\b|planned release|not yet available|until release approval/iu.test(
			content,
		)
	) {
		throw new Error(`Release-preparation wording in packed ${path}`);
	}
}

process.stdout.write(
	`Validated publishable ${pack.name}@${pack.version} metadata and ${String(paths.length)} files in ${pack.filename}\n`,
);
