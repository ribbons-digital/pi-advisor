# Security

Pi Advisor extensions run with the user's full system permissions.
Review the package before installing it.
This document describes the defenses and residual risks around context sharing and Advisor read-only tools.

## Provider disclosure boundary

When Advisor is active, the selected model provider receives bounded review context and content returned by allowed read-only tools.
Observed Executor content and Pi-supplied project context are redacted before budgeting and submission.
Allowed file-tool results are bounded but are not transcript-redacted before the selected provider receives them.

No redaction or path policy can guarantee that every secret is excluded.
Use `tools: []` or a narrower tool set when the selected provider should not read repository files.
Add sensitive repository locations to `security.additionalProtectedPaths`.

On Pi 0.82 or later, Advisor automatically requests strict constrained sampling only for models with an explicit compatible provider capability flag.
Pi 0.81.x and other models retain the portable schema.
The strict request uses Pi's `prefer` policy, so provider-side enforcement is not guaranteed and may fall back to ordinary tool calling.
Local structural and semantic validation remains authoritative regardless of the selected mode.
Private generated `advise` arguments are not added to diagnostics or persistence.

## Protected targets

Advisor blocks normalized requested paths and canonical existing targets for:

- Exact basename `.env` and basenames beginning with `.env.`.
- Files ending in `.pem`, `.key`, `.p12`, `.pfx`, or `.jks`.
- Path segments `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, and `private-keys-v1.d`.
- Exact basenames `.npmrc`, `.pypirc`, `.credentials`, `credentials.json`, `auth.json`, `docker-config.json`, `login data`, and `keychain-db`.
- Exact home targets `~/.config/gcloud`, `~/.docker/config.json`, and `~/.pi/agent/auth.json`.
- User and trusted Project additional protected paths.

Search and listing tools filter protected descendants before returning results.
A blocked operation returns `Access blocked by Advisor protected-path policy.` without protected content.

User configuration may create an exception for one exact normalized or canonical target.
An exception does not exempt descendants of a directory.
Trusted Project configuration can only add restrictions and cannot create exceptions.

## Path controls

Advisor read-only tools:

- Resolve relative paths from the repository working directory.
- Strip Pi's leading `@` path alias.
- Normalize separators and dot segments.
- Resolve existing targets through `realpath`.
- Evaluate both the requested path and canonical target.
- Apply platform-appropriate case handling.
- Filter protected names from search and listing output.
- Bound traversal, file count, file size, output size, and process time.
- Rewrite ripgrep filename prefixes from absolute to working-directory-relative paths.

These controls are a static path-disclosure defense, not a filesystem sandbox.

## Tool bounds

The protected `read` tool retains Pi's built-in 2,000-line and 50 KiB output limits after authorization.

The protected `ls` tool:

- Defaults to 500 visible entries.
- Accepts at most 2,000 visible entries.
- Scans at most 5,000 directory entries per call.

The protected `find` tool:

- Returns files only.
- Defaults to 1,000 results and accepts at most 2,000.
- Skips `.git` and `node_modules` during traversal.
- Stops at 2,000 directories or 20,000 examined entries.

The protected `grep` tool:

- Preselects at most 500 files.
- Accepts files no larger than 1,000,000 bytes each and 5,000,000 bytes in total.
- Traverses at most 1,000 directories and 10,000 entries.
- Limits context to 20 lines.
- Defaults to 100 output lines and accepts at most 2,000.
- Gives `rg` two seconds.
- Uses `rg` without a shell when available.
- Uses a bounded in-process reader for explicit literal searches when `rg` is unavailable.
- Reports regex search as unavailable when `rg` is unavailable.

## Redaction

Pi Advisor pattern-redacts observed Executor deltas, Pi-supplied project context, accepted notes, configuration instructions, diagnostics, and bounded failure reasons before their next relevant use or display.
Patterns cover private-key blocks, bearer tokens, common provider token forms, common secret assignments, and passwords embedded in HTTP URLs.

Redaction reduces accidental exposure but cannot recognize every credential format or sensitive value.

## Configuration trust

User WATCHDOG files apply across repositories.
Pi reads Project WATCHDOG files only when it reports the project as trusted.
Trusted Project configuration may narrow tools and limits, add protected paths, or add lower-authority instructions.
For cumulative usage caps, a finite Project value may narrow User `off`, while Project `off` cannot remove or raise a finite User cap.
It cannot activate Advisor, select a model, increase spending or exposure, remove protections, create exceptions, or change local activity recording.

Trusted Project instructions still reach the selected model and retain residual prompt-injection risk.
Fixed Advisor policy and code-enforced safety controls remain higher authority than freeform instructions.

## Usage and cost controls

Advisor input, output, cache-read, cache-write, total-token, and provider-reported cost accounting remains visible for the lifetime of the runtime.
The cumulative token and reported-cost caps default to `off` so private-context maintenance does not stop normal background review merely because cache-heavy lifetime totals grow.
Users who require a spending stop can configure a positive token cap, reported-cost cap, or both.
Provider reporting can be missing or incomplete, and Pi Advisor does not yet add the nested compaction usage exposed by Pi 0.81.1 to its exact governor totals, so these controls cannot guarantee a complete monetary bound.
Clearing private Advisor context does not reset or conceal lifetime usage totals.

## Persistence

Lifecycle state and local redacted activity records use Pi custom entries outside model context.
The activity record is enabled by default for valid User configurations and can be disabled for future records with `persistence.transcript: false`.
Existing explicit `false` configurations remain off, loading does not rewrite the User file, and malformed or unreadable User configuration fails privacy-safe with recording off.
New version 2 records contain review grouping, ordered tool metadata, bounded redacted targets, completion and output-size metadata, final outcomes, provider-reported usage, cost, and stop reason.
They never contain Executor update bodies, file-tool result bodies, Executor or Advisor reasoning, internal `advise` notes or arguments, raw provider payloads, protected-path content, or rejected or suppressed note content.
Valid legacy version 1 records may still contain bounded bodies written by earlier releases and are labeled as legacy in diagnostics.
Redaction and bounding reduce risk but cannot guarantee detection of every sensitive value in paths or search patterns.
Delete the associated Pi session if you need to remove existing records.
See the [configuration reference](configuration.md#persistence-retention-inspection-and-deletion) for exact record fields and retention behavior.

## Runtime compatibility

Pi Advisor 0.4.1 requires Node.js `>=22.19.0` and Pi `>=0.81.1 <0.85.0`.
Pi 0.82.0 is the primary tested Pi release, with compatibility coverage retained for Pi 0.81.1, Pi 0.83.0, and Pi 0.84.1.
Pi 0.80.x is incompatible with this release, and Pi Advisor 0.1.3 remains the legacy release for Pi 0.80.7.
Advisor mirrors public provider registration inputs into an isolated runtime and requires strict effective authentication, headers, environment, base URL, and model-request parity before activation.
Missing credentials, missing providers, or parity that cannot be verified leaves Advisor inactive without fallback or a nested provider request.
Runtime-only credentials are copied only in memory and are never persisted by Advisor.

## Residual risks

Known residual risks include:

- Secrets in otherwise ordinary source files, generated output, logs, databases, archives, or remote results.
- Hard-link aliases, because pathname and `realpath` checks do not identify unrelated names for the same inode.
- Concurrent symlink retargeting, file replacement, or file growth between authorization and access.
- A configured symlink target changing after Advisor tools are created.
- Novel secret formats that pattern redaction does not recognize.
- Provider-side storage, logging, and retention according to the selected provider's policies.
- Model prompt injection from trusted repository content.

Use a provider and configuration appropriate for the sensitivity of the repository.
Disable Advisor or its file tools when the remaining exposure is unacceptable.

## Reporting vulnerabilities

Do not include credentials, private session transcripts, or unredacted `/advisor dump` output in a public issue.
Report a suspected vulnerability through the repository's private security-reporting channel when available.
