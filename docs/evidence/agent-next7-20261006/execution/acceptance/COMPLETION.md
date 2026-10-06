# N7-4 / N7-5 / N7-6 执行链补齐验收

工程执行工具已实现并验收。**真实模型 soak、主/holdout campaign 与效果判定仍未运行**：本环境缺模型凭据与有效价目，8317 端点不可达，实际 sandbox capability self-test 未通过强隔离资格。候选保持 **NOT_PROVEN**，未安装、未晋升。

计划：[做什么、怎么做、怎么验收](../../../../../plan(20261006-n7-execution-chain).md)。使用命令见 [执行入口](../README.md)。审查基线 `d92d727689b9a2dc20bd09ea44348403f539def6`；最终全仓验收代码 `85564f0650f5efe715d6fe25e0c3fbef8b58db0c`。后续提交仅整理 docs/plan 和验收原件，不修改该验收代码；最终远端 SHA 的原生 Git/API 复核记录在 `.ci/n7-completion/publish/`。

| 计划项 | 本次完成 | 验收结果 |
| --- | --- | --- |
| E1 执行身份 | 强制重建、clean 实际 HEAD、逐文件 source/dist 摘要，保留原预注册 SHA 为 lineage；冻结端点全路径、请求策略、价目、隔离自测及两实验身份 | 实际 prepare 零模型调用；执行绑定原件可复核；付费关闭的实际 CLI 在 provider 之前拒绝 |
| E2 基础设施资格 | 24 次独立调用 soak，usage 完整性、失败/重试计量，durable ledger 与 cost budget | localhost HTTP 验证 24 次完成；成功前 retry、model_not_found、缺 usage、超时均不伪通过；这不是模型 qualification |
| E3 成对运行 | 独立 N7 runner，复用真实 Harness/paired executor、原 verifier、工具与安全边界，原预算与 deadline，断点续跑及原件保留 | 主实验 512 arms / 256 pairs / AB=BA=128；holdout 192 / 96 / AB=BA=48；v2 候选与实际冻结对照；两个真实 CLI dry-run 均 0 模型调用 |
| E4 判定 | 完整冻结网格 ITT、case 聚合、原 bootstrap seed 20261005 和 10000 次；真实 v2 digest/lineage；使用两臂实测条件命中的完整有效缺失 pair 作 PP 佐证；独立主/holdout 联合判定 | 重复/删除/额外 pair、伪激活、未知 usage、partial 安全违规、transport≥1%、completion<95%、预算延长均拒绝；无 bite 时 PP lift=null；单个实验不可满足联合资格 |
| E5 归档 | 不可覆盖目录、原件 hash/bytes 索引、重新计算 verdict、campaign/judge 命名空间、symlink/path escape 拒绝 | 合成主/holdout bundle 经实际 judge/联合 CLI/归档/复核；伪 verdict 即使重写索引仍拒绝；所有合成证据明确不具备模型效果/promotion 资格 |
| E6 工程验收 | typecheck、新回归、完整全仓、冻结产物复算、文档与原件复核、原生非 force 发布 | 新增 **55 PASS / 0 skip**；全仓 **485 个测试文件、8967 PASS / 0 FAIL / 12 原有 skip**；494 个冻结原件逐字节不变 |

## 可复核原件

- [completion.json](completion.json) 记录实际源码、构建、执行绑定、验收计数与真实环境状态。
- [artifact-index.json](artifact-index.json) 索引本验收目录全部文件，含 hash 与 bytes；[RAW-MANIFEST.json](RAW-MANIFEST.json) 同时记录原始未压缩字节与 gzip 存储字节。大 JSON/log 保留原始完整内容，解压即可复核。
- `source-before.json.gz` / `source-after.json.gz` 完全一致；`execution-binding.json.gz` 使用实际验收源码，而非原预注册的旧 SHA。source digest `e476cf0dc36db425dcc333f10b6cc998cd1ac3b357a22a4e366d85320cb0f6ca`，build digest `eae43da8a8bff2c26ef4eb758e136e63631ee05d61bbc28571381cc092f27362`。
- `full-tests.json.gz` 为 Vitest 完整 assertion 原件；[test-files.json](test-files.json)、[new-regressions.json](new-regressions.json)、[skip-provenance.json](skip-provenance.json) 便于查阅。12 项旧 skip 所在 4 个原测试文件与基线逐字节一致；其中包括 Windows 专用用例，不宣称 Windows native 已验收。
- standalone 回归在最终文件内容提交前运行；55 项又在 clean `85564f0` 的全仓测试中全部通过。localhost/scripted/合成 bundle 与 fabricated joint-decision 单元输入仅作工程测试，真实模型调用数为 **0**。
- [unchanged-originals.json](unchanged-originals.json) 包含 494 项原件的逐文件 SHA256/bytes：N7 策略、cases、原预注册、不可变规格及旧 N6 脚本均未重写。生产 Runtime/Core/权限/沙箱/工具/verifier/依赖与 champion 状态未修改。

在仓库根目录可独立复核本验收目录与压缩原件：

```bash
node --input-type=module <<'JS'
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { sha256, verifyIndex } from './scripts/research/agent-next7-20261006/execution-common.mjs';
const root = 'docs/evidence/agent-next7-20261006/execution/acceptance';
verifyIndex(root);
const manifest = JSON.parse(readFileSync(join(root, 'RAW-MANIFEST.json'), 'utf8'));
for (const entry of manifest.files) {
  const stored = readFileSync(join(root, entry.path));
  const raw = entry.encoding === 'gzip' ? gunzipSync(stored) : stored;
  if (raw.length !== entry.originalBytes || sha256(raw) !== entry.originalSha256) throw new Error(entry.path);
}
console.log('N7 engineering evidence verified');
JS
```

## 尚未完成的真实验收

| 原 N7 项 | 工程状态 | 真实验收状态 |
| --- | --- | --- |
| N7-4 soak + campaign | 执行器与失败门已验收 | **BLOCKED_ENVIRONMENT / NOT_RUN** |
| N7-5 双实验效果判定 | ITT/PP 与联合判定器已验收 | **NOT_RUN**，无模型效果结论 |
| N7-6 原件与发布 | 工程原件已归档；执行工具提交并按授权发布 | 无真实 campaign 原件可归档，**未 promotion** |

当前执行绑定 `7056ab66740d59c7f5c9b062dd6ec5991bb421d19148c1f23bbf590e8bf7ab6b` 是缺环境时的诊断原件，不可用作已合格 soak。后续在 clean 实际执行 SHA 上配置冻结模型端点、模型凭据、有效 `prereg-pricing-v2` 和合格隔离后，重新 prepare，确认新 binding digest，再按使用入口运行。若选择显式 insecure-local 研究模式，其实测永久 promotion-ineligible。

原 duration **1800000ms（30 分钟）**、工具总额 **600** 和其余预算保持不变。预计需要 9–10 小时的完整 campaign 必须在模型结果之前显式重新预注册预算，不能自动续 deadline 或增加 cap。两个真实实验、工程门、原件复核与强隔离资格均满足后，才可进入既有 champion 流程；联合判定器与归档器都不会自动修改 champion。

## 追加记录：N7 holdout 预注册重新冻结（P 轮）

P 轮登记新挑战者 `verified_completion_gate_v1` 后，`arm-factory buildSnapshot` 在 baseline 臂上把每个已注册候选列为 OFF，于是 champion 解析出的基线臂快照摘要移动，N7 holdout 预注册不再逐字节可复算，执行链的完整性守卫报 `ARM_DIGEST_DRIFT`。按计划建议的方式，用本轮的冻结脚本重新冻结：

| 项目 | 旧值 | 新值 |
| --- | --- | --- |
| `preregistrationDigest` | `967da1dd…5664` | `7b675621…7321` |
| `subject.baselineArmDigest` | `ee589c7e…7895` | `00d2c921…1fdc` |
| 预注册文件 SHA256 | `eddff1af…1a3a` | `e9fe9b50…476f` |

不变项：24 用例 / 4 重复 / **192 logical arm runs**（AB 48 / BA 48）、门限逐值相同、provider 与请求档相同、预算上限 $100,000、champion provenance 相同（level=C0、candidateId=null、validity=QUARANTINED_PENDING_REEVALUATION）。重新冻结发生在**任何 N7 模型结果之前**（soak / campaign / judge 均未运行，`paid calls = 0`）。

本目录随之更新：`holdout-prereg.log`（按 `checks.json` 记录的同一命令重新生成）、`unchanged-originals.json`（两条条目更新，并新增 `updatedInLaterRounds` 说明旧值与原因）、`artifact-index.json` 与 `RAW-MANIFEST.json`（索引与原件字节重算）。本文件其余结论不变；唯一被 P 轮移动的既有原件是策略文件 `packages/evaluation/src/mechanism-guidance.ts`（新增门文本，既有候选文本与 digest 未变）。
