# Release approval

Release target: v0.5.0.
Pi Advisor 0.5.0 supports Pi 1.0.0 and requires Node.js `>=22.19.0`.
This document is maintainer guidance and is not included in the npm package.
A clean review does not authorize a merge or publication.
Do not republish 0.4.1 or reuse its tag for the Pi 1.0 release.

## Release checks

- Obtain approval for the versioned release changes.
- Update `package.json`, regenerate `pnpm-lock.yaml` inside Docker Sandboxes, and update the release metadata contract and documentation together.
- Verify the frozen lockfile and all four installed Pi 1.0.0 packages on Node 22.19.0 and 22.22.3.
- Run `pnpm verify`, `PI_EXPECTED_VERSION=1.0.0 pnpm test:e2e`, and `pnpm pack:validate` inside the documented Docker Sandbox.
- Inspect the actual archive, not only the manifest's `files` declaration.
- Include only runtime source, package metadata, the license, README, third-party notices, the configuration and security guides, and the README image.
- Exclude contributor instructions, release procedures, experiments, internal planning, tests, scripts, and CI files.
- Use release-ready wording in every README and documentation file.
- Retain the pinned older-Pi installation guidance.
- Repeat independent review for the versioned release diff.
- Require both GitHub CI jobs to pass for the exact release PR commit before merge.
- Preserve the separate user merge gate.

The main-branch ruleset requires:

- `Verify Pi 1.0.0 on Node 22.19.0`
- `Verify Pi 1.0.0 on Node 22.22.3`

Release preparation does not authorize changing repository protections.
Preserve strict up-to-date checks, required PR review, resolved-review requirements, deletion protection, and non-fast-forward protection.

Automated provider evidence uses scripted responses and local HTTP capture.
Live model-service compatibility remains unverified.
Local sandbox checks run on Linux arm64; GitHub Ubuntu jobs provide separate runner evidence.
Report any approved live provider checks separately without exposing credentials or transcripts.

## Tag and publish

1. After the user approves and merges the release changes, tag the exact approved commit as `v0.5.0`; the tag must match `package.json`.
2. With publication approval, run the existing **Publish npm package** GitHub workflow using its `workflow_dispatch` tag input.
3. Confirm that the `npm-release` environment gate has passed and publication succeeded before reporting the version as available.
4. Check the registry version and the published archive contents.

The release workflow checks the requested tag against the manifest and exact checkout, reruns verification and E2E on Node 22.22.3, validates one tarball, and publishes that exact tarball with npm trusted-publishing provenance.
Do not replace it with a local `npm publish` or provide host credentials to dependency code.
Use the project's generator for a generated changelog, if one is introduced; never edit `CHANGELOG.md` by hand.
