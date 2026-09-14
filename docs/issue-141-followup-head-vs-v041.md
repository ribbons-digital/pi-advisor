# Follow-up measurement: current HEAD vs tagged v0.4.1 (issue #141)

**Status: directional / insufficient for the merge gate in comment 5518416233. Do not treat the numbers below as a pass.**

Paste-ready for <https://github.com/ribbons-digital/pi-advisor/issues/141#issuecomment-5518416233>.

Date: 2026-09-14. Protocol: `accuracy-experiment-v1`. Full-corpus live run (not the 12-item probe).

Bar vs this run:

| Gate                            | Bar                                                                                          | This run                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Independent finding cases       | 30                                                                                           | **9** `toolresult` items (27 paired rows after 3 reps); finding and silence share the same 9 sessions                 |
| Independent silence cases       | 30                                                                                           | **9** `clean` items (**26** paired rows: HEAD `ctx-02-clean` new rep 2 is `run-error`)                                |
| Reps per case per configuration | ≥5                                                                                           | **3**                                                                                                                 |
| History-only finding recall     | +10pp vs a baseline that still scores the same cases as **finding** (miss if truncated away) | **not measured** — this corpus is arm-fair, so v0.4.1 tail rows are `expected=silence` and have no recall denominator |
| Visible-window recall / FP CIs  | 95% paired, must sit inside the recorded margins                                             | toolresult recall looks stronger; **FP CI does not stay inside ±5pp**; floors unmet anyway                            |

`+59pp` toolresult recall is exploratory evidence on a 9-session injection corpus, not satisfaction of the gate. Tail 17/27 is a **retention/detection diagnostic** on the arm that can see the marker, not a history-only recall delta.

## What was compared

Not a single-knob no-reasoning A/B. Both sides used the **live** User WATCHDOG instructions and `run-accuracy.ts --prompt-variant prod`.

|           | Current HEAD                                                                                                              | Tagged v0.4.1                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tree      | `3917c5f` (`main` at run time)                                                                                            | `362e212` (`v0.4.1`, detached worktree)                                                 |
| Render    | `includeReasoning: false` (`PI_ADVISOR_NO_REASONING` default on)                                                          | always-reasoning (`renderAdvisorDelta` is 2-arg; extra `{includeReasoning}` is ignored) |
| Prompt    | production `buildAdvisorSystemPrompt` (5266 chars with live instructions; includes later scoped + coverage / posind text) | v0.4.1 production prompt (3744 chars with the **same** live instructions)               |
| Harness   | HEAD `scripts/f9-experiment`                                                                                              | same HEAD harness copied into the worktree; `src/` stays v0.4.1                         |
| Arm spent | `--arms new` only                                                                                                         | `--arms old` only                                                                       |

v0.4.1's `new` arm is **not** a no-reasoning sample. Spending both arms there would double cost for an identical always-reasoning render.

## Corpus and identity

- Corpus: gitignored `docs/internal/accuracy-corpus.jsonl` — 36 items = 9 source cuts × 4 injection zones (`clean`, `reasoning`, `toolresult`, `tail`). Signature: `INJECTED_DEFECT_audit_v7_downgrade_14_203_rows_no_backup`.
- Scoring is arm-fair: finding iff that arm's **rendered** window contains the signature.
- `datasetHash` `9e7b6a8a7a1fd06c` (identical on both files). `budgetTokens` 20000. `protocol` `accuracy-experiment-v1`.
- Model: configured `commandcode-goat/deepseek/deepseek-v4-flash`; provider-reported `deepseek/deepseek-v4.1-flash`. `costUsd` is 0 on this proxy (dollar ceiling cannot trip).
- Repeats: 3 per (item, arm). One HEAD row unusable: `ctx-02-clean` new rep 2 `verdict=run-error` (31298 tokens, `stopReason=error`); paired n = 107.

| Artifact                                         | SHA-256                                                            | promptHash         | harnessHash        | sourceCommit   |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------ | ------------------ | -------------- |
| `docs/internal/accuracy-ab-head-prod-full.jsonl` | `580d3c5076f0dfc26af0b45dface7abb2a97c414815f014dab19464e1303b2cc` | `e672f18480c03c20` | `ba9eca120752df4d` | `3917c5f016c6` |
| `docs/internal/accuracy-ab-v041-prod-full.jsonl` | `04069da1aff5da2b56b26e23612bc0b6a94ac64336f102db04654e8ef170f951` | `a9706d4769deb99e` | `bb1f392471716012` | `362e21252746` |

Raw jsonl stays gitignored (real-session derivatives). Tracked copies of this note, the machine summary [issue-141-followup-head-vs-v041.summary.json](issue-141-followup-head-vs-v041.summary.json), and the integration index [accuracy-cost-index.md](accuracy-cost-index.md) (raw vs cleaned rates, per-variant cost, sibling-run pointers) live under `docs/`.

## Cleaning

commandcode-goat emits literal junk notes. **Cleaned** treats these as no-note (not as findings): `placeholder` / `placeholder2`, `y`, `probe (will not be emitted)`, `占位（不应被采纳，用于对照观察）。`.

- HEAD: 16 junk notes / 107 usable.
- v0.4.1: 5 junk notes / 108 usable.

Production `advise` now treats those whole-note placeholders as content-free (same suppression as `looks good`). Live check: 12 `ctx-02` reviews, 4 placeholder notes, 4/4 suppressed by `createAdviseTool`. Historical check: the 16 notes on this HEAD jsonl, 16/16 suppressed when replayed through the executor (not a second live run). Cleaned rates below already counted junk as no-note, so the table does not move. `run-accuracy.ts` still scores the raw tool-call `note` argument, so a later jsonl can still _record_ placeholders even when they would not deliver.

Raw rates are worse for HEAD on silence items because of junk, not because it found more real defects. Prefer cleaned for cross-tree comparison. Do **not** pool `expected=finding` across arms: HEAD findings are `toolresult+tail`; v0.4.1 findings are `reasoning+toolresult`.

## Paired results (cleaned; cluster bootstrap over 9 cuts, seed 20260914, 4000 iters)

**Common strata only** (same visible content on both trees):

| Stratum                                   | HEAD          | v0.4.1        | Δ HEAD−v0.4.1 (95% CI)                                                           |
| ----------------------------------------- | ------------- | ------------- | -------------------------------------------------------------------------------- |
| **Visible finding (`toolresult`) recall** | 26/27 = 96.3% | 10/27 = 37.0% | **+59.3pp [+29.6, +85.2]**                                                       |
| **Silence (`clean`) FP**                  | 19/26 = 73.1% | 20/26 = 76.9% | **−3.8pp [−28.0, +18.5]** (interval includes 0 and exceeds the ±5pp safety band) |

**Arm-specific visibility — diagnostic only; not #141 history-only recall:**

Scoring is finding iff **that arm's rendered window** contains the signature. v0.4.1 tail rows are therefore `expected=silence` (no miss if it stays quiet). HEAD reasoning rows are `expected=silence` (thinking stripped). These strata have no paired recall delta.

| Stratum                                                                      | HEAD                                                      | v0.4.1                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| **`tail` retention diagnostic** — marker kept only after stripping reasoning | detection **17/27 = 63.0%** among windows that contain it | marker not in window; spoke on 15/27 (cleaned FP 55.6%) |
| **`reasoning` render diagnostic** — marker only in thinking blocks           | inject stripped; spoke on 16/27 (cleaned FP 59.3%)        | detection **1/27 = 3.7%** among windows that contain it |

To measure the #141 history-only **recall** gate, rebuild cases that are labeled finding for **both** arms (old arm miss when truncated), from separate sessions, ≥5 reps, with a paired CI. This run did not do that.

## Cost

Provider `costUsd` sum = $0.00 on both files. Estimate uses ollama-cloud list prices for `deepseek-v4.1-flash`: input $0.30 / cache-read $0.006 / output $1.20 per 1M tokens. `inputTokens` is uncached prompt; output = `tokens − inputTokens − cachedTokens`.

|                      | HEAD (107 usable)       | v0.4.1 (108)            | paired Δ  |
| -------------------- | ----------------------- | ----------------------- | --------- |
| Σ tokens             | 3,629,164 (mean 33,917) | 3,627,551 (mean 33,588) | —         |
| cache share          | 61.0%                   | 54.1%                   | —         |
| estimated USD        | **$1.26**               | $1.49                   | —         |
| paired mean tokens   | 33,917                  | 33,646                  | **+0.8%** |
| `renderedBytes` mean | 80,000 (budget cap)     | 80,000                  | 0         |

Token use is within the 10% band. HEAD is not cheaper because the window is smaller; cache is higher and output is lower.

## Mapping onto the acceptance bar in comment 5518416233

Recorded bar (frozen in `scripts/f9-experiment/paired-stats.ts` `PROPOSED_THRESHOLDS`): history-only recall +10pp with CI support; FP within +5pp with CI support; visible recall within −5pp; precision within −5pp; tokens within +10%; 30 finding + 30 silence from **separate sessions**; ≥5 reps; 95% paired CI.

| Gate                                          | This run                                                                                                                                   | Verdict                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Corpus floors 30+30 independent sessions      | 36 items from **9 cuts**; finding and silence share sessions                                                                               | **insufficient-evidence**                                                                                                            |
| ≥5 reps                                       | 3                                                                                                                                          | unmet                                                                                                                                |
| History-only recall +10pp                     | **not measured** (arm-fair tail has no old-arm finding labels / no paired miss denominator)                                                | unmet                                                                                                                                |
| Tail retention diagnostic (not a gate)        | HEAD detected the marker in 17/27 windows that retained it                                                                                 | directional only; single inject signature; 9 sessions                                                                                |
| FP within +5pp                                | clean −3.8pp, CI [−28, +19]                                                                                                                | CI does **not** stay inside ±5pp                                                                                                     |
| Visible-window recall within −5pp of baseline | toolresult +59.3pp vs v0.4.1                                                                                                               | point estimate does not drop; this mixes prompt adoption (scoped+coverage) with render, so it does not isolate the no-reasoning flag |
| Tokens within +10%                            | +0.8% paired                                                                                                                               | pass on this slice                                                                                                                   |
| Per-claim note adjudication                   | injection-term match only; clean notes were not fully fact-checked on this 108×2 set (a 12-item luna/flash adjudication exists separately) | unmet for merge                                                                                                                      |

**Conclusion for #141:** this run does **not** measure history-only finding recall as defined in the comment (both arms labeled finding; truncated arm scored miss). What it does show: when the current window **retains** a planted tail marker, HEAD reported it in 17/27 reviews; v0.4.1 almost never used thinking-block markers (1/27). Visible-window (`toolresult`) detection is much stronger on current production than on tagged v0.4.1, but that mixes later prompt adoption with render and is not the no-reasoning flag in isolation. Silence FP is statistically tied and still high; many clean notes on a smaller probe were true verification issues, so this FP rate is not a production quietness score. **Do not merge on this evidence** — floors, reps, the FP interval, and the missing history-only recall estimand all fail the recorded bar.

## How to reproduce

```bash
# worktree: src pinned at v0.4.1; copy HEAD harness; symlink node_modules
git worktree add --detach /tmp/pi-advisor-v041-src v0.4.1
rsync -a --delete scripts/f9-experiment/ /tmp/pi-advisor-v041-src/scripts/f9-experiment/
ln -s "$(pwd)/node_modules" /tmp/pi-advisor-v041-src/node_modules

MODEL=commandcode-goat/deepseek/deepseek-v4-flash
CORPUS=docs/internal/accuracy-corpus.jsonl
COMMON=(--reps 3 --prompt-variant prod --model "$MODEL" --corpus "$CORPUS" --token-ceiling 20000000 --cost-ceiling 50)

bun scripts/f9-experiment/run-accuracy.ts "${COMMON[@]}" --arms new \
  --out docs/internal/accuracy-ab-head-prod-full.jsonl

( cd /tmp/pi-advisor-v041-src && bun scripts/f9-experiment/run-accuracy.ts "${COMMON[@]}" --arms old \
  --out /ABS/pi-advisor/docs/internal/accuracy-ab-v041-prod-full.jsonl )
```

`--arms` was added to this harness so a 2-arg renderer cannot silently burn a duplicate identical arm.
