# Pi Advisor Configuration Reference

This is the complete public reference for version `1` Pi Advisor WATCHDOG configuration.
Pi Advisor supports one Advisor.
OMP paths, `@import` expansion, a fullscreen multi-pane editor, and multiple advisors are not supported.

## File locations and trust

| Scope   | YAML policy                     | Markdown instructions          |
| ------- | ------------------------------- | ------------------------------ |
| User    | `~/.pi/agent/WATCHDOG.yml`      | `~/.pi/agent/WATCHDOG.md`      |
| Project | `<repository>/.pi/WATCHDOG.yml` | `<repository>/.pi/WATCHDOG.md` |

User files are owned by the user and apply in every repository.
Project files are read only when Pi reports the project as trusted.
Untrusted Project files are ignored without being opened.
Project configuration can only specialize or narrow User policy.
External edits are not watched and remain unapplied until Pi `/reload` or a confirmed `/advisor configure` apply.

## Interactive configuration

Run `/advisor` or `/advisor configure` in a dialog-capable TUI or RPC client.
The workflow opens a section menu: model and reasoning, read-only tools, instructions, apply, and cancel.
Each section edits only its own values through Pi-native dialogs and returns to the menu, so you can change one section and keep the rest.
The model step selects an authenticated model and an independent Advisor reasoning level.
Advisor reasoning choices are derived from the selected model's supported levels, so unsupported levels are omitted and a model without reasoning support offers only `off`.
If the current Advisor reasoning level is unsupported by the selected model, the workflow warns and requires a new supported selection.
On Pi 0.82, the reasoning prompt shows the current Executor reasoning level as supplementary context for the user, but the Advisor selection remains independent and is not automatically coupled to it.
The Pi 0.81 compatibility path omits the supplementary Executor text without changing selection or runtime behavior.
The TUI model step starts focused and fuzzy-searches provider, model ID, and display name while RPC clients keep the standard selection dialog.
After tool selection, a separate instructions step lets users continue without custom instructions or explicitly open the multiline editor to add them.
When instructions already exist, that step offers deliberate keep, edit, and clear choices, and only edit opens the multiline editor.
It then shows one summary and asks for confirmation before saving.
Apply performs the single existing confirmation, atomic save, and immediate runtime rebuild; cancel discards all pending edits and keeps the prior configuration and runtime.
Cancellation at any picker or the instructions editor leaves the file and runtime unchanged.
The tool picker cannot select `bash`, `edit`, `write`, an extension tool, or any other mutating or unapproved tool.
A confirmed save atomically replaces the User YAML file with mode `0600` and immediately rebuilds the current runtime.
The rebuild invalidates stale in-flight output, preserves delivered-note and lifetime usage totals, and prepares one bounded current-branch re-prime for the next eligible update.
If that lifecycle snapshot cannot fit safely, Advisor discards only the snapshot and reviews the current bounded update against fresh private context instead of pausing.
The workflow remains available when Advisor is disabled, paused, missing a model, or otherwise has no live nested runtime.
Non-dialog clients receive this reference path instead of a partial editor.
Protected paths, activation, limits, Memory suggestions, persistence, and other advanced fields are edited directly in YAML.

## Activation by run mode

| Control                | TUI                     | RPC                     | JSON                                        | Print                                       | Persistence effect |
| ---------------------- | ----------------------- | ----------------------- | ------------------------------------------- | ------------------------------------------- | ------------------ |
| `defaultEnabled: true` | Activates a new session | Activates a new session | Ignored for activation                      | Ignored for activation                      | User YAML only     |
| `/advisor on`          | Activates this session  | Activates this session  | Available only where commands are processed | Available only where commands are processed | None               |
| `--advisor`            | Activates this launch   | Activates this launch   | Activates this launch                       | Activates this launch                       | None               |
| `/advisor off`         | Disables this session   | Disables this session   | Available only where commands are processed | Available only where commands are processed | None               |

Activation never chooses a model automatically.
Pi Advisor 0.4.0 requires Node.js `>=22.19.0` and Pi `>=0.81.1 <0.85.0`.
Pi 0.82.0 is the primary tested Pi release, with compatibility coverage retained for Pi 0.81.1, Pi 0.83.0, and Pi 0.84.1.
Pi Advisor 0.1.3 remains the legacy release for Pi 0.80.7.
A missing model, unavailable model, missing credentials, incompatible critical Pi API, or provider parity that cannot be verified leaves Advisor inactive without fallback.
Project configuration can never activate Advisor.

## Advise schema selection

Pi Advisor automatically selects strict constrained sampling only on Pi 0.82 or later when the selected model has an explicit compatible provider capability flag.
Pi 0.81.x and models without that explicit capability continue to use the portable schema.
The selected mode is shown by `/advisor status` and is runtime-only; configuration and lifecycle state do not persist it.

Strict mode uses Pi's `prefer` policy, which permits ordinary tool-calling fallback when the provider cannot enforce the schema and therefore never guarantees provider-side enforcement.
Pi Advisor's local structural and semantic validation remains authoritative in both modes.
Private generated `advise` arguments are not added to diagnostics, activity records, or lifecycle persistence.

## Ownership and merge rules

| Area                      | User authority                                             | Trusted Project authority                                                                                      | Project attempt outside authority                                                                                                                     |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema version            | Must be `1`                                                | Must be `1`                                                                                                    | Invalid document is ignored                                                                                                                           |
| Activation and model      | Full                                                       | None                                                                                                           | Warned and ignored                                                                                                                                    |
| Reasoning effort          | Full                                                       | None                                                                                                           | Warned and ignored                                                                                                                                    |
| Tools                     | Approves a read-only set                                   | Intersects and therefore only removes                                                                          | Unknown or mutating tools invalidate the document                                                                                                     |
| Instructions              | Adds User instructions                                     | Adds lower-authority tagged instructions                                                                       | Cannot replace fixed policy                                                                                                                           |
| Maximum limits            | Sets within package bounds                                 | May lower                                                                                                      | Higher values are clamped to User values                                                                                                              |
| Minimum cadence           | Sets                                                       | May increase                                                                                                   | Lower values are clamped to User values                                                                                                               |
| Context fraction          | Sets                                                       | May lower                                                                                                      | Higher values are clamped to User values                                                                                                              |
| Response reserve          | Sets                                                       | May increase                                                                                                   | Lower values are clamped to User values                                                                                                               |
| Protected paths           | May add                                                    | May add                                                                                                        | No removal mechanism exists                                                                                                                           |
| Protected-path exceptions | May create exact exceptions                                | None                                                                                                           | Warned and ignored                                                                                                                                    |
| Memory suggestions        | May enable, disable, or set limits                         | May disable or narrow                                                                                          | Re-enabling or broadening is ignored or clamped                                                                                                       |
| Review freshness and cost | May enable skip or adaptive cadence and set cadence bounds | May enable skip or adaptive cadence, lower `silentReviewsBeforeBackOff`, and raise `maxMinTurnsBetweenReviews` | Disabling a User-enabled option, raising `silentReviewsBeforeBackOff`, lowering `maxMinTurnsBetweenReviews`, or changing `backOffTurnStep` is ignored |
| Local activity recording  | May enable or disable                                      | None                                                                                                           | Warned and ignored                                                                                                                                    |
| Spending increases        | May set                                                    | None beyond lowering caps                                                                                      | Activation, model, effort, and persistence fields are warned and ignored                                                                              |

Malformed User configuration falls back to safe inactive behavior with persisted activation and local activity recording off.
Malformed Project configuration is ignored.
Warnings identify the file and field path without printing its value.
Unknown fields are warned and ignored only when the remaining known document validates.
Since QS-1 (2026-08-15), unknown top-level User fields are preserved verbatim across a `/advisor configure` save round-trip so forward-compatible keys are not silently dropped.
The preserved values are re-emitted exactly as loaded, remain outside every typed field, and are never interpreted by the current package; a future schema that recognizes such a key makes its own decision about the value.
Preserved content is bounded to 64 KiB total; a larger unknown top-level block is dropped with a warning instead of being written back.
Unknown nested fields are still dropped on save.

## Complete field reference

All numeric limits are applied before a provider request or accepted-note delivery as appropriate.
A confirmed configure apply affects the current runtime immediately except where the field explicitly controls only future session activation or restoration.
An external edit affects no running extension instance until `/reload` or configure apply.

### Top-level fields

| YAML path        | Type and accepted values                                     | Release default | Scope and Project merge           | Effect                                                                                                      |
| ---------------- | ------------------------------------------------------------ | --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `version`        | Integer literal `1`                                          | Required `1`    | User and Project                  | Selects the schema and rejects unsupported versions.                                                        |
| `defaultEnabled` | Boolean                                                      | `false`         | User only                         | Controls new TUI and RPC sessions only and never activates JSON or print runs.                              |
| `model`          | `provider/model` string                                      | Unset           | User only                         | Selects the only Advisor provider model and therefore its provider network and pricing.                     |
| `effort`         | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | `high`          | User only                         | Controls provider reasoning effort and can change latency, shared reasoning, tokens, and cost.              |
| `tools`          | Unique subset of `read`, `grep`, `find`, and `ls`            | All four        | User approves; Project intersects | Controls which protected read-only tools the Advisor can call. An empty list allows only internal `advise`. |
| `instructions`   | String                                                       | Empty           | User and Project                  | Adds review focus under the fixed policy. Project text is tagged below User text.                           |

Example tool selection:

```yaml
version: 1
tools: [read, grep]
```

### Context fields

| YAML path                 | Type                           | Release default | Scope and Project merge         | Effect                                                                                                   |
| ------------------------- | ------------------------------ | --------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `context.maxFraction`     | Number from `0.01` through `1` | `0.65`          | User sets; Project may lower    | Sets the fraction of model context available before private compaction or fresh current-update recovery. |
| `context.reserveTokens`   | Number at least `0`            | `8192`          | User sets; Project may increase | Reserves response space and can trigger earlier maintenance.                                             |
| `context.maxUpdateTokens` | Number at least `1`            | `24000`         | User sets; Project may lower    | Bounds each redacted Executor update and limits provider exposure and cost.                              |

### Review, delivery, and session limits

| YAML path                             | Type                             | Release default | Hard maximum | Scope and Project merge         | Effect                                                                                                         |
| ------------------------------------- | -------------------------------- | --------------- | ------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `limits.maxAdviceCharacters`          | Number at least `1`              | `2000`          | `8000`       | User sets; Project may lower    | Bounds accepted note characters and visibly truncates oversized ordinary rationale.                            |
| `limits.maxAdviceTokens`              | Number at least `1`              | `512`           | `2048`       | User sets; Project may lower    | Adds an estimated-token bound to accepted notes.                                                               |
| `limits.maxAdvisorTurnsPerUpdate`     | Number at least `1`              | `4`             | `12`         | User sets; Project may lower    | Stops long private Advisor tool loops.                                                                         |
| `limits.maxToolCallsPerUpdate`        | Number at least `0`              | `8`             | `32`         | User sets; Project may lower    | Caps read-only calls in one update. `0` disables read-only calls while preserving `advise`.                    |
| `limits.maxPendingTranscriptBytes`    | Number at least `1`              | `200000`        | `1000000`    | User sets; Project may lower    | Bounds coalesced Executor backlog and associated bounded metadata.                                             |
| `limits.maxReprimeTokens`             | Number at least `1`              | `32000`         | `128000`     | User sets; Project may lower    | Bounds a redacted current-branch re-prime snapshot.                                                            |
| `limits.minTurnsBetweenReviews`       | Number at least `1`              | `1`             | None         | User sets; Project may increase | Reduces review frequency by requiring more meaningful Executor turns.                                          |
| `limits.minIntervalMs`                | Number at least `0`              | `0`             | None         | User sets; Project may increase | Reduces review frequency by requiring elapsed time while retaining one bounded coalesced update.               |
| `limits.deferredAdviceRetentionHours` | Number at least `0`              | `24`            | None         | User sets; Project may lower    | Controls cross-exit retention for accepted deferred advice. `0` disables new cross-exit note retention.        |
| `limits.sessionTokenSoftCap`          | `off` or number at least `1`     | `off`           | None         | User sets; Project may lower    | Optionally pauses only Advisor when exact reported lifetime review tokens reach the configured cap.            |
| `limits.sessionCostSoftCapUsd`        | `off` or number greater than `0` | `off`           | None         | User sets; Project may lower    | Optionally pauses only Advisor when provider-reported lifetime review cost reaches the configured cap.         |
| `limits.maxReviewAttemptMs`           | Number from `1` through `600000` | `120000`        | `600000`     | User sets; Project may lower    | Wall-clock bound for one nested review prompt. Exceeding it aborts that attempt and skips the review.          |
| `limits.maxNestedCompactionMs`        | Number from `1` through `300000` | `60000`         | `300000`     | User sets; Project may lower    | Wall-clock bound for Advisor's private nested `AgentSession.compact()`.                                        |
| `limits.maxLifecycleAbortMs`          | Number from `0` through `30000`  | `2000`          | `30000`      | User sets; Project may lower    | Max wait for nested abort during disable, shutdown, and the next review after compact/tree. `0` does not wait. |

Host `/compact` and tree navigation signal nested abort and return immediately. They never wait for the nested Advisor request to finish.
Disable, shutdown, and the next Advisor review still bound nested abort waits with `maxLifecycleAbortMs` so those paths cannot hang unbounded on a provider that ignores abort.
Host `retry.provider.timeoutMs` and `httpIdleTimeoutMs` do not apply to the nested Advisor session; these fields are the nested bounds.
`maxLifecycleAbortMs: 0` returns immediately after signalling abort and lets the nested request finish in the background.
A timed-out review is a governor skip, not a consecutive ordinary failure.

Both cumulative caps are opt-in and are disabled by default so normal Advisor review continues across long cache-heavy sessions.
Input, output, cache-read, cache-write, total-token, and provider-reported cost accounting remains visible when a cap is `off`.
A trusted Project finite cap may narrow a User `off` value.
A Project `off` value cannot disable or raise a finite User cap.
Provider pricing or usage can be absent or incomplete, so explicitly enabled token and dollar caps remain independent safeguards.
Pi 0.81.1 exposes nested compaction usage, but Pi Advisor does not yet consume it in its exact governor totals.

### Protected paths

| YAML path                           | Type                            | Release default | Scope and Project merge              | Effect                                                                                                                                       |
| ----------------------------------- | ------------------------------- | --------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `security.additionalProtectedPaths` | Array of non-empty path strings | `[]`            | User and Project; arrays are unioned | Blocks each target and descendants by normalized request and canonical target. Relative paths resolve from the repository working directory. |
| `security.protectedPathExceptions`  | Array of non-empty path strings | `[]`            | User only                            | Allows only an exact normalized or canonical target that would otherwise be blocked. It does not exempt descendants.                         |

Default protection blocks `.env` and `.env.*`, `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `private-keys-v1.d`, `.npmrc`, `.pypirc`, `.credentials`, `credentials.json`, `auth.json`, `docker-config.json`, `login data`, `keychain-db`, and files ending in `.pem`, `.key`, `.p12`, `.pfx`, or `.jks`.
It also blocks `~/.config/gcloud`, `~/.docker/config.json`, and `~/.pi/agent/auth.json`.
Blocked tools return `Access blocked by Advisor protected-path policy.` without protected content.
Search and listing filter protected descendants before returning results.

An exact User exception looks like this:

```yaml
version: 1
security:
  additionalProtectedPaths:
    - fixtures/private
  protectedPathExceptions:
    - fixtures/private/public-example.txt
```

Exceptions can expose sensitive content to the selected provider and should be rare.
Read-only access, static symlink-aware checks, and redaction are defenses rather than a sandbox.
They cannot guarantee detection of every secret, hard-link alias, or concurrent same-user filesystem mutation.

### Delivery fields

While the Executor is running, accepted advice of every severity uses the existing steering boundary.
While the Executor is idle, an accepted review note whose severity is listed in `delivery.activeIdleSeverities` starts one automatic Executor follow-up instead of waiting for the next user turn.
The release default admits only `blocker`, so an idle `blocker` reaches the Executor through one bounded automatic continuation while `concern` and `nit` keep deferred delivery.
The same newer-instruction-input guard that protects Memory suggestion follow-ups applies, and a fixed session cap of five automatic review follow-ups bounds cost with deferred fallback at the cap.
A review follow-up cannot chain: while it is pending, its own Executor continuation is not reviewed and no new review follow-up can dispatch.
A stale review follow-up reuses the Memory supersession rules: it discards the queued ordinary Advisor review of the intervening Executor continuation, whose activity the no-chain guard would suppress anyway.
`nit` is structurally excluded because validation accepts only the values below.
Empty `activeIdleSeverities: []` preserves pre-Q3 behavior (all idle review notes deferred).

| YAML path                       | Type                            | Release default | Hard maximum | Scope and Project merge                   | Effect                                                                                       |
| ------------------------------- | ------------------------------- | --------------- | ------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `delivery.activeIdleSeverities` | Array of `concern` or `blocker` | `[blocker]`     | None         | User sets; Project may only remove values | Lists severities that may start one automatic Executor follow-up while the Executor is idle. |

### Review freshness and cost fields

In-flight review supersession is always on and has no configuration field.
When a newer meaningful update is scheduled while a review attempt is in flight and no `advise` execution has started, Advisor aborts that nested prompt, rolls the attempt back, coalesces the superseded window, and submits one replacement review.
Supersession applies only to an attempt actually aborted for that reason; a failed, governed, silent, or accepted attempt is classified normally even when a newer update is queued, and the queued update is processed afterward by the drain loop.
A superseded attempt is not a failed review.
Held-for-material-turn updates never trigger supersession and wait for the next material window instead.
Session soft caps win over supersession.

When `review.skipNonMaterialTurns` is enabled, a Meaningful Executor turn with no Materially newer Executor activity is held and coalesced until a later material turn joins it.
Neither ordinary turn cadence nor the elapsed-time cadence timer can submit that held update by itself.
Held-for-material-turn updates stay inside the existing pending-transcript byte bounds and are excluded from persisted `queuedReview` snapshots.
Their loss across restart is a documented bounded cost of enabling the option.

When `review.adaptiveCadence.enabled` is true, each completed run of `silentReviewsBeforeBackOff` consecutive silent reviews increases the effective minimum turn distance by `backOffTurnStep`, never above `maxMinTurnsBetweenReviews` and never below `limits.minTurnsBetweenReviews`.
Any accepted Advisory note resets that effective distance to the floor.
Failed and governor-skipped reviews neither extend nor reset the back-off.
Adaptive cadence state is in-memory only and is not restored on resume.
`/advisor status` reports the effective cadence.

### Dedupe fields

Review notes that reuse the same `findingKey` compare their normalized-note 64-bit SimHash signature against the stored signature of that key's last delivery.
A similarity below `dedupe.similarityRedeliveryThreshold` delivers the note with a possible-duplicate tag, while a similarity at or above the threshold suppresses it, so `0` disables the secondary signal and larger values redeliver more.
A note whose severity is strictly higher than the stored highest delivered severity and arrives at least `dedupe.reRaiseMinTurns` meaningful turns after that key's last delivery re-delivers with a re-raised tag, and `0` disables escalation re-raise.
Project configuration may only reduce redelivery and cost: it may lower `similarityRedeliveryThreshold`, and it may raise or zero `reRaiseMinTurns`, never the opposite directions.

| YAML path                                           | Type                                                     | Release default | Hard maximum   | Scope and Project merge                | Effect                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------- | --------------- | -------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `review.skipNonMaterialTurns`                       | Boolean                                                  | `false`         | Not applicable | User sets; Project may set only `true` | Holds non-material Meaningful turns until a later material turn joins them.                         |
| `review.adaptiveCadence.enabled`                    | Boolean                                                  | `false`         | Not applicable | User sets; Project may set only `true` | Enables silent-review back-off of the effective minimum turn distance.                              |
| `review.adaptiveCadence.silentReviewsBeforeBackOff` | Number from `1` through `32`                             | `3`             | `32`           | User sets; Project may lower           | Silent reviews required before one back-off step.                                                   |
| `review.adaptiveCadence.backOffTurnStep`            | Number from `1` through `8`                              | `1`             | `8`            | User only                              | Turns added to the effective minimum distance after each silent run.                                |
| `review.adaptiveCadence.maxMinTurnsBetweenReviews`  | Number from `limits.minTurnsBetweenReviews` through `64` | `4`             | `64`           | User sets; Project may raise           | Cap on the effective minimum turn distance.                                                         |
| `dedupe.similarityRedeliveryThreshold`              | Number from `0` through `1`                              | `0.5`           | `1`            | User sets; Project may lower           | Similarity below this value redelivers a reused `findingKey` as a possible duplicate. `0` disables. |
| `dedupe.reRaiseMinTurns`                            | Number from `0` through `64`                             | `4`             | `64`           | User sets; Project may raise or zero   | Meaningful turns before a strictly higher severity re-delivers the key as re-raised. `0` disables.  |

### Memory suggestion fields

Memory suggestions activate only while ordinary Advisor is active and Pi exposes a schema-compatible active `memory_suggest` tool.
While the Executor is running, an accepted suggestion uses the existing steering boundary.
While the Executor is idle, an accepted suggestion starts one automatic Executor follow-up when no newer user or instruction-bearing input has appeared after its evidence window.
Newer Executor assistant, tool-call, or tool-result continuation does not by itself prevent the follow-up, although chronological staleness remains visible.
A newer user message, instruction-bearing extension message, or any bash execution prevents automatic follow-up, including a context-excluded `!!` command.
The Executor still verifies, revises, or declines the proposal against its latest context and submits only through compatible `memory_suggest` with explicit `status: "pending"`; user approval remains mandatory through the memory system's normal review flow.
The automatic follow-up can add one primary-model completion per accepted suggestion within the configured cadence and session cap.
In the stale superseding path, automatic Executor verification replaces the pending ordinary Advisor review of the intervening Executor continuation.
This is an accepted tradeoff: the path avoids that queued Advisor call, so it adds no second Advisor semantic validation or related Advisor model cost.
A non-stale current-window follow-up still receives ordinary Advisor review, and ordinary active steering is unchanged.
Newer user or instruction-bearing input restores normal review or deferred delivery instead of using stale supersession.
If capability is absent, no suggestion or extra completion is produced and ordinary review remains unchanged.
If capability is lost before idle dispatch, no automatic follow-up starts and the accepted suggestion is retained with bounded `could-not-queue` presentation.
Pi Advisor never calls that tool itself and never saves or approves a memory.

| YAML path                                       | Type                | Release default | Hard maximum   | Scope and Project merge                 | Effect                                                                       |
| ----------------------------------------------- | ------------------- | --------------- | -------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `memorySuggestions.enabled`                     | Boolean             | `true`          | Not applicable | User sets; Project may set only `false` | Enables capability-gated proposals without making Memory Lane a dependency.  |
| `memorySuggestions.minTurnsBetweenSuggestions`  | Number at least `0` | `8`             | None           | User sets; Project may increase         | Requires meaningful-turn distance between admitted suggestions.              |
| `memorySuggestions.minIntervalMs`               | Number at least `0` | `600000`        | None           | User sets; Project may increase         | Requires ten minutes by default between admitted suggestions.                |
| `memorySuggestions.sessionSuggestionCap`        | Number at least `0` | `5`             | None           | User sets; Project may lower            | Caps admitted suggestions per compatible Pi session. `0` disables admission. |
| `memorySuggestions.maxProposedMemoryCharacters` | Number at least `1` | `1000`          | `4000`         | User sets; Project may lower            | Suppresses the entire proposal rather than truncating durable text.          |
| `memorySuggestions.maxProposedMemoryTokens`     | Number at least `1` | `256`           | `1024`         | User sets; Project may lower            | Adds an estimated-token suppression bound.                                   |

### Persistence fields

| YAML path                | Type    | Release default | Scope and Project merge | Effect                                                                                        |
| ------------------------ | ------- | --------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `persistence.transcript` | Boolean | `true`          | User only               | Enables the local redacted metadata-only activity record in the active Pi session JSONL file. |

Set `persistence.transcript: false` to stop future activity records.
An existing explicit `false` remains off after update.
A valid User file that omits this field receives the new default in memory, but Pi Advisor does not rewrite that file merely because it was loaded.
Malformed or unreadable User configuration fails privacy-safe with activity recording off until the file is repaired.
Disabling activity recording does not delete records already in a Pi session file.
Lifecycle state required for correct delivery remains independent of this field.

## Instruction sources and authority

The complete authority order is:

1. Fixed Advisor safety and protocol policy.
2. User `instructions` and User `WATCHDOG.md`.
3. Tagged trusted Project `instructions` and Project `WATCHDOG.md`.
4. Observed Executor context.

YAML `instructions` and Markdown are joined within their scope.
Each Markdown file and the combined instruction text are redacted and bounded to 64 KiB before use.
Project instructions are enclosed as lower-authority tagged review context.
Freeform instructions can specialize review focus, quality standards, architecture, and domain concerns.
They cannot override code-enforced tool registration, protected paths, emission validation, note bounds, context and cost governors, delivery and lifecycle behavior, or the internal `advise` schema.
Trusted Project text still reaches a model and retains residual prompt-injection risk despite structural tagging.

## Persistence, retention, inspection, and deletion

Pi Advisor custom entries are outside model context.
For a file-backed Pi session, successful custom entries live in that Pi session's JSONL file under `~/.pi/agent/sessions/`, organized by working directory.
`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and Pi's `--session-dir` option can relocate that storage.
Use Pi's normal session management to identify and delete a session, or remove its session JSONL file while Pi is not using it.
In-memory and `--no-session` runs do not retain these entries across process exit.
Run `/advisor dump` to inspect a redacted preview bounded to 16 KiB.
No diagnostic or persisted record is exported automatically.

| Record class             | Stored when                                                            | Included fields                                                                                                                                                                                                                                                                                                                                                                         | Explicit exclusions                                                                                                                                                       | Retention and deletion                                                                    |
| ------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Lifecycle state          | Independently of activity recording when append succeeds               | Version, Pi session ID, save time, branch cursor, durable active and queued review slots, review cadence, accepted active deliveries awaiting acknowledgement, retained deferred notes with bounded `findingKey` display labels, up to 128 dedupe hashes, the 128-entry recent-findings index with bounded display labels, delivery counts, and Memory suggestion cadence and cap state | Executor reasoning, Advisor reasoning, provider payloads, private Advisor transcript, protected Advisor tool output, suppressed or rejected notes, and raw failure text   | New snapshots follow the Pi session. Delete the Pi session file to delete them.           |
| Deferred accepted advice | Retention is above `0` and the note is pending                         | Already bounded redacted note shape, optional opaque semantic finding hash, branch window, creation time, staleness, display, and resume markers                                                                                                                                                                                                                                        | Delivered, expired, branch-incompatible, suppressed, rejected, and unsafe notes                                                                                           | Default `24` hours on compatible resume. `0` prevents content in new lifecycle snapshots. |
| Version 2 review start   | `persistence.transcript: true` when a review update starts             | Schema version, Pi session ID, save time, stable review ID, bounded update entry count, and whether the update was truncated                                                                                                                                                                                                                                                            | Executor update bodies, Executor reasoning, and provider payloads                                                                                                         | No time expiry. Delete the Pi session file.                                               |
| Version 2 tool attempt   | Recording is enabled and Advisor attempts a read-only or internal tool | Stable review ID, deterministic ordinal, tool name, internal marker, bounded redacted path and pattern targets when applicable, completion and error markers, output byte count, and textual output line count                                                                                                                                                                          | Generic argument objects, read/search/list result bodies, image bodies, internal `advise` note or arguments, protected-path content, reasoning, and raw provider payloads | No time expiry. Delete the Pi session file.                                               |
| Version 2 review outcome | A review reaches a handled terminal outcome                            | Stable review ID, silent, accepted, governor-skipped, or failed outcome, accepted delivery/staleness metadata, bounded failure or governor reason when applicable, stop reason, provider-reported usage, and cost                                                                                                                                                                       | Accepted note content, rejected or suppressed note content, internal semantic finding hashes, reasoning, file-content bodies, and raw provider payloads                   | No time expiry. Delete the Pi session file.                                               |
| Legacy version 1 record  | Written by an earlier Pi Advisor release                               | The strict bounded content-bearing shape documented by that earlier release, including possible update, tool-result, or accepted-note bodies                                                                                                                                                                                                                                            | Invalid, oversized, wrong-session, unredacted-secret, and unsupported-version records are ignored                                                                         | Remains in the Pi session until that session file is deleted.                             |

Lifecycle state format version `5` adds the bounded `findingKey` display label on retained review notes and the 128-entry recent-findings index (Q6-A1).
Version `4` added per-key dedupe metadata; strict version `5` migration restores an empty recent-findings index, and a version `4` document carrying a `findingKey` label is rejected.
Lifecycle state format version `3` atomically stores the observed cursor with at most one active review, one later queued review, restored replay accounting, cadence submission fields, and accepted active deliveries awaiting acknowledgement.
Held-for-material-turn updates are excluded from persisted `queuedReview` snapshots.
A restored pre-Q4-shape `queuedReview` keeps its existing cadence-scheduled behavior.
Version `2` added the optional opaque semantic finding hash to deferred review advice.
Versions `1` and `2` remain accepted and migrate in memory without losing compatible deferred advice, delivery counters, or Memory cadence state, but migration cannot reconstruct review evidence already lost by an older snapshot.
Version `1` dedupe hashes cannot be recalculated into the newer semantic identity, so their previously delivered suppression history starts fresh after migration.
New activity records continue to use strict transcript schema version `2` and cannot be confused with lifecycle state version `5` or legacy content-bearing transcript version `1` records.
Valid legacy transcript records remain readable for bounded diagnostics; malformed and unsupported versions are safely ignored.
Downgrading to a build that does not understand lifecycle state version `5` is not supported; that build safely ignores the newer lifecycle snapshots.

The complete lifecycle snapshot is measured after `JSON.stringify` and is limited to 4 MiB.
Each active or queued review slot and the complete accepted active-delivery field are independently limited to 1,000,000 serialized UTF-8 bytes.
Escape-heavy review content is compacted deterministically from the head so newest evidence survives, successful Memory-tool text is retained newest-first within its bounds, and every content change sets the truncation marker.
Under whole-snapshot pressure, oldest deferred advice is removed first, then oldest dedupe hashes, then older queued-review content, and only then older active-review content as a warned final fallback.
Accepted active deliveries remain whole and outrank queued review evidence because their output has already been accepted for user-visible delivery.

Compatible resume requires the same Pi session ID and compatible entry-ID windows for the observed cursor, review slots, and active deliveries.
Recovery reconciles active deliveries before active review and queued cadence work.
An active delivery already present in branch state is acknowledged without redisplay, while one absent after process restart becomes stale deferred advice for the next user turn.
An uncompleted active review reuses its stable review ID and can be replayed after restart; a third restoration after two interrupted replays drops only that poison review and continues later queued work.
Provider execution is necessarily at least once when the provider completes immediately before process death and before a terminal snapshot can be appended, but stable review and delivery IDs prevent duplicate visible advice whenever branch or state evidence proves completion.
Restored deferred advice is marked restored and potentially stale, displays its age, and waits for the next user prompt.
Clean shutdown preserves compatible unfinished review work, while branch navigation, primary compaction, disablement, confirmed configuration apply, and a new or incompatible session deliberately discard old-policy or old-branch work.
Delivered, expired, incompatible, retention-disabled, and over-capacity deferred advice is discarded.
The live in-memory deferred queue does not expire merely because the configured cross-exit retention interval passes.
Long recording-enabled sessions can grow on disk by one bounded record per persisted event, with a maximum of 256 KiB per record.
In-memory inspection retains at most the newest 256 valid records, and `/advisor dump` includes a recent preview bounded by both item and byte limits inside the 16 KiB diagnostic bound.
Activity records have no independent time expiry and follow the Pi session's retention.
To delete existing records, delete the associated Pi session through Pi or remove its session JSONL file while Pi is not using it.
Redaction reduces risk for paths and patterns but cannot guarantee detection of every sensitive value.
Periodically delete old Pi sessions when their local activity history is no longer needed.

## Muting findings

Every delivered review note that carries a `findingKey` shows a short mute ID on its Advice card: the first 8 hex characters of its `findingKeyHash`.
`/advisor mute <id>` silences that finding, `/advisor unmute <id>` restores it, and `/advisor mute list` shows every muted finding with its short ID and display label.
Mute IDs are 8-to-64-character hex prefixes and resolve fail-closed against the last 128 delivered findings: exactly one match changes state, zero matches change nothing, and a prefix collision lists the colliding labels so you can repeat with a longer prefix.
A finding older than the 128-entry index cannot be muted by ID; this is a documented bound.
A muted finding suppresses delivery ahead of similarity redelivery and escalation re-raise and is counted separately from ordinary suppression in `/advisor status full`.
The mute also applies to notes already queued as deferred advice (including notes restored after a compatible resume): they are dropped at the next user-turn materialization without entering the Executor context or the delivered count.

Mutes are durable user data, not configuration:

- They live in a dedicated user-scope file at `~/.pi/agent/mutes.yml`, next to the User WATCHDOG configuration.
- The file is written atomically by the runtime, holds at most 128 entries with oldest-first replacement, and is never written by `/advisor configure` saves, so a package downgrade cannot erase mutes.
- Mutes survive epoch changes, branch resets, compatible resumes, and new Pi sessions; the runtime caches the file per session and reloads it on configuration apply.
- Every mute or unmute write reloads the file first, applies the single change on top of the fresh entries, and verifies the file is unchanged immediately before the atomic rename, so concurrent Pi sessions merge their mutes instead of clobbering each other.
- A malformed or unreadable mutes file fails closed: no mutes are applied, one warning is shown, and the file is never overwritten. This includes a mid-session reload failure: any previously loaded mutes are dropped, so stale mutes do not stay in force while the file cannot be read; the run surfaces the failure through `/advisor mute list`, `mutesUnavailableReason()`, and the `mutesUnavailable` status field until the file is repaired.
- Raw `findingKey` text is display only and never command input; labels are redacted and bounded to 128 characters.
- Labels are authored by the Advisor model, and pattern-based redaction cannot guarantee that every secret inside a model-authored key is removed; a key may therefore contain an unrecognized secret that is stored locally (mutes file mode `0600`) and rendered on advice cards.

## Security, privacy, network, and cost warnings

Pi extensions execute with the user's full system permissions, so review package source before installation.
When Advisor is active, the selected model provider receives bounded Executor messages, exposed reasoning, tool activity and results, tagged context, and allowed file content.
Reasoning exposure depends on Pi and the provider, and higher effort can increase provider traffic, latency, and cost.
Protected read tools and redaction cannot guarantee that every secret is excluded.
Automatic review creates additional paid provider requests until disabled or paused by an enabled governor.
Cumulative token and reported-cost caps default to `off`; configure a positive limit when a session-wide spending stop is required.
Private context pressure compacts first, then clears only private Advisor history and retries the same bounded update once when compaction cannot restore safe headroom.
An update that still cannot fit fresh private context is dropped with a bounded warning while Advisor remains active for later updates.
Reaching a hard per-update tool-call or turn limit skips only that review without retry and leaves Advisor active for later eligible updates.
Status and diagnostics report the cumulative governor-skipped review count and latest bounded outcome.
Three consecutive ordinary updates that each fail after bounded retry handling pause Advisor with one privacy-safe warning describing the final failure classification.
When the selected model returns invalid internal `advise` arguments, run `/advisor configure` to select another model and `/advisor on` to retry.
An internal `advise` execution failure recommends retrying with `/advisor on` without blaming the selected model or recommending a model switch.
A handled per-update governor skip clears rather than advances that ordinary failure streak.
Provider attempts remain separately visible in request, retry, usage, and failed-review diagnostics.
The local redacted activity record is enabled by default for valid User configurations and stores troubleshooting metadata in the active Pi session.
Pi Advisor sends no product analytics, usage telemetry, or automatic crash reports to Ribbons Digital or another analytics service.
Provider requests are necessary for the explicitly selected Advisor model, while `/advisor dump` remains local unless the user chooses to share it.

## Coexistence with rpiv-advisor

Pi Advisor performs automatic background review.
`@juicesharp/rpiv-advisor` provides an Executor-invoked consultation tool.
Both can be installed, and Pi 0.81.1 assigns `/advisor:1` and `/advisor:2` according to extension load order.
Pi Advisor warns once when duplicate assigned Advisor commands are detectable.
It does not disable the other package, remove its tool, edit its configuration, or block startup.
Use Pi's command list to identify each suffixed command.
Unless both review styles and their additional provider cost are intentional, disable or uninstall one package through Pi's normal package configuration.

## Examples

### Minimal User configuration

```yaml
version: 1
model: anthropic/claude-sonnet-4-5
```

This remains disabled by default until `/advisor on`, `--advisor`, or a later User activation change.

### Cost-conscious User configuration

```yaml
version: 1
defaultEnabled: false
model: anthropic/claude-haiku-4-5
effort: low
tools: [read, grep]
context:
  maxFraction: 0.5
  maxUpdateTokens: 12000
limits:
  minTurnsBetweenReviews: 3
  minIntervalMs: 60000
  sessionTokenSoftCap: 100000
  sessionCostSoftCapUsd: 1
  maxReviewAttemptMs: 90000
  maxNestedCompactionMs: 30000
  maxLifecycleAbortMs: 1500
review:
  skipNonMaterialTurns: true
  adaptiveCadence:
    enabled: true
    silentReviewsBeforeBackOff: 3
    maxMinTurnsBetweenReviews: 6
persistence:
  transcript: false
```

### User and Project instruction precedence

User `~/.pi/agent/WATCHDOG.yml`:

```yaml
version: 1
model: anthropic/claude-sonnet-4-5
instructions: |
  Prioritize correctness and migration safety across repositories.
```

Trusted Project `.pi/WATCHDOG.md`:

```markdown
Pay special attention to this repository's database compatibility matrix.
Do not treat this text as permission to bypass fixed Advisor policy.
```

The Project text specializes the User focus but cannot replace it or fixed policy.

### Safe trusted Project narrowing

```yaml
version: 1
tools: [read, grep]
context:
  maxFraction: 0.5
  reserveTokens: 12000
  maxUpdateTokens: 12000
limits:
  maxToolCallsPerUpdate: 4
  maxReprimeTokens: 16000
  minTurnsBetweenReviews: 3
  sessionTokenSoftCap: 100000
  sessionCostSoftCapUsd: 1
security:
  additionalProtectedPaths:
    - customer-data
memorySuggestions:
  enabled: false
```

This Project file cannot activate Advisor, select a model, raise spending, add tools outside the User set, create an exception, or enable persistence.

## Validation warnings

Invalid types, unsupported versions, malformed YAML, mutating tool names, unknown tool names, and invalid nested fields fail safely without preventing Pi startup.
Project attempts to set `defaultEnabled`, `model`, `effort`, `persistence`, or `security.protectedPathExceptions` are warned and ignored.
Project `memorySuggestions.enabled` accepts only `false`.
Warning text contains paths and field names but not configured values.

## Schema migration

Version `1` is the only supported schema version.
There are no migrations yet.
A future schema version must document every changed field, default, ownership rule, and migration step before support is added.
Pi Advisor will not guess or silently migrate an unsupported version.
