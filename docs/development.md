# Development

## Current baseline

Pi Advisor 0.5.0 targets Pi 1.0.0.
This contributor document is not included in the npm package.
Development dependencies pin all four Pi packages to 1.0.0 and TypeBox to 1.3.27.
The five host-provided packages use wildcard peers so Pi can supply its own modules.
Wildcard peers are a host-module loading contract, not a compatibility range.
Do not restore the obsolete Pi 0.81-0.84 compatibility jobs for this build.
Published Pi Advisor 0.4.1 remains available as a pinned older-Pi release.

CI checks Pi 1.0.0 on Node 22.19.0, the declared minimum, and Node 22.22.3.
Each job uses the frozen lockfile, checks all four installed Pi versions, and runs verification, packed-install E2E tests, and package validation.
Publication is a separate manually approved workflow; see [Release approval](releasing.md).

## Docker Sandbox

Run dependency installation and project code only inside Docker Sandboxes.
Do not use host npm, pnpm, Node project execution, or ordinary Docker containers.
Host file inspection, editing, Git, and sandbox management are allowed.

The existing sandbox is `pi-advisor-compat-research`.
Its mounted workspace is `/tmp/pi-advisor-compat-research.jXV79D`.
The current release verification snapshot is `/tmp/pi-advisor-compat-research.jXV79D/release-0.5.0`.
The `baseline`, `phase1`, `phase2`, `phase3`, and `phase4` snapshots are preserved for comparison.
Host dependencies, credentials, home directories, and the Docker socket are not shared.

Run these host commands from the repository root to refresh the snapshot:

```sh
SANDBOX=pi-advisor-compat-research
WORKSPACE=/tmp/pi-advisor-compat-research.jXV79D/release-0.5.0
mkdir -p "$WORKSPACE"
git ls-files --cached --others --exclude-standard -z \
  | while IFS= read -r -d '' file; do
      if [ -e "$file" ] || [ -L "$file" ]; then printf '%s\0' "$file"; fi
    done \
  | tar --null -T - -cf - \
  | tar -xf - -C "$WORKSPACE"
git diff --name-only --diff-filter=D -z HEAD \
  | while IFS= read -r -d '' file; do rm -f "$WORKSPACE/$file"; done
```

The final loop removes intentionally deleted tracked files from the snapshot without deleting dependencies or unrelated scratch files.
If the sandbox no longer exists, create one sharing only the snapshot:

```sh
sbx create --name "$SANDBOX" --skills off shell "$WORKSPACE"
```

`sbx exec` starts the sandbox when it is stopped.
Stop it without deleting its workspace:

```sh
sbx stop "$SANDBOX"
```

## Verified tools

The sandbox's system Node 22.22.1 was compiled without TypeScript support, which Oxlint needs for `oxlint.config.ts`.
Use the official Linux arm64 Node builds instead.
Both required versions are installed under `/tmp/pi-advisor-node` inside the sandbox.
To install a missing version, run this host command, choosing `22.22.3` or `22.19.0`:

```sh
sbx exec --workdir "$WORKSPACE" "$SANDBOX" bash -lc '
  set -euo pipefail
  VERSION=22.22.3
  mkdir -p /tmp/pi-advisor-node
  cd /tmp/pi-advisor-node
  curl -fLSsO "https://nodejs.org/dist/v${VERSION}/SHASUMS256.txt"
  curl -fLSsO "https://nodejs.org/dist/v${VERSION}/node-v${VERSION}-linux-arm64.tar.gz"
  grep " node-v${VERSION}-linux-arm64.tar.gz$" SHASUMS256.txt | sha256sum --check -
  tar -xzf "node-v${VERSION}-linux-arm64.tar.gz"
'
```

These paths describe the current Mac arm64 sandbox, not the architecture of GitHub's Ubuntu runner.

## Verification

Run the following host command for each required Node version:

```sh
sbx exec --workdir "$WORKSPACE" "$SANDBOX" bash -lc '
  set -euo pipefail
  VERSION=22.22.3
  test "$(pwd)" = /tmp/pi-advisor-compat-research.jXV79D/release-0.5.0
  mkdir -p /tmp/pi-advisor-bin
  export PATH="/tmp/pi-advisor-node/node-v${VERSION}-linux-arm64/bin:/tmp/pi-advisor-bin:$PATH"
  corepack enable --install-directory /tmp/pi-advisor-bin
  node --version
  pnpm --version
  pnpm install --frozen-lockfile
  for package_name in pi-agent-core pi-ai pi-coding-agent pi-tui; do
    actual_version="$(node -p "require(\"./node_modules/@earendil-works/${package_name}/package.json\").version")"
    test "$actual_version" = "1.0.0"
  done
  pnpm verify
  PI_EXPECTED_VERSION=1.0.0 pnpm test:e2e
  pnpm pack:validate
'
```

After source or test edits, run `pnpm format` inside this sandbox and address lint errors before the final checks.
Copy intended formatter changes back to the host and compare the changed files with the verified snapshot.
Run `git diff --check` before review or commit.
For an intentional dependency change, run `pnpm install --no-frozen-lockfile` inside the sandbox and copy the generated lockfile back.
Never edit generated lockfiles or changelogs by hand.

The managed-install E2E uses the pinned npm development dependency through Pi's package manager.
It can need registry access for `yaml`; it does not call model services.
Provider tests use scripted responses and local HTTP capture servers inside the sandbox.
They verify request shapes and actual Pi lifecycle behavior, not live model-service compatibility.
A passing package load alone does not prove functioning reviews or provider parity.
No development server, published port, or local preview URL is required for these checks.
These command-line checks do not replace rendered-interface checks when UI changes.

## Review and release gates

Keep the upgrade PR draft until the agreed implementation and independent review gates pass.
Report the tested Node and Pi versions, package checks, and remaining live-service limits separately.
Do not change versions, tag, merge, or publish without the user's approval for that step.
Follow [Release approval](releasing.md) for version, archive-content, tag, and publication checks.
