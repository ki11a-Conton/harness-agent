# 实测 pilot 固定输入

这是 2026-10-03 计划 M4 的准备工具。它只生成和验证数据；`--dry-run` 强制关闭 paid flag。准备成功、脚本 provider 成功和真实模型质量收益是三种不同事实。此处不调用收费模型，不提供推广或默认启用结论。

构建后准备正式 benchmark cases，并验证原始输入、host checker 和候选 dry-run：

```bash
corepack pnpm build
node scripts/research/agent-measurement-20261003/prepare-pilot.mjs \
  --out .ci/agent-measurement-20261003/pilot \
  --self-test --dry-run --provider openai --model gpt-4o-mini
node scripts/research/agent-measurement-20261003/prepare-pilot.mjs \
  --out .ci/agent-measurement-20261003/pilot --check
```

`gpt-4o-mini` 只是无 key 的 dry-run identity 示例。真实测试使用用户配置的服务、模型和环境 key，在有来源的费用上限落实后重新生成 dry-run 确认，不能复用其他模型或源码的 digest。

| 目录 | 候选 | 固定案例 | 验收 |
| --- | --- | --- | --- |
| `cases/skills` | `task_scoped_skills_v1` | 20 个 weather 技能和末尾 `zz-port-config`；8k context budget；中文端口任务 | 端口默认值、十进制字符串、边界与无效值；所有非目标 fixture 字节保持 |
| `cases/diagnostic` | `diagnostic_first_repair_v1` | `reg-24-error-handling` 原用户任务和原源码/data | invalid JSON 返回 null，valid JSON 对象保持；data 字节保持 |
| `cases/instructions` | `path_scoped_instructions_v1` | 三包 monorepo，root/API/web/jobs 各有真正 `AGENTS.md` | API marker 和 1..3 边界；兄弟包/所有规则文件保持 |

每个目录只有一个案例。计划设置 `--repeat 2 --seed 19 --max-logical-runs 4 --max-model-calls 40`，即 2 对、4 个隔离 arm，AB/BA 次序由现有 paired planner 产生。它是探索 pilot，不能满足正式 promotion 最少案例要求。

固定内容由 `pilot-data.mjs` 确定性构造，`input-manifest.json` 固定每个 request、expected、case.json 和 fixture 的 SHA-256，以及整个输入集合的 digest。`--check` 对输出逐字节核对；普通 benchmark 的 execution plan 再冻结它实际加载的输入 hash。对照时两臂使用同一 fixture、工具 schema、模型和费用限制；只有策略配置有差异。

Verification 使用 case.json 的 `node` + 独立 `-e` argv。checker 代码不复制进可写的 arm workspace，模型修改 `verify.js` 不能改变它。host 在目标模块执行前后核验非目标原文件的 SHA-256；子进程冻结 assert 对象后再导入目标，并要求完整证明输出，因此 `process.exit(0)` 不能直接假过。`--self-test` 实际证明破损原始代码失败、正确修复通过、非目标/规则篡改失败、模块执行期间篡改失败、assert monkeypatch 失败、提前退出失败。正确修复源码只用于 checker 工程验收，不发给真实模型。这些是常见绕过的回归覆盖，不能据此宣称 Node 子进程可完全隔离任意恶意 JavaScript；真实 paid run 仍保留现有 OS confinement 和宿主变更哨兵。

主技能 case 需要普通 benchmark 的真实 host 技能接缝：只发现原 fixture 中 `skills/<id>/SKILL.md`，baseline/candidate 都使用相同安全 loader/body provider，候选仅改变 selector；无 skills fixture 的旧 cases 保持原行为。`AR_SKILL_ROOTS` 不用于选择本数据集，避免运行环境把另一个技能目录偷偷带入对照。

真实模型执行前，应从已固定受测源码的 clean worktree 运行同一命令去掉 `--dry-run`，加入当次 `--plan-digest`，并在环境里设定已授权的 `RUN_PAID_BENCHMARKS=1` 和 model key。此工具不自动做这一步；现有 `--max-estimated-cost-usd` 是估计阈值，不能当作美元硬上限。实际费用未知、usage 缺失和基础设施失败必须照录。

已实现的 M1 工程反例也可在构建后独立重跑：

```bash
node scripts/research/agent-measurement-20261003/skill-admission.mjs \
  --repo "$PWD" --out /tmp/harness-skill-admission
```

该探针使用真实 Harness、工具、Verification，21 技能/8k 预算、6 turn AB/BA；existing English selector 对照只验证工程上下文与 admission 账本。paid calls 为 0，模型质量为 `NOT_RUN`。

使用本轮真实候选重复同一 21 技能 / 8k admission 对照：

```bash
node scripts/research/agent-measurement-20261003/skill-admission.mjs \
  --repo "$PWD" --out /tmp/harness-task-scoped-admission \
  --candidate task_scoped_skills_v1
```

冻结 provider 参数的本地 HTTP 和 keyless plan identity 探针：

```bash
node scripts/research/agent-measurement-20261003/provider-policy.mjs \
  --repo "$PWD" --out /tmp/harness-provider-policy
```

本地 HTTP 只证明重试次数、超时和策略不可漂移，不调用真实模型。


## Skill context 工程探针

```bash
corepack pnpm build
node scripts/research/agent-measurement-20261003/skill-context.mjs \
  --out .ci/agent-measurement-20261003/skill-context
```

可用 `--repo /absolute/built-worktree` 选择已构建源码。100 个合成 SKILL.md、真实 filesystem/Harness/工具/JSONL，provider 响应受脚本控制。输出区分当前默认、旧 fixed-goal lexical selector 与实际 `task_scoped_skills_v1`，包含 AB/BA、完整实际请求指标和 loader I/O 计数。脚本断言相关正文保留、system bytes 至少减少 90%、工具 schema/原 read_file trace 相同。未知/显式/中文/并发/实时 steering 的接缝由独立真实 Harness 回归覆盖。

这些是工程测量，不能证明真实模型任务成功率或时延改善，不能触发 promotion。原 `c31e4a8` 基线 raw records 与候选 sourceDirty/sourceSha256 分开；当前默认臂已经包含 M1 反馈正确性修复。`--out` 下生成的合成 fixture/data 可删除，脚本不读取模型 key 或发出模型 HTTP 请求。
