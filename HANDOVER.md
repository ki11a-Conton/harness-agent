# Harness v5 Runtime Status

Architecture: FROZEN
Runtime release: READY

## Runtime release truth

The canonical release truth is the exact-SHA GitHub Actions
release-evidence / release-attestation artifact for the commit being evaluated.

Do not treat this file as a substitute for exact-SHA CI evidence.

To verify the release state of a specific commit, run the release-evidence
workflow for that exact SHA and read its attestation (runtimeReleaseReady).
This file intentionally does not embed a "latest run id" or "current SHA",
because any commit updating such a value would make this document stale again.

> Historical example (not current truth): the P38.3 RC-M1 final candidate was
> validated by its own exact-SHA CI release-evidence artifact; Linux, Windows,
> coverage, security, race, chaos and release-attestation gates were green for
> that commit. These were facts about that commit only.

Free runtime gates (semantics, not per-commit numbers):
- Linux: PASS — exact-SHA CI verify
- Windows: PASS — exact-SHA CI verify
- Coverage: PASS
- Security: PASS
- Race: PASS
- Chaos: PASS
- Release attestation: PASS — headSha == pushed SHA, runtimeReleaseReady == true
  (verified per commit from the CI artifact; not stored as a volatile number here)

Real-model benchmark:
- preserved separately as quality evidence (benchmarks/results/)
- does not gate Runtime RC

## 状态速览

packages/（24 个包）已完成；
测试基线 4926 passed / 0 failed（`pnpm test` 门禁，excludes soak/perf）。

## 仓库结构

- `packages/` — 核心库、合约、运行时、安全、事件、网关等 24 个以
  package.json 自描述的工作区包。
- `apps/` — CLI、桌面代理等宿主应用。
- `.ci/` — CI 基线捕获与发布证据（gates/<os>/ 命名空间；Windows 本地
  生成，Linux/coverage 由 CI 生成）。

## 发布证据

- 每个必须门禁在 `.ci/evidence/gates/<os>/<gate>.json` 留有真实命令、真实
  退出码、精确 HEAD 的证据（P38.2-10/13）。
- `agent release verify` 只读该布局，按 gate+platform 校验每一条证据；任何
  stale / 错误命令 / 缺失平台 → FAILED（P38.3-5/6 零红规则）。
- attestation 区分 `runtimeReleaseReady`（免费确定性门禁）与
  `championPromotion`（独立真实模型质量评估，release 门禁不评估）——
  INV-P38.3-012。

## Benchmark 语义（P38.3-10/12）

- `agent benchmark` 是**测量**：报告已写入、X/Y 用例通过判定，不是质量裁决。
- 质量评估由 `agent champion eval <baseline-runs.json> <candidate-runs.json>`
  独立完成，含 quality policy（同用例集 / judge 版本一致 / 无新增
  harness/judge/infra 失败 / 安全非回归 / P21-4 质量门禁 / P38.4-8 溯源
  可比较性）。
- 每次 benchmark 运行附 effectiveConfig（candidate、机制接线、工具集哈希、
  runtimeConfigHash），challenger 候选与 baseline 哈希必不同。
- P38.4-7：per-case provenance（evaluationContextHash / candidateConfigHash /
  controlledDifference）使配对比较可归因；P38.4-8：context 不一致即
  fail-closed。

## Historical / superseded

P35/P36/P37/P38 早期批次的逐项历史说明与中间结论已被本节取代；如需追溯，
参见 git 历史与 `plan-P38.3-RC-M1-final-hardening.md` 各任务章节。

- 早期"能力矩阵 = 发布证据"的提法已废弃：CAPABILITY_MATRIX.md/.json 现为
  informational 快照（P38.2-11），正式发布验证使用 CI 生成的精确 SHA 证据。
- 早期"benchmark 命令成功 = 质量通过"的语义已废弃：测量与质量分离
  （P38.3-12）。
