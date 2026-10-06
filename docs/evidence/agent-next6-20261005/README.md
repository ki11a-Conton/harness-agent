# N6 round — offline completion record (N2 / N3 / N4)

2026-10-05。本轮入口 [plan.md](../../../plan.md)；不可变规格 [plan(20261005-234821).md](../../../plan(20261005-234821).md)；任务合同 [AGENT-NEXT6-20261005.md](../../../tasks/AGENT-NEXT6-20261005.md)。

**受测源码 `6d369f76`**（干净检出）。本记录为文档，不改变任何受测字节。

## 候选

`context_safe_tool_call_efficiency_v1`（agent-strategy，`experimental`，**未 promotion**）。版本 `context-safe-tool-call-efficiency:v1`，文本 sha256 `ce66f3b091752fdb38774914d2d3e5f736c0684930d5162f25ecdb5bed2d56c2`（24 行块）。

单一变量 = v2 文本（`tool-call-efficiency:v2`，sha256 `ebddf5eb125cbbe8ed25d7ecb1ea3554809494aea70716adf3a9f62924939619`，与 N1 审查记录逐字节一致）中的**重读规则**；其余句子逐字节复用。规则：证据仍可见且版本匹配 → 复用；压缩/截断/恢复丢了必要原文 → 先补读再编辑；文件变更 → 照旧重读。

## 提交

| SHA | 内容 |
| --- | --- |
| `91767a93` | plan.md 指向本轮不可变规格 |
| `08760cd6` | N3 候选实现 + 回归 + mutation 锚同步 |
| `fc4c9860` | N2 主实验合同（24 用例 + 预注册） |
| `441025f0` | N2 独立 holdout 合同（24 用例 + champion 溯源） |
| `82bd2edf` | 冠军变更使 holdout 计划失效 |
| `74bb6d2f` | N4 证据生命周期（真压缩器）+ 真实 Harness 工具循环 |
| `fd442c3c` | N4 Web 入口与 CLI 安装同一份被证明的字节 |
| `6d369f76` | 修复被 `.gitignore` 吞掉的 holdout 证据文件 + git 跟踪性断言 |

## N2 —— 冻结实验合同

- 主实验 24 case（16 证据缺失 = compact-drop 6 / preview 4 / rehydrate 4 / partial 2；8 控制 = visible 4 / changed 2 / diagnostic 2），每个用例独立夹具 + 原 command verifier；**判别力已证**（未修复夹具必失败、参考修复后必通过）。
- 独立 holdout 24 case（另一仓库/任务家族：账务·仓储·遥测；证据为 CSV 行 / JSON 载荷 / 日志 / 策略表），与主集**不共享任何夹具字节、任务文本或用例 id**，且候选文本早于该文件冻结。
- 两个实验各 **192 logical arm runs**（24 × 4 × 2），AB/BA **48/48** 平衡，最坏 5760 次模型调用；`dry-run`：`providerCalls = 0`、`paidProviderCalls = 0`。
- 根身份对每个可调输入敏感（提示字节、源码 SHA、两臂 digest、runtime config、provider/model/请求档、用例集、verifier 集、选择溯源、套件版本、holdout 政策、scorer、order seed、预算上限、**门限值**）；holdout 另行绑定**运行时解析的 champion 溯源**，换冠军或仅溯源变化都会改变身份。
- 工件：[case-manifest.json](case-manifest.json)（`df5c7d8a…`）、[main-preregistration.json](main-preregistration.json)（`1e61a0ec…`）、[holdout-case-manifest.json](holdout-case-manifest.json)（`3465db00…`）、[holdout-preregistration.json](holdout-preregistration.json)（`81b1c883…`，champion = level C0 / arm `74b8465e…`）。

## N3 —— 单一策略差异

候选文本、注册表、arm 接线、机制契约、champion 安装计划与**实际安装字节核验**、CLI 单一模型可见提示构造器、独立激活信号 `context_safe_tool_call_efficiency_guidance_injected`、该候选的旧付费入口在构造 provider 前封闭。旧 v2 的**字节 / digest / 默认行为不变**（以 N1 记录的 sha256 作为冻结断言）；新键**只在该臂出现**，既有臂的 resolved config 与 hash 逐字节不变。

## N4 —— 工程与安全验收

| 条件 | 证据 |
| --- | --- |
| 证据可见 / 丢失 / 部分缺失 / 恢复后仅摘要 | 真 `MultiStageCompactor` + 冻结夹具：ephemeral 工具结果被整块丢弃（不留替代）、可压缩者折成 `compaction-summary`、超预算的尾部被丢弃且 marker 携带原始字节数、阈值以下文档逐字节不变 |
| 文件变更 | 真实 versioned `read_file` 在文件被改写后报出此前未出现的新内容摘要 |
| 恶意源文件 | 运行时 `security.injection_denied`：载荷与文件值都未到达模型，system prompt 仍等于授权策略 |
| 无权限 | 工作区外路径被拒绝，其内容从未进入任何模型请求；每次工具调用都有 `tool.permission_resolved` |
| 预算耗尽 | 反复相同工具调用被运行时守卫截断，回合以 `run.limit_reached` + **`turn.failed`** 结束，从不 `turn.completed` |
| 真实 Harness 工具循环 | 真 `createHarness`；`tool.requested` / `tool.permission_resolved` / `tool.started` / `tool.completed` 逐一对齐 |
| CLI / Web 对照 | CLI 真跑并捕获真请求；Web 入口在同一安装路径上安装并证明同一份字节 |
| typecheck / build | `tsc -b` exit 0 |
| 安全 | `packages/security` + harness 安全矩阵通过 |

### 全仓门（同平台同命令，干净检出）

| 版本 | 文件 | 测试 |
| --- | --- | --- |
| N6 前基线 `f04d3948` | 8 failed / 464 passed / 1 skipped (473) | **23 failed / 8779 passed / 10 skipped (8812)** |
| 本轮 `6d369f76` | 10 failed / 467 passed / 1 skipped (478) | **25 failed / 8835 passed / 10 skipped (8870)** |

失败**文件集**逐项比对：两边完全相同的 8 个文件（`path-scoped-discovery` 2、`e4-r77-baseline-oracle` 7、`r97-arm-worker-contract` 9、`scoped-instruction-read` 1、`encoded-tool-output-security` 1、`skill-revision-regressions` 1、`read-file-resource` 1、`symbol-scope` 1）。本轮**仅多出 2 个**（`apps/cli/src/cli.test.ts` 1、`apps/web/src/harness.integration.test.ts` 1），且它们在 `f04d3948` 与 `6d369f76` 上**单独运行均为 43/43 通过** → 属全套并行负载下的时序抖动。**N6 未新增任何稳定失败**；改动的净效果是全仓 +56 passing。

> 诚实边界：仓库 README/计划声明的 472 PASS 文件 / 8800 PASS 测试是上游 Linux CI 基线；本机 Windows 上**基线本身**即为 23 failed，因此上表用的是同平台同命令的对照，而不是那些绝对数字。

### 浏览器门（Chromium，干净检出）

`scripts/research/web-dsh-20261004/browser.py --mode candidate --require-clean`：**28 个用例（27 个非基础设施项 + 1 个 cleanup）**，24 通过 / 4 失败。其中 3 个业务项失败（审批卡渲染、取消阻塞回合、真实 SSE 中断重连）与 1 个连带 cleanup 失败；在 **N6 前基线**上跑同一门得到**同名、同报错的完全相同 4 项失败**（24 通过 / 4 失败）。`browserErrors: 0`。→ 全部既有，与 N6 无关。

## NOT_RUN（不假造）

- **N5 成对效果评测**：无模型凭据、无付费预算；`paid calls = 0`。假设"只在原文不可见时允许补读能改善压缩后修复准确性"**未被检验**。
- **N6 promotion / 回退演练**：依赖 N5。
- 真实模型质量、Windows 原生运行声明：NOT_RUN。

## 本轮发现的真实缺陷（均由本轮自己的门抓出并修复）

1. 改写付费守卫后，`scripts/e4/r97-mutation-check.mjs` 的锚文本失效 → 变异静默变成 no-op（4 项变异检查失败）。
2. `parseInt("08")` 在现代 JS 不报错，该控制用例**无判别力**。
3. preview 夹具只有 12 KiB，**永远不会触发**截断。
4. holdout 的 `provision.js` 生成成未闭合字符串字面量 → 参考步骤语法错误。
5. holdout 的证据文件名为 `*.log`，被 `.gitignore` 吞掉 → **干净检出缺失该证据**（本地全绿、干净树失败）。修复后新增"每个用例文件必须被 git 跟踪"的断言。
