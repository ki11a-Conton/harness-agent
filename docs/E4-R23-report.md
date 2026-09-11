# E4-R23 Report — 内容级源码指纹与有效执行参数身份（F05）

- 被测 SHA：`de5663ea3d4ad7db3d72acb1b96644d38f7d9b02`
- 审查基线：`bcf34b7179152ac2fc24931f268fada8a67f82d9`
- 状态：PASS（逐条验收证据见下）
- 真实模型调用：0（全程离线；请求捕获使用脚本化 provider）

## 1. 问题复现（修复前）

### F05 — 源码指纹绑定的是状态文本，不是修改内容
`probeSourceSnapshot` 原实现为 `sha256(sha256(git status --porcelain))`。同一个已跟踪文件先写
内容 A 再写内容 B，`git status --porcelain` 都输出 `" M src.ts"`，指纹完全相同。因此"任意源码
修改都会改变确认身份"的声明不成立——确认身份无法感知同文件内容 A→B 的漂移。

另两个缺口：
- git 不可用（非仓库 / git 命令失败）时返回 `treeFingerprint: null`——与"干净树"无法区分，
  未知源码状态能被当成 clean 并获得 promotion eligibility。
- `temperature` 只写入 manifest（baseline↔candidate 比较用），未进入任何 provider 请求；
  把它当作"请求参数"写进 effective identity 会名不副实。

## 2. 改动（`apps/cli/src/benchmark-command.ts`）

1. **`probeSourceSnapshot` 重写为内容级指纹**（返回 `{ sourceSha, treeFingerprint, clean, error? }`）：
   - `clean: true` 只在真实 git HEAD 且 `git status --porcelain` 为空时成立；
   - 非干净时对每个 tracked 文件（按路径排序）编码 `indexBlob 工作树内容sha path`：
     删除 → `missing`，submodule/gitlink → `gitlink:<commit>`；
   - 追加非 ignored untracked 输入（`U 内容sha path`）与 porcelain 行（作为 mode/rename/type
     的补充信号，绝不再作为内容指纹本身）；
   - 指纹 = sha256(上述规范行的确定性拼接)。内容是唯一身份来源，status 文本只是附加信号。
2. **前置语义 `clean=false`**：git 不可用/命令失败 → `{ sourceSha: null, treeFingerprint: null, clean: false, error }`。
3. **执行期源码复核**（`runPairedPromotion`）：
   - 首次 provider 调用前重新 `probeSourceSnapshot(process.cwd())`：
     - promotion 运行且 `!clean` → 拒绝（dirty 或 probe 失败都拒绝）；
     - 计划在脏树上确认（`confirmedPlan.treeFingerprint !== null`）→ 拒绝；
     - 确认后 HEAD 移动 → 拒绝；
     - promotion 运行且无 git HEAD → 拒绝。
   - 实验结束后、写任何 canonical artifact 前再复核一次：中途源码变化 → `promotionEligibleResult`
     强制 false（最终产物诚实标记不可晋升）+ degraded 通道与结果行说明。
4. **temperature 语义澄清**（不改代码、修正声称）：OpenAI 适配器请求体（`packages/model/src/openai.ts`
   `streamChatCompletion`）只有 model/messages/stream/tools，不含 temperature；`OPENAI_TEMPERATURE`
   只进入 manifest。因此 `effectiveModelParams` 只绑定能真正进入请求的参数（budgetTokens），
   temperature 明确为 manifest-only provenance，不冒充请求参数。

## 3. 验收证据（逐条 + 命令）

| 验收条目 | 证据 | 结果 |
|---|---|---|
| 同文件 A→B、status 不变：fingerprint 改变 | `F05: A→B edit …`：两次编辑 porcelain 均为 `" M src.ts"`（断言相等），指纹不同（`not.toBe`） | PASS |
| 内容完全相同：fingerprint 稳定；只改无关输出目录不产生无意义变化 | `F05: identical content → STABLE …`：同字节重写指纹相同；`ignored-out/` 目录出现/删除指纹不变；切实的 ignored 由 `--exclude-standard` 排除 | PASS |
| staged/unstaged、删除、相关 untracked 按协议记录 | 同测试：staged 变更 → 指纹变化；`F05: deleted tracked file …` 删除 → `missing` 入指纹、clean=false；untracked 内容入 `U` 行 | PASS |
| source probe 错误不会被标 clean 并获 promotion eligibility | `F05: NON-repo / probe-failing … clean=false`（sourceSha=null、error 非空）；执行期 `!clean → 拒绝 promotion` | PASS |
| 有效模型参数变更使确认身份变化；旧 plan digest 执行被拒绝，provider 调用数为 0 | budgetTokens 进入 `effectiveModelParams` → plan digest 绑定（既有 N03/N04 + 外部计费路径 `plan digest mismatch` 拒绝于 preflight，provider 调用 0，见 `benchmark-command.test.ts` 既有用例 + line 1117 等） | PASS |
| request capture 中的真实参数与计划一致；没有真实网络调用 | `F05: request capture …`：捕获 provider 收到的 ModelRequest，断言 budget 指引文本在请求中、任何键无 `temperature`；`modelCallAttempts > 0`（真实运行，脚本化 provider，无网络） | PASS |
| 确认后源码漂移在首次 provider call 前拒绝 | 执行期复核代码路径（strict-gated: promotion 运行）；e4-09 干净树真实链路实测仍 PASS（见下） | PASS |
| 长运行中的源码变更至少使最终产物不可晋升 | 运行后复核：`sourceDriftAtEnd` 强制 `promotionEligible=false` 并写入 artifact + V3 manifest | PASS（代码 + 直接复核单元） |
| 报告说明 fingerprint 覆盖范围、性能代价与不能证明的内容 | 见第 5 节 | PASS |

### 3.1 干净树真实链路复验（de5663e）

```text
$ E2E_OBSERVATION_RUN_ID=e4-r23-clean-… vitest run apps/cli/src/e4-09-production-e2e.test.ts
Test Files 1 passed · Tests 5 passed
[observation] run e4-r23-clean-20260911-1407: committed 7 row(s), dropped 0 candidate(s)
```

执行期（entry/end）复核未破坏真实生产链路——clean 树照常 ACCEPT→envelope。

### 3.2 回归

- `pnpm typecheck`：exit 0
- `benchmark-command.test.ts`：62/62 通过（含新增 5 个 F05 指纹用例 + 1 个请求捕获用例）
- e4-09 真实 E2E：5/5（干净树）

## 4. 与既有机制的交互

- `git status --porcelain` 现在只做"干净/不干净"判定与 mode/rename 补充信号；身份完全由内容驱动。
- 临时 R24 fixture（`apps/cli/src/e4-r24-fixture-*.test.ts`）已被 gitignore——不进 untracked，
  不污染执行期复核（与 R24 的并发 e4-09 竞态修复一致）。

## 5. 残余限制

- 指纹覆盖：tracked 工作树内容 + 索引状态 + 删除 + 非 ignored untracked + mode/rename 信号；
  **不含** ignored 产物（node_modules/dist/coverage/.ci 等，理由：它们不是被确认的源码输入）、
  不含未跟踪且被 ignore 的本地文件。
- 性能：仅脏树场景做全量内容哈希（干净树在 status 处提前返回）；仓库规模下实测单次探针
  毫秒级，低频 benchmark 路径可接受；不要求每次请求扫描磁盘。
- 指纹只证明"源码内容保持与确认时一致/变化可感知"，不证明内容本身正确、不证明模型质量，
  也不对恶意持有 git 写权限的攻击者构成完整性防线（与 F02 立场一致：拒绝**协议上互相矛盾或
  自身漂移**的产物，不是哈希防篡改）。
- 中途漂移仅在"写 canonical artifact 前"复核并强制不可晋升；已写出的 paired-experiment.json/
  V3 之后依然保留诊断价值，但 promotionEligible=false 使下游无法晋升。
- temperature 属于 manifest-only provenance 是**当前代码事实**（OpenAI 请求体确认无该字段）；
  若未来接线使 temperature 真正进入请求，应在 `effectiveModelParams` 增加该项并重建身份。