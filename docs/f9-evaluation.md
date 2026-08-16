# F9 tiered-prompt experiment evaluation note

Status: stopped early: provider request failed 3 times in a row (last: 429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-4-8 are cooling down via provider claude"}}); upstream availability or rate limits.
This experiment never ships as default behavior without measurement review and separate user approval.

## Protocol (approved 2026-08-16)

- Fixed dataset: 26 representative updates in `scripts/f9-experiment/dataset.ts`.
- Each update runs once with the baseline prompt and once with the tiered prompt (core rules always present; chronology and memory rule blocks included only when the update text is relevant to them).
- Same configured model and effort for both arms; exact provider-reported model recorded per run.
- Metrics: note quality (note mentions an expected defect term), false-positive rate, silence correctness.
- Budget ceilings: 1000000 review tokens and $25, enforced through the existing `limits.sessionTokenSoftCap` and `limits.sessionCostSoftCapUsd` fields; crossing either stops the experiment.
- Scripted fixture providers cannot measure model judgment, so this evaluation uses bounded live-model runs under the ceilings above.

## Model identity

Configured model: `vibeproxy/claude-opus-4-8`.
Provider-reported response models: (none recorded).

## Aggregate results

| Arm      | Silence correct | Silence-correct rate | False-positive rate | Finding hits | Finding-hit rate | Tokens | Cost    |
| -------- | --------------- | -------------------- | ------------------- | ------------ | ---------------- | ------ | ------- |
| baseline | 0/2             | 0.0%                 | 0.0%                | 0/0          | 0.0%             | 0      | $0.0000 |
| tiered   | 0/1             | 0.0%                 | 0.0%                | 0/0          | 0.0%             | 0      | $0.0000 |

Total: 0 tokens, $0.0000.

## Per-run results

| Item     | Arm      | Verdict   | Expected | Note (truncated)                                                                                                                             |
| -------- | -------- | --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| clean-01 | baseline | run-error | silence  | run error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try |
| clean-01 | tiered   | run-error | silence  | run error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-4-8 are cooling down via  |
| clean-02 | baseline | run-error | silence  | run error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-4-8 are cooling down via  |

## Reading

- A higher silence-correct rate and a lower false-positive rate on the tiered arm support the F9 hypothesis that the conditional rule blocks reduce distraction on updates where they are irrelevant.
- A lower finding-hit rate on the tiered arm would indicate that the omitted blocks carry material review value.
- The tiered prompt is selected in the runtime only by the non-public internal flag `PI_ADVISOR_TIERED_PROMPT_EXPERIMENT=1` and changes nothing when the flag is off.
- No configuration fields were added.
