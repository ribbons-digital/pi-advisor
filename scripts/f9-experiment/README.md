# f9 实验脚本

F9 实验（includeReasoning 旧臂 vs no-reasoning + 历史压缩新臂）的离线分析与在线运行脚本。
脚本已随 commit 纳入 git；数据集与结果落在 `docs/internal/`（git-ignored，不入库）。

## 脚本清单

### 共享模块

| 文件                       | 作用                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `dataset.ts`               | 固定的代表性 update 数据集（被 `run.ts` 消费，已跟踪）                                                                               |
| `experiment-identity.ts`   | 实验身份指纹：git HEAD + corpus/model/prompt hash + harness 源码 hash（仅覆盖该实验传递依赖，改无关分析脚本不会作废已付费结果）      |
| `harness.ts`               | runner 共用骨架：usage 提取、provider 扩展加载，以及 fail-closed 的 JSONL 断点续跑读取。`run.ts` 自包含，不依赖此文件                |
| `context-dataset-types.ts` | context-composition 数据集类型；生成数据集在 `docs/internal/context-dataset.draft.ts`，新 clone 未生成时让 `run-context.ts` 优雅报错 |

### 数据准备（离线，无模型调用）

| 脚本                 | 作用                                                                                                                 | 产物                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `collect-corpus.ts`  | 从当前 cwd 的 Pi 会话切片生成 context-composition 语料（redact 后）                                                  | `docs/internal/context-dataset.draft.ts` |
| `curate-accuracy.ts` | injection-based、arm-fair 的 accuracy 语料（clean / reasoning / toolresult / tail 四变体，期望按臂各自渲染结果计算） | `docs/internal/accuracy-corpus.jsonl`    |

### 在线运行（需要模型）

| 脚本              | 作用                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| `run.ts`          | 原始 f9 数据集 A/B（`pnpm experiment:f9`）                                      |
| `run-context.ts`  | context-composition 实验：截断路径下的双臂对比（依赖 `collect-corpus.ts` 产物） |
| `run-accuracy.ts` | accuracy 实验：四类 injection 变体按臂判定                                      |
| `run-compare.ts`  | 旧臂 vs 新臂在同一 corpus 上的整体对比（live cadence）                          |

### 离线分析（无模型调用，消费上面运行的结果）

| 脚本                      | 作用                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `analyze-cache-hit.ts`    | 用生产 context-assembly 管线回放 `docs/internal/advisor-hist-corpus.jsonl`，模拟 prefix-cache 命中率 |
| `analyze-signal-depth.ts` | 同一 hist corpus 上自然 finding 的信号深度分布，回答 retention depth cap 是否安全                    |

## 运行方式

```sh
bun scripts/f9-experiment/<script>.ts        # bun 直接跑（支持 CLI 参数）
pnpm experiment:f9                           # run.ts 走 package.json 入口
```

各脚本的参数见文件头注释（`Run:` 一行）。

## 注意

- 实验结论与报告在 `docs/internal/*-evaluation.md`、`complete-report.md`、`old-vs-new-comparison.md`。
- 新增临时探针脚本用完请删除，不要留在本目录（参见已删除的 `probe-slim-cache.ts`）。
