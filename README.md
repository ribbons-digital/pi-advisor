# Pi Advisor

Automatic, isolated secondary review for [Pi](https://pi.dev).

Pi Advisor observes meaningful completed turns from your primary Pi agent, called the Executor, and reviews them with a separate model that you choose.
It stays silent when work is sound and delivers a bounded, actionable note when it finds a material correctness, safety, verification, or workflow issue.

> [!WARNING]
> Pi extensions run with your full system permissions.
> Review this package before installing it.
> When Advisor is active, it sends bounded session content and allowed file content to the model provider you select, which can create additional usage and cost.

> [!IMPORTANT]
> Pi Advisor 0.4.0 requires Pi (`@earendil-works/pi-coding-agent`) **>=0.81.1 <0.85.0**.
> Pi 0.82.0 is the primary tested Pi release, with compatibility coverage retained for Pi 0.81.1, Pi 0.83.0, and Pi 0.84.1.
> Pi 0.80.x is not supported by this release.
> On Pi 0.80.7, install the pinned legacy release `npm:@ribbons-digital/pi-advisor@0.1.3` instead.

![Pi Advisor surfaces a concern about stale cache data after reviewing an Executor response](docs/assets/advisor-in-action.png)

_Pi Advisor reviewing a synthetic cache implementation in a privacy-safe demo session._

## Features

- Automatic review without relying on the Executor to request it.
- One explicitly selected Advisor model with no fallback to the Executor model.
- Isolated Advisor conversation state that does not enter the Executor context.
- Silence-first review with at most one bounded visible note per update.
- Active, deferred, restored, and potentially stale delivery states.
- Protected and bounded `read`, `grep`, `find`, and `ls` tools, with no mutating Advisor tools.
- Context, update, tool-call, turn, pending-byte, and opt-in cumulative token and reported-cost governors.
- Branch, compaction, session replacement, retry, and compatible-resume handling.
- Optional capability-based Memory suggestions without a [Memory Lane](https://github.com/ribbons-digital/memory-lane) dependency.
- Local redacted activity records enabled by default, with metadata-only review, tool-order, outcome, usage, and cost details.
- No product telemetry or automatic crash reporting.

## Requirements

- Node.js >=22.19.0.
- Pi (`@earendil-works/pi-coding-agent`) >=0.81.1 <0.85.0.

Declared compatibility range: >=0.81.1 <0.85.0

Primary tested Pi release: 0.82.0

Compatibility-tested Pi releases: 0.81.1, 0.83.0, and 0.84.1

Pi 0.80.x is not compatible with Pi Advisor 0.4.0.
Pi Advisor 0.1.3 is the legacy release for Pi 0.80.7.
Missing capabilities, unavailable models, missing credentials, or unverifiable provider parity leave Advisor inactive without fallback.

## Install

Install the unpinned npm package through Pi:

```sh
pi install npm:@ribbons-digital/pi-advisor
```

Using the unpinned package source allows Pi to install future compatible releases through its normal extension update process.

To try Pi Advisor for one run without installing it:

```sh
pi -e npm:@ribbons-digital/pi-advisor
```

## Configure and enable

Start Pi and run:

```text
/advisor configure
```

The configuration flow selects an authenticated model, an independent Advisor reasoning level, approved read-only tools, and User instructions.
Advisor reasoning choices are derived from the selected model's supported levels, and unsupported levels are omitted.
A model without reasoning support offers only `off`.
If the current Advisor reasoning level is unsupported by the selected model, the flow warns and requires a new supported selection.
On Pi 0.82, the reasoning prompt also shows the current Executor reasoning level as supplementary context, but the Advisor selection remains independent and is not automatically coupled to it.
The Pi 0.81 compatibility path omits that supplementary Executor text without changing configuration behavior.
In the TUI, the model picker is focused immediately and fuzzy-searches provider, model ID, and display name as you type; RPC clients retain their standard selection dialog.
It shows a summary and asks for confirmation before atomically saving `~/.pi/agent/WATCHDOG.yml`.
If that path is a symlink, the save writes through to the target file and leaves the link in place.

Then enable Advisor for the current session:

```text
/advisor on
```

Pi Advisor never selects a model automatically.
The installed default remains disabled until you explicitly configure and enable it.

A minimal manual configuration is:

```yaml
version: 1
model: anthropic/claude-sonnet-4-5
effort: high
defaultEnabled: false
```

Save it as `~/.pi/agent/WATCHDOG.yml`, then run Pi `/reload` before enabling Advisor.
See the [complete configuration reference](docs/configuration.md) for every field, default, ownership rule, security and cost effect, and trusted Project configuration example.

## Commands

| Command                            | Effect                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/advisor` or `/advisor configure` | Opens a section menu (model and reasoning, tools, instructions, apply, cancel) in a dialog-capable TUI or RPC client.                     |
| `/advisor on`                      | Enables Advisor for the current session without changing the persisted default.                                                           |
| `/advisor off`                     | Disables Advisor for the current session and invalidates in-flight review work.                                                           |
| `/advisor status`                  | Shows a short summary: state, model and effort, queued reviews, note counts and last note, session spend and caps, and Memory capability. |
| `/advisor status full`             | Shows the complete activation, model, backlog, context, usage, cost, delivery, persistence, and failure status.                           |
| `/advisor mute <id>`               | Silences a delivered finding by its 8-to-64-character hex ID (shown on the Advice card).                                                  |
| `/advisor unmute <id>`             | Removes a mute by the same prefix rule; `/advisor mute list` shows the muted findings.                                                    |
| `/advisor mute list`               | Lists each muted finding with its short ID and display label.                                                                             |
| `/advisor dump`                    | Produces an explicit redacted diagnostic snapshot bounded to 16 KiB.                                                                      |
| `--advisor`                        | Requests activation for the launched Pi session, including JSON and print modes.                                                          |

Persisted `defaultEnabled: true` applies only to new TUI and RPC sessions.
JSON and print runs always require explicit activation.

## Upgrade

Upgrade installed Pi packages, including an unpinned Pi Advisor installation, with:

```sh
pi update --extensions
```

To update only Pi Advisor:

```sh
pi update npm:@ribbons-digital/pi-advisor
```

A version-pinned source such as `npm:@ribbons-digital/pi-advisor@0.1.3` is intentionally skipped by package updates.
Install the unpinned source shown above if you want normal extension updates.

## Uninstall

Remove Pi Advisor through Pi:

```sh
pi remove npm:@ribbons-digital/pi-advisor
```

Uninstallation removes the package from Pi settings and package storage.
It does not delete your User WATCHDOG files or existing Pi session files.
Remove `~/.pi/agent/WATCHDOG.yml` and `~/.pi/agent/WATCHDOG.md` yourself if you no longer want the configuration.
Delete affected Pi sessions through Pi or remove their session JSONL files while Pi is not using them if you also want to delete previously persisted lifecycle or local activity records.

## How review and delivery work

Advisor reviews meaningful completed Executor turns in a separate in-memory Pi session.
It prioritizes current implementation evidence such as code, UX, cancellation, atomicity, tests, safety, correctness, and scope.
Advisor normally keeps verification lean, using only a few read-only checks before advising or remaining silent.
It investigates more deeply only when current evidence identifies a concrete critical risk.
Recalled memories, handoffs, summaries, and historical process text are subordinate supporting evidence rather than independent sources of active obligations.
The latest explicit user request controls the active workflow unless it invokes a historical process, and an equivalent current workflow does not need to use a remembered process or skill name.
Workflow or gate advice is checked against recent Executor actions, tool results, and review results before delivery, and repeated findings can be suppressed by semantic identity.
The Advisor model must use one `findingKey` for paraphrases or severity changes of exactly one concrete defect and a different key for every materially different defect.
The key, rather than note wording or severity, is authoritative for semantic suppression, so incorrect model key reuse can suppress a distinct note.
A reused key still delivers a materially dissimilar note as a possible duplicate (64-bit SimHash similarity below the configured threshold), and a persisting defect re-delivers as re-raised when its severity strictly increases after the configured turn distance.
Only an accepted Advisory note enters the Executor context.
Private Advisor reasoning, rejected notes, duplicate notes, content-free responses, and ordinary silent reviews remain outside the Executor context.

## Muting a finding

Every delivered review note that carries a `findingKey` shows a short mute ID on its Advice card: the first 8 hex characters of the findingKeyHash.
`/advisor mute <id>` silences that finding, `/advisor unmute <id>` restores it, and `/advisor mute list` shows every muted finding with its short ID and display label.
Mute IDs resolve fail-closed against the last 128 delivered findings: a unique prefix mutes or unmutes exactly one finding, zero matches change nothing, and a prefix collision lists the colliding labels so you can repeat with a longer prefix.
A muted finding suppresses delivery ahead of similarity redelivery and escalation re-raise and is counted separately from ordinary suppression.
Mutes are durable user data in a dedicated file next to the User WATCHDOG configuration (`~/.pi/agent/mutes.yml`), survive resets, resumes, and new sessions, and are never touched by `/advisor configure` saves or package downgrades.

Advice created during an active run reaches Pi's next steering boundary and does not abort a running tool.
Ordinary late or interruption-time advice waits for the next user-driven turn without triggering another completion.
An eligible Memory suggestion that arrives while the Executor is idle starts one automatic Executor follow-up when no newer user or instruction-bearing input has superseded its evidence window.
Newer Executor assistant text does not prevent that follow-up, and a continuation with materially newer Executor activity (a non-read-only tool call or its result, or a compaction or branch-summary entry) still does not prevent it even though the suggestion is then marked potentially stale.
Any newer user message, instruction-bearing extension message, or bash execution blocks automatic follow-up, including a context-excluded `!!` command.
The Executor must verify, revise, or decline the suggestion against its latest context and can submit only through a compatible `memory_suggest` tool with explicit `status: "pending"`.
The automatic follow-up can add one primary-model completion per accepted Memory suggestion, bounded by the configured cadence and session cap.
An idle accepted review note whose severity is listed in `delivery.activeIdleSeverities` (release default `[blocker]`) starts one automatic Executor follow-up with the same newer-instruction-input guard, a fixed session cap of five follow-ups per session with deferred fallback, and a structural no-chain rule: while a review follow-up is pending, its own continuation is not reviewed and no new review follow-up can dispatch.
In the stale superseding path, automatic Executor verification replaces the pending ordinary Advisor review of the intervening Executor continuation.
This is an accepted tradeoff: the path avoids that queued Advisor call, so it adds no second Advisor semantic validation or related Advisor model cost.
A non-stale current-window follow-up still receives ordinary Advisor review, and ordinary active steering is unchanged.
Newer user or instruction-bearing input restores normal review or deferred delivery instead of using stale supersession.
The memory remains pending until the user approves or rejects it through the memory system's normal review flow.
If compatible capability is absent, no Memory suggestion is produced and ordinary review is unchanged; if capability is lost before idle dispatch, no follow-up starts and the accepted suggestion is marked `could-not-queue` for bounded later presentation.
Advice is marked potentially stale only when the Executor produced materially newer activity after the reviewed window: a non-read-only tool call or its result, a context-included user bash execution, or a compaction or branch-summary entry.
User messages, plain assistant text, read-only tool calls and their results, and extension context never mark advice stale on their own, so the user prompt that triggers deferred materialization does not stale the emitted note.
Restored advice still requires fresh verification.
Every Advisor card has a severity-colored left border so it remains visually distinct from native tool-call cards; Memory suggestion cards use the Advisor accent color.
Cards render compact Markdown so a short lead stays above the supporting detail, and numbered or bullet actions stay on separate lines.
While a review is in flight, the TUI footer shows a spinner next to `Advisor reviewing`.
Queued work stays static and shows the queued review count, for example `1 review queued`.
Byte-level backlog detail remains in `/advisor status full`.

## Security, privacy, and cost

When Advisor is active, the selected model provider may receive bounded versions of:

- User and assistant messages.
- Exposed Executor reasoning when Pi or the provider supplies it.
- Tool calls and tool results.
- Branch and compaction summaries.
- Pi-supplied project context.
- Content returned by allowed Advisor read-only tools.

Observed Executor content and Pi-supplied context are redacted before budgeting and submission.
Allowed read-only tool results are bounded but are not transcript-redacted before the selected provider receives them.
Protected paths and redaction reduce risk but cannot guarantee that every secret is excluded.
Secrets can exist in ordinary source files, generated output, hard-link aliases, archives, databases, or content changed during a concurrent filesystem race.
See [Security](docs/security.md) for the protected targets, tool bounds, controls, and residual risks.

Automatic review creates additional provider requests, latency, token usage, and cost.
In-flight reviews that have not started `advise` are superseded when a newer meaningful update arrives, so Advisor spends the remainder of that attempt on the coalesced newer window instead of finishing a stale review.
`review.skipNonMaterialTurns` can hold purely conversational turns until later material Executor activity, and `review.adaptiveCadence` can widen the minimum turn distance after consecutive silent reviews.
Both options default off.
Held-for-material-turn evidence is not restored across resume.
Cumulative session token and reported-cost caps default to `off`, while complete lifetime usage remains visible in `/advisor status`.
An explicitly configured positive cap pauses only Advisor and never interrupts the Executor.
A trusted Project may add or lower a finite cap but cannot remove or raise a finite User cap.
Provider usage or pricing can be missing or incomplete, so explicitly enabled token and dollar caps remain independent safeguards.

Advisor estimates its private context before each bounded update and asks Pi's public nested `AgentSession.compact()` API to compact when needed.
If compaction fails or remains unsafe, Advisor clears only its private nested history and retries the same current bounded update once without replaying the full Executor branch.
If that update still cannot fit fresh context, Advisor drops only that update, warns, and remains active for later updates.
Reaching the hard per-update tool-call, turn, or review-attempt time limit skips only that review without retrying it, and automatic review continues with later eligible Executor updates.
Nested review and nested compaction are bounded by `limits.maxReviewAttemptMs` and `limits.maxNestedCompactionMs`. Host compact and tree navigation signal Advisor abort and return immediately. Disable, shutdown, and the next review bound nested abort waits with `limits.maxLifecycleAbortMs` so those paths cannot hang on a provider that ignores abort.
Accepted review advice retains its existing bounded delivery behavior, while provisional Memory suggestions from the rolled-back attempt remain discarded.
`/advisor status` reports the cumulative governor-skipped review count and latest bounded outcome.
Three consecutive ordinary updates that each exhaust their retry path pause Advisor with one warning that includes the final bounded, secret-redacted failure reason; handled per-update governor exhaustion clears rather than advances that streak.
Three consecutive review attempts that each time out pause Advisor with one warning; the timeout streak is tracked separately from the ordinary failure streak and resets after a successful review or an explicit budget reset, so repeated timeouts fail closed instead of starting later reviews while earlier provider requests remain in flight.
Branch, session, and confirmed configuration resynchronization may use one bounded branch snapshot, but an unsafe lifecycle snapshot degrades to the current bounded update instead of pausing Advisor.

Pi Advisor writes bounded lifecycle state as Pi custom entries outside model context when required for correct compatible resume and delivery.
The local redacted activity record is controlled by `persistence.transcript` and is enabled by default for valid User configurations.
Set `persistence.transcript: false` to stop future activity records; an existing explicit `false` remains off after update, and loading does not rewrite the User file.
Malformed or unreadable User configuration fails privacy-safe with activity recording off until the configuration is repaired.
New version 2 activity records contain review identifiers, update counts, ordered tool metadata, redacted bounded targets, completion and output-size metadata, final outcome, usage, cost, and stop reason.
They never contain Executor update bodies, file-tool result bodies, Advisor or Executor reasoning, internal `advise` arguments or notes, raw provider payloads, protected-path content, or rejected or suppressed note content.
Older valid version 1 records may contain the bounded content stored by earlier releases and remain visible as legacy records in `/advisor dump`.
Disabling future records does not delete existing records.
See [Configuration: persistence, retention, inspection, and deletion](docs/configuration.md#persistence-retention-inspection-and-deletion) for exact stored and excluded fields, retention, and deletion instructions.

## Telemetry and diagnostics

Pi Advisor sends no product analytics, usage telemetry, or automatic crash reports to Ribbons Digital or another analytics service.
Network requests to your explicitly selected model provider are necessary while Advisor is active.
`/advisor dump` is local, explicit, redacted, bounded, and never exported automatically.

## Coexistence with rpiv-advisor

[`@juicesharp/rpiv-advisor`](https://www.npmjs.com/package/@juicesharp/rpiv-advisor) provides Executor-invoked consultation.
Pi Advisor provides automatic background observation.

Both packages register `/advisor`.
Pi 0.81.1 assigns `/advisor:1` and `/advisor:2` in extension load order when both are installed.
Pi Advisor warns once when duplicate assigned commands are detectable and does not disable or modify the other package.
Use Pi's command list to identify each suffix.
Unless you intentionally want both review styles and their additional provider cost, disable or uninstall one package.

## Scope and compatibility differences

Pi Advisor intentionally:

- Supports one Advisor rather than multiple Advisors.
- Uses Pi-native User and trusted Project WATCHDOG paths rather than OMP `.omp` paths.
- Uses Pi's `find` tool rather than an OMP-style `glob` tool.
- Delivers active advice at Pi's next assistant boundary instead of hard-interrupting a running tool.
- Coalesces bounded backlog instead of blocking the Executor until review catches up.
- Keeps mutating Advisor tools and destructive-command interception out of scope.
- Provides a Pi-native configuration flow rather than a fullscreen multi-pane editor.
- Uses Pi's public nested `AgentSession.compact()` behavior rather than OMP's private in-memory LLM-summary implementation.
- Does not perform OMP context-model promotion because Pi exposes no equivalent public policy primitive for this nested runtime.

## Public documentation

- [Configuration reference](docs/configuration.md)
- [Security](docs/security.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Attribution

Pi Advisor is an independently implemented extension inspired by OMP's automatic Advisor design.
It is not affiliated with, endorsed by, or maintained by OMP, `@juicesharp/rpiv-advisor`, Pi, or their maintainers.
See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for dependency and upstream acknowledgements.

## License

MIT
