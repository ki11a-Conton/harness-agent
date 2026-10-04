# Round 2 生产工具与独立验收审计

基线：`968544064f43cfc0a876c4e65fcb967cd466c9a2`，tracked 工作区 clean。仅修改 `.ci/agent-round2-20261004/tools-audit/`。读取 AGENTS.md 及 TOOL-001 / EXEC-001 / VERIFY-001 契约，检查生产 read/search/navigation/repo_map/exec/tool_lookup、TaskVerifier、自动命令发现和验收计划链路。未进行 paid 调用，未访问 GitHub connector / secret。

审查结论：本轮最有价值的可实施改进是自动验收可信性。存在两类确定性基础设施错误，不依赖真实模型，也不是模型质量假设。真实 built createHarness + 一次 scripted stop 请求 + 原始 Verification events 证明失败必测可以被当成 `verified_complete`。脚本只用于确定性运行，不代表模型质量评测。

## 改进 1：保留验收命令的执行语义，同时防止路径插值

源码：`packages/tools/src/verification/plan-builder.ts:102` 对 recipe 按空白 split；`packages/tools/src/verification/task-verifier.ts:190` 在 args 存在时走 runArgv。设计上这两个入口分别代表 shell recipe 和 executable + argv；转换混淆了二者。

真实复现：

| 发现的必测命令 | 原生真实进程 | 当前转换后的验收 | 完整 Harness turn |
| --- | --- | --- | --- |
| `node -e "process.exit(7)"` | exit 7 | PASS；Node 求值字符串 `"process.exit(7)"`，没有执行 exit | completed / verified_complete |
| `node pass.cjs && node required-fail.cjs` | 第二条执行，exit 9 | PASS；`&& node required-fail.cjs` 变为第一程序的参数 | completed / verified_complete |
| `node "test suite/required-check.cjs"` | exit 0，真正执行 checker | FAIL；文件路径和引号被拆开 | 非本行完整 turn；TaskVerifier 真实执行 |

负对照：显式 `{command: process.execPath,args:["-e","process.exit(7)"]}` 当前正确 FAIL。必须保留 structured argv 行为，不可统一改成 shell。

最小方案：

1. 发现的命令本来就是完整 recipe：planToVerificationSpecs 保留 `command` 原文，不造 `args`。
2. 必须同轮处理 `buildVerificationPlan:69` 的未引用 changedTests 插值。未知 recipe 不自动添加文件名参数，直接运行已有完整必测入口；不要发明通用跨平台 shell parser，也不要把路径当命令语法。若保留 targeted 优化，只能在有明确 structured argv 或验证过的 runner 参数契约时启用。
3. 不改 TaskVerifier 对显式 args 的执行路径，不改 PermissionEngine / ToolOrchestrator / SandboxManager 规则，显式 task.verification 优先级保留。

验收：上述 exit 7 / 9 完整 turn 必须 `failed / verification_failed`，且 Verification completion passed=false；空格路径正确 PASS；原始 recipe 精确不变；显式 argv 中字面 `& | ; $ quotes` 不启动额外命令；空验证仍 fail-closed；所有已有验证和平台执行安全用例通过。

额外安全反例（`verification-compatibility.json`）：changedPath 为 `src/a.test.ts;node marker.cjs;tail.test.ts`，当前 argv 不执行 marker；若只修 split，把生成字符串交回 shell，会执行 marker。真实进程已证明这一朴素修复不安全。本报告不声称当前代码存在该 shell 插值执行漏洞。

## 改进 2：确定性发现排序，保留根主验收入口

源码：`packages/tools/src/command-discovery.ts:340` 和 `:358` 的比较器在双方同为 package.json 时仍返回 -1，违反比较器约定；第一次排序把后面的子包排到根 manifest 前面，`slice(0,60)` 可删掉根必测，再 summarize 也无法恢复。

真实 fixture：根 package.json 的 test / build 都为 `node required-fail.cjs`（exit 11），61 个子包提供 `node smoke.cjs`。discoverCommands 确实检查了根 manifest，但返回 60 个子包命令，保留根命令数为 0，summary 选无关 smoke；完整 Harness turn 最终 completed / verified_complete。原始根必测运行 exit 11。

本仓库本身也出现同一问题：`repo-commands.json` 在建立审计 fixture 前生成，summary.test 是 `vitest run --config apps/cli/test-infra/n0-gaps-vitest.config.ts`，canonical 根 test 及根 build 已被截掉。该记录只证明错误发现/选择，没有实际启动整个本仓库测试套件。

最小方案：

1. 使用同一个合法 comparator 同时服务发现列表与 summarize；置信度/来源/根 manifest/精确 script 名的排序必须明确，双方相等返回 0，再用稳定 file/name/command 作为必要 tie-break。
2. parsePackageJson 处已知道 script 名，可用可选 provenance `scriptName` 明确区分主 `test` 与 `test:watch` / `test:coverage` 等变体。不可用命令文本猜脚本身份。
3. 返回上限 60 保留：先确保选定各 kind 的权威主入口能进入列表，再保留剩余有序发现项，避免大 monorepo 淹没根必测。主 test/typecheck/build 符合每类最多一个的现有摘要接口，不引入新架构。
4. 不把来源子包的命令伪装为根命令。缺少可确定根主入口时维持可审计、fail-closed 行为；cwd 丢失/启发式包目录问题如无范围预算可另列，不要在本轮猜测真实包边界。

验收：61+ 子包/多个 test 变体时根 canonical test/build 仍保留且 summary 正确；至少 60 上限前后、同置信度不同来源、随机文件创建顺序结果稳定；坏根 test + 好子包 smoke 完整 turn 必须 FAIL；显式 verifier/planner override 和 declared task.verification 不受影响；返回 cap 不扩大。

## 原始证据与复现

```sh
node .ci/agent-round2-20261004/tools-audit/reproduce-verification.mjs
node .ci/agent-round2-20261004/tools-audit/reproduce-compatibility.mjs
```

- `verification-defects.json`：所有 4 个 defectObserved=true；原始 source/dist SHA256、Node/platform、进程 outcomes、默认发现、计划/spec、完整 turn outcome。
- `quoted-required-failure-events.json` / `compound-required-failure-events.json` / `discovery-root-truncated-events.json`：完整原始 Harness events。
- `reproduce-verification.log`：脚本 exit 0；三次完整 turn 错误假完成摘要。
- `verification-compatibility.json` / `.log`：朴素 shell 修复的真实安全反例 + 原显式 argv 兼容对照。
- `repo-commands.json`：本仓库当前实际返回发现结果和 summary。
- fixture 和 Harness sessions 保留在此目录，仅用于本地原始复查，正式文档证据宜保留核心脚本/JSON/log/events，明确不包含生成 sessions 目录。
