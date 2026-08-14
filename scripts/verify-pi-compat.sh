#!/usr/bin/env bash
set -euo pipefail

pi_version="${1:?usage: verify-pi-compat.sh <Pi version>}"
case "$pi_version" in
	0.81.1 | 0.83.0 | 0.84.1) ;;
	*)
		echo "Unsupported compatibility target: $pi_version" >&2
		exit 2
		;;
esac

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-advisor-compat.XXXXXX")"
cleanup() {
	rm -rf "$temp_root"
}
trap cleanup EXIT

copy_root="$temp_root/project"
mkdir -p "$copy_root"
tar \
	--exclude='./.git' \
	--exclude='./.memory-lane' \
	--exclude='./.pi-subagents' \
	--exclude='./node_modules' \
	--exclude='./coverage' \
	--exclude='./dist' \
	--exclude='./pack.json' \
	--exclude='./pi-advisor-package.tgz' \
	-cf - -C "$project_root" . | tar -xf - -C "$copy_root"

cd "$copy_root"
PI_COMPAT_VERSION="$pi_version" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.PI_COMPAT_VERSION;
if (!version) throw new Error("PI_COMPAT_VERSION is required");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
for (const name of [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
]) {
	manifest.devDependencies[name] = version;
}
writeFileSync("package.json", `${JSON.stringify(manifest, null, "\t")}\n`);
NODE
rm -f pnpm-lock.yaml

pnpm install --ignore-workspace --lockfile=false --config.auto-install-peers=false

for package_name in pi-agent-core pi-ai pi-coding-agent pi-tui; do
	actual_version="$(node -p "require('./node_modules/@earendil-works/${package_name}/package.json').version")"
	if [[ "$actual_version" != "$pi_version" ]]; then
		echo "Expected @earendil-works/${package_name} $pi_version, installed $actual_version" >&2
		exit 1
	fi
	echo "Verified @earendil-works/${package_name} $actual_version"
done

export PI_EXPECTED_VERSION="$pi_version"
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm pack:validate
