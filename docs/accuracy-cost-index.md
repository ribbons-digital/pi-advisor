# Accuracy and cost measurement index

Tracked summary of Advisor accuracy/cost runs for later integration (issue #141, prompt A/Bs, HEAD vs v0.4.1). Aggregates only — no session text. Raw jsonl stays gitignored under `docs/internal/` because it derives from real sessions.

Canonical 2026-09-14 HEAD vs v0.4.1 write-up (paste-ready, gate-safe wording): [issue-141-followup-head-vs-v041.md](issue-141-followup-head-vs-v041.md).
Machine summary: [issue-141-followup-head-vs-v041.summary.json](issue-141-followup-head-vs-v041.summary.json).

This file adds the numbers that write-up cites: raw vs cleaned rates, token/cost split, provenance, and pointers to sibling experiments.

---

## Status (do not skip)

**Directional / insufficient for the #141 merge gate** (comment [5518416233](https://github.com/ribbons-digital/pi-advisor/issues/141#issuecomment-5518416233)).

| Gate                        | Bar                                                        | This full run                                                    |
| --------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| Independent finding cases   | 30, separate sessions from silence                         | 9 `toolresult` items / 9 shared sessions                         |
| Independent silence cases   | 30, separate sessions                                      | 9 `clean` items / same 9 sessions                                |
| Reps                        | ≥5                                                         | 3                                                                |
| History-only finding recall | +10pp; **both** arms labeled finding; truncated arm = miss | **not measured** (arm-fair tail is `expected=silence` on v0.4.1) |
| Visible recall / FP         | 95% paired CI inside recorded margins                      | toolresult recall stronger; **clean FP CI not inside ±5pp**      |

Do not net `expected=finding` across arms. Pair only `toolresult` recall and `clean` FP. `tail` / `reasoning` are visibility diagnostics.

---

## 2026-09-14 full corpus: current HEAD vs tagged v0.4.1

### Design

|           | HEAD                                                                  | v0.4.1                                                                |
| --------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| When      | 2026-09-14 10:51–12:10 CST                                            | 2026-09-14 12:11–13:40 CST                                            |
| Tree      | `3917c5f`                                                             | `362e212` (`v0.4.1` worktree; `src/` pinned)                          |
| Render    | `includeReasoning: false` (flag default on)                           | always-reasoning (2-arg `renderAdvisorDelta`; extra options ignored)  |
| Prompt    | `--prompt-variant prod`, 5266 chars (live WATCHDOG + scoped/coverage) | same live WATCHDOG, v0.4.1 template, 3744 chars                       |
| Arm spent | `--arms new`                                                          | `--arms old`                                                          |
| Harness   | HEAD `scripts/f9-experiment`                                          | HEAD harness rsynced in; hashes differ because they close over `src/` |

v0.4.1 `arm=new` is **not** a no-reasoning sample. Do not spend it.

### Identity (every row)

Shared: `protocol=accuracy-experiment-v1`, `datasetHash=9e7b6a8a7a1fd06c`, `budgetTokens=20000`, configured model `commandcode-goat/deepseek/deepseek-v4-flash`, response `deepseek/deepseek-v4.1-flash`.

| File (gitignored)                                | SHA-256                                                            | n   | usable | promptHash         | harnessHash        | sourceCommit   |
| ------------------------------------------------ | ------------------------------------------------------------------ | --- | ------ | ------------------ | ------------------ | -------------- |
| `docs/internal/accuracy-ab-head-prod-full.jsonl` | `580d3c5076f0dfc26af0b45dface7abb2a97c414815f014dab19464e1303b2cc` | 108 | 107    | `e672f18480c03c20` | `ba9eca120752df4d` | `3917c5f016c6` |
| `docs/internal/accuracy-ab-v041-prod-full.jsonl` | `04069da1aff5da2b56b26e23612bc0b6a94ac64336f102db04654e8ef170f951` | 108 | 108    | `a9706d4769deb99e` | `bb1f392471716012` | `362e21252746` |

Unusable: HEAD `ctx-02-clean` new rep 2, `verdict=run-error`, 31298 tokens, `stopReason=error`. Paired keys = 107.

Corpus: gitignored `docs/internal/accuracy-corpus.jsonl` — 36 items = 9 cuts × `{clean,reasoning,toolresult,tail}`. Signature `INJECTED_DEFECT_audit_v7_downgrade_14_203_rows_no_backup`. Arm-fair: finding iff **that arm's rendered window** contains the signature.

### Junk cleaning

Treat as no-note: `placeholder` / `placeholder2`, `y`, `probe (will not be emitted)`, `占位（不应被采纳，用于对照观察）。`.

HEAD 16/107; v0.4.1 5/108. Prefer **cleaned** for comparison. Raw HEAD silence FP is inflated by junk.

HEAD junk inventory: `placeholder2`×7, `placeholder`×6, plus one each of `probe (will not be emitted)`, `y`, `占位（不应被采纳，用于对照观察）。` (see follow-up md / jsonl).

Runtime now drops those whole-note placeholders in `isContentFreeAdvice` (same path as `looks good`). That does **not** change the cleaned FP table above — cleaned already treated junk as no-note. Distinguish two checks:

- **Live probe (12 reviews):** `ctx-02` × 4 variants × 3 reps, `arm=new`, same goat model. Model emitted 4 placeholder notes; `createAdviseTool` suppressed all 4 (`suppressedCalls=1`, no `accepted`). One leftover delivered note was `x` (not in the placeholder list).
- **Historical replay (16/107):** the 16 junk notes already recorded on `accuracy-ab-head-prod-full.jsonl` were fed to the same executor; 16/16 suppressed. This is not a second live model run.

### Accuracy — cleaned (junk = no-note)

**Pairable strata** (same visible content; cluster bootstrap over 9 cuts, seed 20260914, 4000 iters):

| Stratum                               | HEAD          | v0.4.1        | Δ HEAD−v0.4.1 (95% CI)                                  |
| ------------------------------------- | ------------- | ------------- | ------------------------------------------------------- |
| Visible finding (`toolresult`) recall | 26/27 = 96.3% | 10/27 = 37.0% | **+59.3pp [+29.6, +85.2]**                              |
| Silence (`clean`) FP                  | 19/26 = 73.1% | 20/26 = 76.9% | **−3.8pp [−28.0, +18.5]** (includes 0; not inside ±5pp) |

**Visibility diagnostics — not #141 history-only recall:**

| Stratum                                                 | HEAD                                              | v0.4.1                                          |
| ------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `tail` (marker retained only after stripping reasoning) | detected 17/27 = 63.0% in windows that contain it | marker absent; spoke 15/27 (cleaned FP 55.6%)   |
| `reasoning` (marker only in thinking)                   | stripped; spoke 16/27 (cleaned FP 59.3%)          | detected 1/27 = 3.7% in windows that contain it |

To measure history-only **recall**, both arms must be labeled finding so truncation is a miss.

### Accuracy — raw (junk counts as a note)

| Variant        | HEAD n | hit | miss | FP  | sil | v0.4.1 n | hit | miss | FP  | sil |
| -------------- | ------ | --- | ---- | --- | --- | -------- | --- | ---- | --- | --- |
| clean          | 26     | 0   | 0    | 22  | 4   | 27       | 0   | 0    | 21  | 6   |
| reasoning      | 27     | 0   | 0    | 23  | 4   | 27       | 1   | 26   | 0   | 0   |
| toolresult     | 27     | 26  | 1    | 0   | 0   | 27       | 10  | 17   | 0   | 0   |
| tail           | 27     | 17  | 10   | 0   | 0   | 27       | 0   | 0    | 17  | 10  |
| overall usable | 107    | 43  | 11   | 45  | 8   | 108      | 11  | 43   | 38  | 16  |

HEAD overall raw: recall 43/54 = 79.6% (toolresult+tail only), FP 45/53 = 84.9%. Do not compare that recall to v0.4.1 overall 11/54 = 20.4% (reasoning+toolresult).

### Cost

Provider `costUsd` is **$0** on commandcode-goat (pricing unfilled). Estimates use ollama-cloud `deepseek-v4.1-flash` list prices: input $0.30 / cache-read $0.006 / output $1.20 per 1M. `inputTokens` = uncached prompt; output = `tokens − inputTokens − cachedTokens`.

### Totals

|                      | HEAD (107)                         | v0.4.1 (108)                   | paired Δ  |
| -------------------- | ---------------------------------- | ------------------------------ | --------- |
| Σ tokens             | 3,629,164 (mean 33,917)            | 3,627,551 (mean 33,588)        | —         |
| uncached in          | 496,540                            | 572,346                        | —         |
| cache read           | 2,215,128 (61.0%)                  | 1,964,276 (54.1%)              | —         |
| output               | 917,496                            | 1,090,929                      | —         |
| provider USD         | $0.00                              | $0.00                          | —         |
| estimated USD        | **$1.2632** (~$11.81 / 1k reviews) | $1.4926 (~$13.82 / 1k reviews) | —         |
| paired mean tokens   | 33,917                             | 33,646                         | **+0.8%** |
| `renderedBytes` mean | 80,000 (cap)                       | 80,000                         | 0         |

HEAD is not cheaper because the window is smaller; cache is higher and output is lower.

### Per variant (HEAD)

| Variant    | n   | Σ tok   | mean   | uncached | cache   | out     | cache% | est $  | $/review |
| ---------- | --- | ------- | ------ | -------- | ------- | ------- | ------ | ------ | -------- |
| clean      | 26  | 916,969 | 35,268 | 148,451  | 517,240 | 251,278 | 56.4   | 0.3492 | 0.01343  |
| reasoning  | 27  | 954,042 | 35,335 | 4,995    | 681,844 | 267,203 | 71.5   | 0.3262 | 0.01208  |
| toolresult | 27  | 837,742 | 31,027 | 214,811  | 464,758 | 158,173 | 55.5   | 0.2570 | 0.00952  |
| tail       | 27  | 920,411 | 34,089 | 128,283  | 551,286 | 240,842 | 59.9   | 0.3308 | 0.01225  |

### Per variant (v0.4.1)

| Variant    | n   | Σ tok   | mean   | uncached | cache   | out     | cache% | est $  | $/review |
| ---------- | --- | ------- | ------ | -------- | ------- | ------- | ------ | ------ | -------- |
| clean      | 27  | 929,571 | 34,429 | 181,890  | 455,424 | 292,257 | 49.0   | 0.4080 | 0.01511  |
| reasoning  | 27  | 883,218 | 32,712 | 202,390  | 429,560 | 251,268 | 48.6   | 0.3648 | 0.01351  |
| toolresult | 27  | 907,301 | 33,604 | 182,586  | 450,556 | 274,159 | 49.7   | 0.3865 | 0.01431  |
| tail       | 27  | 907,461 | 33,610 | 5,480    | 628,736 | 273,245 | 69.3   | 0.3333 | 0.01234  |

### What this does / does not support

- Supports: extra retained history can surface a planted tail marker when it is in the window (17/27); v0.4.1 almost never used thinking-block markers (1/27); visible-window inject detection is much stronger on current prod than tagged v0.4.1 (mixes prompt adoption + render, not the flag alone); token use is within +10%.
- Does not support: merge; history-only recall gate; production quietness (clean FP ~73% both sides; 12-item luna/flash adjudication found many “FP” were true verification issues).
- Next measurement if integrating into #141: 30+30 from **separate** sessions; ≥5 reps; history-only cases labeled finding on **both** arms; report raw and cleaned; do not use commandcode-goat as the primary quietness model.

Reproduce: see [issue-141-followup-head-vs-v041.md](issue-141-followup-head-vs-v041.md) (needs `--arms` on `scripts/f9-experiment/run-accuracy.ts`).

---

## Related local artifacts (`docs/internal/`, gitignored)

| File                                                                                          | What it is                                                                                              | Use                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `docs/internal/accuracy-ab-head-prod-pilot.jsonl`                                             | 12-item × 1 rep HEAD prod, same model, 2026-09-13                                                       | superseded by full run                                                 |
| `docs/internal/accuracy-ab-v041-prod-pilot.jsonl`                                             | 12-item × 1 rep real v0.4.1                                                                             | superseded by full run                                                 |
| `docs/internal/accuracy-ab-luna-prod-pilot.jsonl`                                             | 12-item luna Policy B probe                                                                             | model comparison, not version comparison                               |
| `docs/internal/clean-note-adjudication.jsonl`                                                 | 24-row luna+flash silence-note labels (`true_issue` / `silence` / `true_but_out_of_scope` / `nonsense`) | do not treat corpus FP as quietness                                    |
| `docs/internal/accuracy-ab-v041.jsonl`                                                        | earlier 360-row v0.4.1 tree, ollama `deepseek-v4.1-flash`, frozen **baseline** prompt (not live prod)   | pre-adoption; do not mix with prod-full                                |
| `docs/internal/accuracy-ab-ds41.jsonl`                                                        | HEAD-era 360-row, baseline prompt, reasoning-on vs default                                              | pre-scoped/posind                                                      |
| `docs/internal/accuracy-ab-posind.jsonl` and `accuracy-ab-posind-ccg.jsonl`                   | posind prompt A/B                                                                                       | prompt adoption evidence                                               |
| `docs/internal/accuracy-ab-scoped.jsonl`, `accuracy-ab-lean.jsonl`, `accuracy-ab-tuned.jsonl` | prompt variants                                                                                         | lean falsified; tuned not adopted                                      |
| `docs/internal/accuracy-corpus.jsonl`                                                         | injection corpus                                                                                        | shared `datasetHash` 9e7b6a8a7a1fd06c on the 2026-09-14 prod-full pair |

Related tracked note: [f9-evaluation.md](f9-evaluation.md) (F9 tiered prompt, 2026-08).
