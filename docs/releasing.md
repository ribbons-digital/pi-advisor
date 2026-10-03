# Release approval

The Pi 1.0.0 upgrade remains unreleased.
Planned release: v0.5.0 (unreleased).
The planned release tag is `v0.5.0`; do not create it before approval.
The checkout's package version is still 0.4.1; this is not a new npm release.
A clean review does not authorize a merge or publication.
Do not republish 0.4.1 or reuse its tag for the Pi 1.0 build.

## Before making the PR ready

- Complete independent review of the Pi 1.0.0 changes, including CI and support documentation.
- Verify the frozen lockfile, all four installed Pi 1.0.0 packages, and the complete checks on Node 22.19.0 and 22.22.3.
- Run `pnpm verify`, `PI_EXPECTED_VERSION=1.0.0 pnpm test:e2e`, and `pnpm pack:validate` inside the documented Docker Sandbox.
- After approval to commit and push the reviewed changes, require both GitHub CI jobs to pass for that exact PR commit before merge.
- Keep the package's support claim limited to Pi 1.0.0; wildcard peers do not prove other-version compatibility.
- Preserve the separate user merge gate.

### One-time CI ruleset migration

If the main-branch ruleset still requires `Verify Pi 0.82.0 baseline` and `Verify isolated Pi 0.81.1 compatibility`, those obsolete names block merge even when the new jobs pass.
With explicit repository-owner approval, replace only those required check names with:

- `Verify Pi 1.0.0 on Node 22.19.0`
- `Verify Pi 1.0.0 on Node 22.22.3`

Preserve strict up-to-date checks, required PR review, resolved-review requirements, deletion protection, and non-fast-forward protection.
Coordinate the change with the reviewed CI push so other PRs are not left waiting for checks their workflows cannot emit.
The CI and documentation task does not authorize changing repository protections.

Automated provider evidence uses scripted responses and local HTTP capture.
Live model-service compatibility remains unverified.
Local sandbox checks run on Linux arm64; the GitHub Ubuntu jobs provide separate runner evidence after the reviewed changes are pushed.
If live provider checks are later approved, report their actual models and results separately without exposing credentials or transcripts.

## Only after release approval

1. Confirm approval to prepare the planned v0.5.0 release for the changed Pi support boundary.
2. Update `package.json` to `0.5.0`, regenerate `pnpm-lock.yaml` inside Docker Sandboxes, and update the release metadata contract and public documentation together.
3. Update the checkout-version notices, retain pinned older-Pi guidance, and keep v0.5.0 marked unreleased until publication succeeds.
4. Use the project's generator for a generated changelog, if one is introduced; never edit `CHANGELOG.md` by hand.
5. Repeat verification, packed-install E2E, package validation, and independent review for the versioned release diff.
6. After the user approves and merges the release changes, tag the exact approved commit as `v0.5.0`; the tag must match `package.json`.
7. With explicit publication approval, run the existing **Publish npm package** GitHub workflow using its `workflow_dispatch` tag input.

The release workflow keeps the `npm-release` environment gate.
It checks the requested tag against the manifest and exact checkout, reruns verification and E2E on Node 22.22.3, validates one tarball, and publishes that exact tarball with npm trusted-publishing provenance.
Do not replace it with a local `npm publish` or provide host credentials to dependency code.
Creating or dispatching a release tag is not part of the current CI and documentation task.
