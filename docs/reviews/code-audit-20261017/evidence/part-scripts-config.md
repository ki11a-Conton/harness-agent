# 脚本与仓库级配置 审查结果

范围：`scripts/`（214 个跟踪文件）、`.github/`（8 个 workflow）、`tasks/`（63 个 md）、仓库根配置与非代码文档（17 个根文件 + 22 个 `plan*.md`）。
审计基线：`git rev-parse HEAD` = `44f3f51f6ecfdc0da653a6e76a4149d032729961`，工作树 `git status --short` 为空。
方法：`git ls-files` 取确定清单；脚本按"失败处理 / 绝对路径 / 端口硬编码 / 引用面 / 冻结哈希"五类批量扫描；配置按"声明 vs 磁盘实测"逐项对账。**全程只读，未执行任何会改动仓库的脚本。**

## 0. 结论摘要

- 覆盖 **214 个 scripts 文件 + 8 个 workflow + 63 个 tasks md + 39 个根文件**，共 18 条发现：A 类 6、B 类 4、C 类 3、D 类 5；级别 P1×1、P2×11、P3×6、P0×0。
- 最该先修的 3 条：**SCF-001**（`packages/orchestration` 从未进入 `tsc -b` 的工程图，`pnpm typecheck` 对它完全失效）、**SCF-009**（一个 `__pycache__/*.pyc` 被 git 跟踪，`.gitignore` 也没有任何 `*.pyc` 规则）、**SCF-003/SCF-004**（`HANDOVER.md` 与 `CAPABILITY_MATRIX.*` 在 HEAD 上与事实直接冲突）。
- 结构性结论：`scripts/` 的**失败处理是可移植性最好的部分**（4 个 `.ps1` 全部设 `$ErrorActionPreference`，`.sh` 全部 `set -e`，175 个代码文件零硬编码绝对路径），问题集中在**配置漂移**（三份清单各自手写）与**文档堆积**（根目录 22 个 plan 文件无索引）。
- 明确的好消息（避免 Lead 误判为问题）：根 `package.json` 的 35 个脚本引用路径**全部存在**，4 个 devDependencies **全部被使用**；`vitest.config.ts` 的 `include` 与 618 个 `*.test.ts` 的实际分布一致（唯一漏掉的 23 个全部是有意排除的证据快照/子进程夹具）。

## 1. 发现总表

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| SCF-001 | `tsconfig.json:1-27` | `packages/orchestration` 不在 root `references` 中，且无任何包依赖它 → `tsc -b` 工程图完全不含它，`pnpm typecheck`/`pnpm build` 对该包 8 个源文件零检查；只有发布打包器（`scripts/release/portable.mjs` 按 workspace inventory 枚举）才会真正构建它 | D | P1 | 把 `{"path": "./packages/orchestration"}` 加入 `tsconfig.json` references，并在 CI 增加 `tsc -b --dry` 与 `Get-ChildItem packages -Directory` 的集合比对 |
| SCF-002 | `tsconfig.noemit.json:8-34` | `paths` 表 24 条与 `tsconfig.json` 的 24 条 `references` 是两份独立手写清单，已实际漂移（noemit 含 `@ar/orchestration`，references 不含） | A | P2 | 删除手写 `paths`（`include` 已覆盖全部 `packages/*/src/**/*.ts`），或由 workspace 清单生成 |
| SCF-003 | `HANDOVER.md:3` | 声明"当前计划是 `plan(20260930-061557).md`；没有悬空 plan.md"；实测该文件不存在，根目录有 `plan.md` + 21 个 `plan(...).md` | A | P2 | 该段改为指向 `plan.md` 与新增的 `docs/plans/INDEX.md`；或把 HANDOVER 标注为"历史交接，勿作现状依据" |
| SCF-004 | `CAPABILITY_MATRIX.md:5-6`、`CAPABILITY_MATRIX.json` | 跟踪的快照记录 `gitSha=27f7045e…`、`generatedAt=2026-08-26`，而 HEAD 是 `44f3f51f`；文件自称 `NOT RELEASE EVIDENCE` 却仍在版本控制里充当能力面索引 | B | P2 | 生成物不入库（改为 CI artifact），或加 `capability:audit` 校验"快照 gitSha == HEAD"否则拒提交 |
| SCF-005 | `.github/workflows/ci.yml:1-1817` | 单文件 1817 行，混合 bash 与 PowerShell 两套语法，内联 6 处 R84 campaign 篡改夹具构造，并把 `pnpm test` 的 5 条 exclude 在注释里重述一遍 | A | P2 | 拆为 `ci-typecheck / ci-test / ci-benchmark / ci-release-gate` 四个可复用 workflow，夹具构造下沉到 `scripts/ci/` |
| SCF-006 | `.github/workflows/windows-acceptance.yml:60` | 单行硬编码 33 个测试文件路径作为 Windows 门禁清单，与 `pnpm test` 的收集范围重叠；新增回归测试若不加进这一行，就永远不进 Windows 门禁 | A | P2 | 改为"跑 `pnpm test` 全量 + 只对 Windows 特化文件追加"，或把清单落到 `apps/cli/test-infra/windows-gate.txt` 并加存在性校验 |
| SCF-007 | `.github/workflows/deepseek-ui-installed.yml:38,75,77`、`gen1-acceptance.yml:82` | 产物版本号 `1.10.0` / `1.9.0` 硬编码至少 6 处，而根 `package.json` 的 `version` 是 `0.1.0`；升版本必须手工同步两个 workflow | D | P2 | 从 `package.json` 读版本（`node -p "require('./package.json').version"` 写入 `$GITHUB_ENV`） |
| SCF-008 | `.github/workflows/deepseek-ui-installed.yml:36`、`gen1-acceptance.yml:105`、`windows-acceptance.yml:52` | 测试运行器不统一：这 3 处用 `node --test`，其余 595 个测试走 vitest；两套断言语义与报告格式并存 | A | P2 | 给 `scripts/**/*.test.mjs` 单独建 `vitest.scripts.config.ts` 并统一到 `pnpm test` |
| SCF-009 | `scripts/research/agent-next5-20261005/__pycache__/frozen-acceptance.cpython-312.pyc` | 一个 Python 字节码缓存被 git 跟踪；`.gitignore` 全文（82 行）没有任何 `*.pyc` / `__pycache__/` 规则 | C | P2 | `git rm --cached` 该文件；`.gitignore` 追加 `__pycache__/` 与 `*.pyc` |
| SCF-010 | `fix-links.mjs:1-96` | 裸露在仓库根的破坏性修复脚本：无 dry-run、无 CLI 参数，直接 `fs.rmSync(childPath,{recursive:true,force:true})` 再 `fs.symlinkSync(target + path.sep, childPath, "junction")`；无 `process.platform` 守卫（junction 仅 Windows 有意义）；`package.json` 与 CI 均不引用 | C | P2 | 移入 `scripts/dev/fix-links.mjs`，加 `--dry-run` 默认与 `process.platform !== "win32"` 早退 |
| SCF-011 | `start-web.cmd:8-9` | `start "" http://127.0.0.1:8787` 在 `node apps\web\dist\main.js` **之前**执行，慢启动时浏览器先打开到未监听的端口；端口 8787 硬编码且无覆盖入口 | D | P3 | 先启动服务并轮询就绪再开浏览器；端口抽到环境变量（`%~1` 或 `HARNESS_WEB_PORT`） |
| SCF-012 | `.gitignore:32,38,45,52,63,73,82` | 7 条规则用于隐藏"生成后应删除"的临时产物；其中 `apps/cli/src/e4-r24-fixture-*.test.ts` 落在源码目录内，任何命中该模式的真实测试会被静默忽略且 `git add` 不报错 | C | P3 | R24/R46 夹具跟进 R56 的做法（已迁到 OS 临时目录），删掉这两条源码目录内的 ignore 规则 |
| SCF-013 | `.gitattributes:137-138` | 两条规则指向已删除文件 `plan(20261004-ui-preregister).md`、`plan(20261004-022759).md`（`Test-Path` = False，`git ls-files` 无此文件） | C | P3 | 删除这两行 |
| SCF-014 | 根目录 22 个 `plan*.md` + `tasks/` 63 个 md + 根 5 个回顾文档 | 计划与回顾文档无索引：`plan.md`(7.3KB) 与 21 个 `plan(...).md`（合计约 105KB）平铺在仓库根，`tasks/` 63 个 md 无 README 索引；新接手者无法判断哪个是当前计划 | B | P2 | 建 `docs/plans/INDEX.md`（日期/主题/状态/对应 evidence 目录）；归档到 `docs/plans/archive/`；根目录只留 `plan.md` |
| SCF-015 | `package.json:11,31` | `test` 与 `test:coverage` 的 5 条 `--exclude` 完全相同、逐字重复；`test:perf`/`test:soak` 写成 `vitest run .perf.test.ts`（无 glob，依赖 vitest 的子串过滤语义，易误解） | A | P3 | 抽出 `--exclude` 到一个 `vitest.test.ts` 共享片段或改用 `--config`；后两条加引号 `"**/*.perf.test.ts"` 并写明是过滤而非 glob |
| SCF-016 | `pnpm-workspace.yaml:6-8`、`.npmrc:1` | 同一开关 `verifyDepsBeforeRun`/`verify-deps-before-run` 在两处配置，且 `pnpm-workspace.yaml` 的注释专门解释"`.npmrc` 不够" | B | P3 | 保留 pnpm-workspace.yaml 一处并删 `.npmrc` 该行，或反之，并在 README 记录为什么 |
| SCF-017 | `docs/evidence/**/manifest.json`（8+ 份） | 4 个 `scripts/*.ps1` 的 sha256 被固化进 8 份以上历史证据清单（`scripts/baseline-plan.ps1` = `c47d287c…` 等），任何字节改动都会让这些历史证据失去可验证性；实测当前 4 个文件哈希已全部与清单不符（见 §4） | B | P2 | 明确"这些脚本已冻结"，改动必须新开证据轮次；在 `scripts/benchmark/README` 写清冻结边界 |
| SCF-018 | `scripts/research/`（132 文件）、`scripts/e4/`（30 文件） | 两目录合计 162 个一次性研究/证据生成脚本，多数只被 `docs/**.md` 与冻结的 evidence 引用，不被 CI/`package.json` 调用；无 README 说明哪些仍可运行 | B | P2 | 在 `scripts/research/README.md` 建立"轮次 → 入口脚本 → 证据目录 → 是否仍可运行"索引；把已封轮的移入 `scripts/research/archive/` |

## 2. 分模块明细

### 2.1 根构建配置（`tsconfig*.json`、`vitest.config.ts`、`pnpm-workspace.yaml`、`.npmrc`）

一句话定位：**三份"包清单"各自手写，已经漂移；构建门禁存在一个真实缺口。**

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| SCF-001 | `tsconfig.json:1-27` | `packages/orchestration` 未进 `tsc -b` 工程图 | D | P1 | 加入 references |
| SCF-002 | `tsconfig.noemit.json:8-34` | `paths` 与 `references` 两份清单漂移 | A | P2 | 删手写 paths |
| SCF-016 | `pnpm-workspace.yaml:6-8`、`.npmrc:1` | 同一开关两处配置 | B | P3 | 收敛到一处 |

#### 说明 · SCF-001

证据（全部为实测命令输出）：

- `tsconfig.json` 的 `references` 共 **24 条** = 22 个 `packages/*` + `apps/cli` + `apps/web`。
- `Get-ChildItem packages -Directory` = **24** 个目录。集合差：磁盘有而 references 无的是 `packages/orchestration` 与 `packages/store`。
- `packages/store` 被覆盖：`packages/harness/package.json` 声明了 `"@ar/store": "workspace:*"`，因此它作为依赖进入 `tsc -b` 的工程图（`tsc -b --dry` 输出里出现 `Project '…/packages/store/tsconfig.json' is up to date`）。
- `packages/orchestration` 没有任何包声明依赖：对 `"@ar/orchestration"` 的全仓 grep 命中 210 处，但除自身 `package.json`/`src/index.ts` 外，全部落在 `docs/**`（证据/报告）、`scripts/release/portable.mjs`、`scripts/release/portable.test.mjs`、`mem.md`。`tsc -b --dry` 的 25 个项目里**不出现** orchestration。
- 该缺口已被历史踩过并记录：`docs/gen1-release-comparison.md:79` 原文——"根 `tsconfig.references` 不是完整 workspace 清单；首次不可变构建在打包时缺 `@ar/store`/`@ar/orchestration` 而拒绝"。当时的修法是在 `scripts/release/portable.mjs` 里改成按 pnpm workspace inventory 枚举，**没有修 root references**，所以 `pnpm typecheck` 的缺口至今仍在。

为什么算问题：`AGENTS.md` 把 `pnpm typecheck`（`tsc -b`）定义为唯一的静态检查。现在 `packages/orchestration` 的 `work-item/tracker/workflow-loader/reconciler/scheduler/retry-policy/workspace-manager/worker` 8 个模块的任何类型错误都**不会**在 PR 阶段被拦住，只会在发布打包时爆出来——即"门禁在错误的时间点才生效"。

建议改法：`tsconfig.json` 的 `references` 追加 `{ "path": "./packages/orchestration" }`；并在 CI 的 typecheck 步骤前加一步集合校验（`comm` 一份 `git ls-files 'packages/*/package.json'` 与 references），防止第三次漂移。

#### 说明 · SCF-002

`tsconfig.noemit.json` 的 `paths` 有 24 条（含 `@ar/orchestration`、`@ar/store`），`tsconfig.json` 的 `references` 有 24 条（不含 orchestration）。同一份"包清单"在两个文件里各写一遍，已经出现实际不一致。

`include` 是 `["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"]`，已经覆盖全部源文件；`paths` 在这里只是让 `@ar/*` 解析到 `src` 而非 `dist`，属于可选项。删除手写 `paths`（或改为脚本生成）能一次性消灭这个漂移面。附带收益：`mem.md:895` 记录过"Windows 手工建 workspace 链接"的运维绕路，正是因为 `paths` 让人误以为 node_modules 链接不重要。

### 2.2 CI workflow（`.github/workflows/`，8 个文件）

一句话定位：**功能覆盖充分（双平台、离线优先、证据产物化），但可维护性靠注释维持——单个 `ci.yml` 1817 行，门禁清单硬编码。**

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| SCF-005 | `ci.yml:1-1817` | 单体工作流 | A | P2 | 拆四个可复用 workflow |
| SCF-006 | `windows-acceptance.yml:60` | 33 个测试文件硬编码 | A | P2 | 改全量 + 特化补充 |
| SCF-007 | `deepseek-ui-installed.yml:38,75,77`、`gen1-acceptance.yml:82` | 版本号硬编码 6 处 | D | P2 | 从 package.json 读 |
| SCF-008 | `deepseek-ui-installed.yml:36`、`gen1-acceptance.yml:105`、`windows-acceptance.yml:52` | `node --test` 与 vitest 并行 | A | P2 | 统一到 vitest |

#### 说明 · SCF-005 / SCF-006

`ci.yml` 实测 1817 行，`runs-on` 出现 7 次（`matrix.os` 与 `ubuntu-latest` 混合），同时含 bash 段（`if ! node … ; then`）与 PowerShell 段（`$first = (node …)`、`2>&1 | Write-Host`），以及 6 处现场构造 R84 篡改夹具（`.ci/r84-tamper`、`.ci/r84-summary-only`、`.ci/r85-missing`）。

`windows-acceptance.yml:60` 的单行 `pnpm exec vitest run` 后跟 33 个显式文件路径（`packages/tools/src/process/executor.test.ts` … `packages/gateway/src/transport-conformance.test.ts`）。风险是确定性的：新增一个 Windows 相关回归测试，作者必须知道去改这一行，否则该测试永远不进 Windows 门禁；而 `pnpm test` 的 `include` 是 `packages/*/src/**/*.test.ts`，本来就会收集它——两套收集逻辑的差值就是漏检面。

#### 说明 · SCF-007

`deepseek-ui-installed.yml` 里 `--version 1.10.0` 出现 3 次（L38/L75/L77），`gen1-acceptance.yml` 里 `--version 1.9.0` 与产物名 `harness-agent-1.9.0-portable.tar.gz` 出现于 L82。根 `package.json` 的 `"version": "0.1.0"`。三个版本号互不相干且都靠手工同步，属于典型的"升版本 = 改多处"漂移点。

#### 说明 · SCF-008

根 `vitest.config.ts` 的 `include` 只覆盖 `packages/*/src/**` 与 `apps/*/src/**`，因此 `scripts/**/*.test.mjs` 天然不在 vitest 范围——这三处 `node --test` 是"不得不"。但结果是仓库同时存在两套测试运行器/两套报告语义（vitest 的 JSON reporter 与 node:test 的 TAP 风格），`scripts/ci/windows-acceptance-report.mjs` 解析的是 vitest JSON，而 `windows-acceptance.yml:52` 同时跑一个 `node --test` 的脚本测试。建议给 scripts 目录建独立 vitest config 收编，而不是长期维持双轨。

### 2.3 `scripts/` 可移植性与卫生

一句话定位：**失败处理与路径可移植性是这块最好的一面（零发现），问题只有一处破坏性根脚本和一处被跟踪的字节码。**

批量扫描结论（作为"零发现"的证据，非推测）：

- 4 个 `.ps1`（`baseline-plan.ps1`、`benchmark/run-campaign.ps1`、`benchmark/selfcheck-r89-runner.ps1`、`benchmark/selfcheck-r94-runner.ps1`、`benchmark/selfcheck-campaign-runner.ps1`）**全部**设置了 `$ErrorActionPreference`，无遗漏。
- 所有 `.sh` **全部**含 `set -e`，无遗漏。
- 175 个代码文件（`.mjs/.js/.py/.ps1/.sh`）中，零处硬编码绝对可执行路径。命中的 9 处 `C:/`、`D:/` 全部在注释/用法示例/负例测试串里（`r97-closed-loop.mjs:56` 是 `--arms-root D:/arms` 用法示例、`portable.test.mjs:104` 是 `safePath()` 的非法输入断言 `'C:/x'`、`windows-acceptance-report.test.mjs:8` 是 `'C:\\work\\…'` 夹具）。
- 零处 `process.chdir`。
- 端口硬编码：`127.0.0.1:8317` 出现在 8 个 research 脚本里，是本地代理端点的预注册常量（`freeze-n6/n7/p-*preregistration.mjs`、`execution-common.mjs:92`），属冻结配置的一部分，不算缺陷；`8787` 只出现在 `portable.mjs:281` 的 README 文案里（产品默认端口），不是逻辑。
- 临时文件写仓库根的风险**已经被系统性识别并缓解**：`.gitignore` 的注释逐条记录了 e4-09 推广基准"在非干净树上拒绝运行"的机制，`/_tmp_*`、`.tmp-mining-*/`、`apps/cli/test-infra/e4-r55-runs/` 都是为此加的。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| SCF-009 | `scripts/research/agent-next5-20261005/__pycache__/frozen-acceptance.cpython-312.pyc` | 字节码缓存被跟踪，`.gitignore` 无 `*.pyc` | C | P2 | `git rm --cached` + 补 ignore 规则 |
| SCF-010 | `fix-links.mjs:1-96` | 根目录破坏性脚本，无 dry-run / 无平台守卫 / 无引用 | C | P2 | 移入 scripts/ 并加保护 |
| SCF-017 | `docs/evidence/**/manifest.json` | 4 个 ps1 的哈希被 8+ 份历史证据固化 | B | P2 | 明确冻结边界 |

#### 说明 · SCF-009

`git ls-files` 中确认存在且仅存在一个：`scripts/research/agent-next5-20261005/__pycache__/frozen-acceptance.cpython-312.pyc`。`.gitignore` 82 行中 `Select-String -Pattern 'pyc|__pycache__'` 零命中。同类脚本 `scripts/research/agent-next5-20261005/frozen-acceptance.py` 是正常跟踪的，`.pyc` 是它被本地执行后的副产物——典型的"跑一次就脏"入口。后果：不同 Python 版本会在每个 `__pycache__` 下产生新 `.pyc`，未来必然出现新的未跟踪污染；而当前这一个已经进了历史，`git clone` 后也无意义（字节码对解释器版本/路径敏感）。

#### 说明 · SCF-010

`fix-links.mjs` 全文 96 行，核心动作为：`fs.rmSync(childPath, { recursive: true, force: true })` 后 `fs.symlinkSync(target + path.sep, childPath, "junction")`。三个具体问题：

1. **无 dry-run、无确认**。脚本注释自称"修复 pnpm 在 Windows junction 下静默失败留下的空目录链接"，但判定"空目录"用的是启发式：`items.length === 0 || (items.length <= 1 && !items.includes("package.json"))`。一个只含 `node_modules` 子目录的合法包目录会被判为"空"并 `rmSync` 删除。
2. **无平台守卫**。`"junction"` 类型在 `process.platform !== "win32"` 时抛 `EINVAL`；脚本没有早退，在 Linux/macOS 上会以 `FAIL: … (EINVAL)` 的形式把每个候选都刷一遍，退出码仍是 0（错误被 `catch` 吞掉，只 `skipped++`）。
3. **无引用、无入口**。`package.json` 无对应 script，CI 8 个 workflow 均未调用，`docs/**` 无使用说明。同时它依赖 pnpm 内部布局 `node_modules/.pnpm/<pkg>@<ver>/node_modules/<name>`——这是 pnpm 未承诺的私有结构。

建议：移入 `scripts/dev/fix-links.mjs`；默认 `--dry-run`；`if (process.platform !== "win32") { console.error("Windows only"); process.exit(2); }`；把"空目录"判定收紧为"无 `package.json` 且无 `dist` 且无 `index.js`"；`catch` 分支累加错误并在末尾以非零退出。

#### 说明 · SCF-017

实测哈希（`Get-FileHash -Algorithm SHA256`，工作树字节）：

| 文件 | 证据清单中的值 | 当前实测值 | 是否一致 |
| --- | --- | --- | --- |
| `scripts/baseline-plan.ps1` | `c47d287c6f0e3917ee6856483889f8778b5be35ea56e8a4ee21ef1a5cc1316b3` | `1aed6c57984a7ae9a08cc3df9e2010dc62964ae7a5cc4c58d0a4f5b35b3707e9` | 否 |
| `scripts/benchmark/selfcheck-r89-runner.ps1` | `879342a26cc465f24ca7fd72b345d84be2ebc3b05cdd942f6812d07a90ab0f0f` | `d60d8acd63baba6f64bfd07d95d0d509b5e245d92b2d3a13a3bbc74ccd3ada04` | 否 |
| `scripts/benchmark/selfcheck-r94-runner.ps1` | `469362efb7ac66258747f6b6afd5122cc6d444b25a2f9d387245bbbb429ef9bb` | `38f05fda381d99ee8b6e26279bcf1d4a66b4b3307456ed22338b4e6825f133d5` | 否 |
| `scripts/benchmark/selfcheck-campaign-runner.ps1` | `2b61d2c1ac3ef4dedc01f17959956885dec851fb089e7cd6b57a2a38f38fd35f` | `74b87a9400b945c5e9ae3d9f57bbd510927778ce3616a0a684e5d5d7f1909473` | 否 |

**这不是缺陷**（清单是"某轮冻结时的快照"，R89/R94 之后按计划重写过这些脚本，`docs/E4-R89-report.md:245`、`docs/E4-R94-report.md:249` 记录了它们被新增/重写）。记录它的价值在于两点：(a) 证明这 4 个文件"改一个字节就让 8+ 份历史证据失去可验证性"，属于 METHOD §1 的 B 类"为什么现在不能动"；(b) 说明冻结机制**只写不验**——没有任何 CI 步骤会重新核对，所以它挡不住后来的修改，只是事后留痕。

### 2.4 根目录脚本与配置（`start-web.cmd`、`.gitignore`、`.gitattributes`、`package.json`）

一句话定位：**配置基本可用，问题是"用 ignore 规则掩盖生成物"的历史债与两条真正失效的 `.gitattributes` 规则。**

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| SCF-011 | `start-web.cmd:8-9` | 先开浏览器后起服务；端口硬编码 | D | P3 | 就绪探测后再开；端口可覆盖 |
| SCF-012 | `.gitignore:32,38,45,52,63,73,82` | 7 条规则隐藏生成物；2 条落在源码目录 | C | P3 | 生成物改迁 OS 临时目录，删规则 |
| SCF-013 | `.gitattributes:137-138` | 2 条规则指向已删除的 plan 文件 | C | P3 | 删除 |
| SCF-015 | `package.json:11,31` | `test`/`test:coverage` 的 exclude 逐字重复 | A | P3 | 抽共享片段 |

#### 说明 · SCF-011

```
echo [web] starting at http://127.0.0.1:8787
start "" http://127.0.0.1:8787
node apps\web\dist\main.js
```

`start ""` 立即返回，浏览器在 `node` 进程开始监听之前就发出请求；冷启动或 `pnpm build` 之后首次运行（脚本自己在 L4-7 有 `if not exist "apps\web\dist\main.js" ( call pnpm build … )`）时，用户会看到 `ERR_CONNECTION_REFUSED` 而误判为启动失败。端口 8787 出现两次且无覆盖入口，冲突时 `node` 直接 `EADDRINUSE` 退出，浏览器标签停在一个错误页。

（注意：本会话运行态看到的 `http://127.0.0.1:13740` 是 DSH 自身的 Web GUI，与本仓库 `agent.mjs web` 的 8787 无关，**不构成"端口写错了"**。）

#### 说明 · SCF-012

`.gitignore` 82 行里有 7 条是为"生成后应删除但可能残留"的文件准备的：`apps/cli/src/e4-r24-fixture-*.test.ts`(32)、`apps/cli/test-infra/observation-fixtures/*.test.ts`(38)、`apps/cli/test-infra/diagnostic-fixtures/*.test.ts`(45)、`apps/cli/src/e4-r55-mutated-chain.generated.ts`(52)、`.tmp-mining-*/`(63)、`/_tmp_*`(73)、`apps/cli/test-infra/e4-r55-runs/`(82)。每条的注释都说明动机是"e4-09 推广基准在脏树上拒绝运行"。

这条缓解链本身是自洽的，但方向是"让脏东西看不见"而不是"不产生脏东西"。R56（注释 L57-63）已经把 case-mining 的临时树迁到 OS 临时目录，证明迁移是可行的；R24 与 R46 的夹具还在源码目录里。其中 `apps/cli/src/e4-r24-fixture-*.test.ts` 最危险：它在**源码目录**且被 ignore，若将来有人真的写一个名叫 `e4-r24-fixture-xxx.test.ts` 的正经测试，`git status` 与 `git add` 都不会提示，测试静默不入库。

#### 说明 · SCF-013

`.gitattributes:137-138` 声明 `plan(20261004-ui-preregister).md whitespace=-blank-at-eof` 与 `plan(20261004-022759).md whitespace=-blank-at-eof`，但 `Test-Path` 两者均为 `False`，`git ls-files` 中也不存在。是删除 plan 文件时漏清的规则。同文件其余规则（`whitespace=cr-at-eol` 14 条、`-text` 证据白名单）经 `git ls-files --eol` 实测仍生效——例如 `packages/contracts/src/contracts.test.ts` 仍是 `i/crlf w/crlf`，规则正在被使用，不是死代码。

### 2.5 文档与计划堆积（根 `*.md`、`tasks/`、`scripts/research/`、`scripts/e4/`）

一句话定位：**仓库把"每一轮的证据与计划"全部留在工作树里，靠文件名（日期/轮次）当索引；规模已经超出手工维护的边界。**

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| SCF-014 | 根 22 个 `plan*.md` + `tasks/` 63 md + 根 5 个回顾文档 | 无索引，当前计划不可辨 | B | P2 | 建 `docs/plans/INDEX.md` + 归档 |
| SCF-018 | `scripts/research/` 132 + `scripts/e4/` 30 | 一次性脚本堆积，无可用性索引 | B | P2 | 建索引 + archive 分区 |
| SCF-003 | `HANDOVER.md:3` | 交接文档与事实冲突 | A | P2 | 更新或标注历史 |
| SCF-004 | `CAPABILITY_MATRIX.md`/`.json` | 跟踪的快照落后 HEAD 两个月 | B | P2 | 改 CI artifact |

#### 说明 · SCF-014 / SCF-018

实测规模：根目录 `plan*.md` **22 个**（`plan.md` 7.3KB + 21 个 `plan(...).md`，`plan(20261008-before-gen1).md` 13.7KB 最大，`plan(20261008-gen1).md` 0.5KB 最小）；`tasks/` **63 个 md**（`AGENT-CONTEXT-MEMORY-20261004.md` 等，按轮次命名）；根目录另有 `mem.md`（881+ 行）、`optimization-report.md`、`reflection.md`、`HANDOVER.md`、`CAPABILITY_MATRIX.*`、`e3-review-baseline.json`。`scripts/research/` 132 个文件分属 16 个轮次目录（`agent-next2-20261005` … `web-dsh-20261004`），`scripts/e4/` 30 个文件里 22 个是一次性证据生成器。

命令面证据：`scripts/benchmark/selfcheck-*.ps1` 与 `scripts/baseline-plan.ps1` 在 `docs/**` 有密集引用（`docs/E4-R84-report.md:478`、`docs/E4-R94-report.md:183`、`docs/E4-R89-report.md:41`），说明这些**不能删**，但也没有任何索引告诉读者"哪一条命令现在还能跑、对应哪份证据"。

这属于 METHOD §1 的 B 类：**现在不能简单删除**（冻结证据以文件哈希引用了它们，删了证据就断链），但必须有索引与分区，否则每年新增 16 个轮次目录，`scripts/research/` 会变成不可导航的考古层。

#### 说明 · SCF-003 / SCF-004

`HANDOVER.md:3` 原文："仓库规模：`packages/（24 个包）`。当前计划是 `plan(20260930-061557).md`；没有悬空 plan.md。" 实测：`Test-Path 'plan(20260930-061557).md'` = **False**；根目录存在 `plan.md` 且另有 21 个 `plan(...).md`。两个断言都错。交接文档的第一段就是接手者的入口，这一条的误导成本最高。

`CAPABILITY_MATRIX.md:5-6` 记录 `generatedAt: 2026-08-26T09:55:36.734Z`、`gitSha: 27f7045e…`；`git merge-base --is-ancestor 27f7045e HEAD` 退出码 0，即它是 HEAD 的祖先提交。文件顶部已自标 `NOT RELEASE EVIDENCE — informational repository snapshot`，说明作者知道它是快照；问题在于它被提交进版本控制并作为"能力面"索引出现，读者无法从文件本身判断它比 HEAD 落后多少。

## 3. 覆盖清单

清单来源：`git ls-files scripts` = **214**、`git ls-files .github` = **8**、`git ls-files tasks` = **63**、根目录跟踪文件 = **39**（`git ls-files | 无 '/' 的文件`）。

### 3.1 `.github/`（8/8 逐个读过）

| 文件 | 行数 | 结论 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | 1817 | 见 SCF-005 |
| `.github/workflows/windows-acceptance.yml` | 70 | 见 SCF-006、SCF-008 |
| `.github/workflows/deepseek-ui-installed.yml` | 89 | 见 SCF-007、SCF-008 |
| `.github/workflows/gen1-acceptance.yml` | 127 | 见 SCF-007、SCF-008 |
| `.github/workflows/candidate-export.yml` | 66 | 无问题 |
| `.github/workflows/deepseek-failure-forensics.yml` | 39 | 无问题 |
| `.github/workflows/installed-ui-diagnostics.yml` | 91 | 无问题（内联 `node --input-type=module` 诊断片段，长度可控） |
| `.github/workflows/source-audit-forensics.yml` | 28 | 无问题 |

### 3.2 `scripts/`（214 文件）

聚合规则（METHOD §4.3）：(a) 175 个代码文件按 `.ps1/.sh/.mjs/.py` 分类批量扫描失败处理、绝对路径、`chdir`、端口硬编码；(b) 39 个夹具/数据文件（`.json`/`.jsonl`/`.md`/`.txt`/`.source.txt`）按"被哪个入口脚本读取"核对，不逐行读内容；(c) **132 个 `scripts/research/**` 与 30 个 `scripts/e4/**` 未逐行**，替代手段为：入口引用面 grep（`docs/**`、`package.json`、workflow 命中计数）+ 冻结证据哈希核对 + 目录轮次归属，理由见下。

#### `scripts/` 根（1 文件）

| 文件 | 结论 |
| --- | --- |
| `scripts/baseline-plan.ps1` | 有 `$ErrorActionPreference`；被 `docs/E4-R74-baseline-runbook.md:172`、`docs/r81-evidence/r81-plan-identity.txt:10` 引用；哈希被冻结，见 SCF-017 |

#### `scripts/benchmark/`（32 文件）

代码 9：`context-compaction.mjs`、`message-history.mjs`、`workspace-knowledge.mjs`、`r89-fake-cli.mjs`、`run-campaign.ps1`、`selfcheck-campaign-runner.ps1`、`selfcheck-r89-runner.ps1`、`selfcheck-r94-runner.ps1`、`fixtures/r84-campaign/generate.mjs` — 均无问题；4 个 `.ps1` 全部设 `$ErrorActionPreference`；`generate.mjs` 由 `package.json:benchmark:campaign:fixture-check` 调用。3 个 selfcheck 与 `run-campaign.ps1` 见 SCF-017（哈希冻结）。

夹具 23：`fixtures/r84-campaign/**`（`campaign-summary.json`、`manifest.jsonl`、`results/{adversarial,stress}/**`、`cases/{adversarial,stress}/**/*.md`）与 `fixtures/r89-cases/**`（`cases/{adversarial,solo,stress}/**/*.md`）— 夹具数据，非代码；由 `package.json:benchmark:campaign:validate` 显式引用，无问题。

#### `scripts/ci/`（6 文件）

| 文件 | 结论 |
| --- | --- |
| `coverage-acceptance-report.mjs` + `.test.mjs` | 无问题（测试与实现同目录，未被根 vitest include 收集——由 `node --test` 运行，见 SCF-008） |
| `deepseek-failure-forensics.mjs` | 无问题（被 `deepseek-failure-forensics.yml:39` 调用） |
| `formal-failure-forensics.mjs` | 无问题（被 `source-audit-forensics.yml:28` 调用） |
| `windows-acceptance-report.mjs` + `.test.mjs` | 无问题（被 `windows-acceptance.yml:64` 调用；测试由 `windows-acceptance.yml:52` 以 `node --test` 运行） |

#### `scripts/e3/`（1 文件）

`generate-review-baseline.mjs` — 无问题；生成根 `e3-review-baseline.json`。

#### `scripts/release/`（12 文件）

| 文件 | 结论 |
| --- | --- |
| `portable.mjs` | 无问题；按 pnpm workspace inventory 枚举全部包（正是它掩盖了 SCF-001 的 typecheck 缺口，见 `scripts/release/portable.mjs:99` 注释） |
| `portable-lib.mjs`、`portable-smoke.mjs`、`candidate-export.mjs`、`gen1-ci.mjs`、`gen1-export-draft.mjs`、`deepseek-installed.mjs` | 无问题（分别被 `candidate-export.yml:66`、`gen1-acceptance.yml:52,82,127`、`deepseek-ui-installed.yml:38,75,77` 调用） |
| `portable.test.mjs`、`portable-native.test.mjs`、`portable-deepseek-paths.test.mjs`、`candidate-export.test.mjs`、`gen1-export-draft.test.mjs` | 无问题（`node --test` 运行，见 SCF-008；`portable.test.mjs:104` 的 `'C:/x'` 是 `safePath()` 负例，非硬编码路径） |

#### `scripts/e4/`（30 文件）— **未逐行**

聚合结论：`A5-verdict-priority.md`（文档）、`r5-formal-pair.json`（配置）、`fixtures/n5-prereg-config.json`（夹具）为数据文件，无问题。28 个 `.mjs` 中，只有 `r5-real-formal.mjs`（`package.json:e4:formal-r5`）、`ci-readiness.mjs`（`e4:ci-readiness`）、`dual-platform-acceptance.mjs`（`e4:dual-platform`）有命令面入口；其余 25 个（`a5-drift-counterexample`、`n1-abi-negative-control`、`n3-dispatch-journal-contract`、`n5-prereg-closed-loop`、`n6-real-formal-ci`、`prereg-arm-isolated-worker`、`prereg-production-e2e`、`r88-red-evidence`、`r91-shim-probe`、`r92-authorization-request`、`r92-posix-shim-probe`、`r97-*`×12、`readiness-evidence-verify`、`tool-call-case-selection`）仅被 `docs/**` 与冻结 evidence 引用 → 见 SCF-018。未逐行理由：一次性证据生成器，其可执行性由冻结证据目录与 `docs/E4-R*.md` 报告描述，逐行读不改变"该归档"的结论。

#### `scripts/research/`（132 文件）— **未逐行**

按 16 个轮次目录聚合，每目录结论一致（见 SCF-018），逐目录清单：

- `research/README.md` — 无问题
- `agent-context-memory-20261004/`（6）：`README.md`、`context-probe.mjs`、`frozen-acceptance.py`、`memory-performance-probe.mjs`、`memory-probe.mjs`、`subreaper.py` — 见 SCF-018
- `agent-followup-20261005/`（6）：`README.md`、`frozen-acceptance.py`、`main-accounting.py`、`provider-probe.mjs`、`scoped-instruction-probe.mjs`、`symbol-production-probe.mjs` — 见 SCF-018
- `agent-measurement-20261003/`（8）：`README.md`、`input-manifest.json`、`pilot-data.mjs`、`prepare-pilot.mjs`、`provider-policy.mjs`、`skill-admission.mjs`、`skill-context.mjs`、`verify-artifacts.mjs` — 见 SCF-018
- `agent-next-20261004/`（12，含 `.json`/`.txt` 参考件）— 见 SCF-018；`.gitattributes` 为其单独设了 `text eol=lf`（注释：raw-byte 证据）
- `agent-next2-20261005/`（7）、`agent-next3-20261005/`（3）、`agent-next4-20261005/`（3）、`agent-next5-20261005/`（3，含 SCF-009 的 `.pyc`）— 见 SCF-018
- `agent-next6-20261005/`（9）、`agent-next7-20261006/`（22）、`agent-p-20261006/`（2）— 见 SCF-018
- `agent-trust-20261004/`（4）、`coding-agent-research-20261015/`（2）、`coding-audit-20261007/`（1）、`coding-evolution-20261015/`（4）、`coding-prompts-20261008/`（1）、`gen1-20261008/`（3）、`source-audit-20261007/`（6）、`web-dsh-20261004/`（4）— 见 SCF-018；例外：`coding-audit-20261007/acceptance.mjs` 与 `coding-prompts-20261008/acceptance.mjs` **有 CI 入口**（`ci.yml:107,110,121`、`windows-acceptance.yml:54,56`），非归档对象
- 顶层散件（15）：`deepseek-browser-interactions.mjs`、`deepseek-browser-model.mjs`、`deepseek-browser-observe.mjs`、`deepseek-browser-smoke.mjs`、`deepseek-frontend-vendor.mjs`、`deepseek-frontend-vendor.test.mjs`、`deepseek-live-host.mjs`、`deepseek-transport.test.mjs`、`source-agent-review.mjs`、`source-review-{claude,codex,edit,hermes,pi,verification}.mjs`、`web-branding-browser.mjs`、`web-branding-lib.mjs`、`web-branding.mjs`、`web-connection-browser.mjs`、`web-connection.test.mjs`、`web-navigation.test.mjs`、`web-workspace-composer.test.mjs` — 其中 4 个 `.test.mjs` 由 `deepseek-ui-installed.yml:36` 以 `node --test` 运行；其余见 SCF-018

### 3.3 `tasks/`（63 个 md）

聚合规则：按轮次前缀分组，逐文件只核对"是否有对应 evidence 目录 / 是否被 `plan*.md` 引用"两项。全部 63 个 md 均为轮次任务书（`AGENT-*.md`、`E4-*.md` 等），无脚本/配置内容 → 统一结论：**见 SCF-014（需索引）**，无单文件级缺陷。

### 3.4 根目录（39 个跟踪文件）

| 文件 | 结论 |
| --- | --- |
| `package.json` | 见 SCF-015。35 条脚本引用路径全部存在（实测 50 处路径 token / 35 唯一，缺失 0）；4 个 devDependencies 全部被使用（`typescript`→`tsc -b`、`vitest`→`vitest run`、`@vitest/coverage-v8`→`coverage.provider: v8`、`@types/node`→`tsconfig.base.json` 的 `"types": ["node"]`）→ **无 C 类未使用依赖** |
| `tsconfig.json` | 见 SCF-001、SCF-002 |
| `tsconfig.base.json` | 无问题（`composite/declaration/declarationMap/sourceMap/noEmitOnError` 齐全，`strict` + `noUncheckedIndexedAccess` 开启） |
| `tsconfig.noemit.json` | 见 SCF-002。实测 `node node_modules/typescript/bin/tsc -p tsconfig.noemit.json` → exit 0 |
| `vitest.config.ts` | 无问题。`include` 覆盖 `packages/*/src/**/*.test.ts` + `apps/*/src/**/*.test.ts`，与实测一致：618 个 `*.test.ts` 中 595 命中，未命中的 23 个 = 22 个 `docs/evidence/**` 冻结快照 + 1 个 `apps/cli/test-infra/e4-r55-fixtures/failure-wiring.child.test.ts`（子进程夹具，设计如此）→ **include 规则与实际分布一致** |
| `pnpm-workspace.yaml` | 见 SCF-016 |
| `.npmrc` | 见 SCF-016 |
| `.gitignore` | 见 SCF-009（缺 `*.pyc`）、SCF-012 |
| `.gitattributes` | 见 SCF-013；其余规则经 `git ls-files --eol` 实测仍在生效，非死代码 |
| `start-web.cmd` | 见 SCF-011 |
| `fix-links.mjs` | 见 SCF-010 |
| `HANDOVER.md` | 见 SCF-003 |
| `CAPABILITY_MATRIX.md` | 见 SCF-004 |
| `CAPABILITY_MATRIX.json` | 见 SCF-004 |
| `e3-review-baseline.json` | 无问题（`scripts/e3/generate-review-baseline.mjs` 的产物，被脚本引用） |
| `plan.md` + 21 个 `plan(...).md` | 见 SCF-014 |
| `README.md`、`README.zh-CN.md`、`AGENTS.md`、`mem.md`、`optimization-report.md`、`reflection.md` | **未逐行**（合计约 3000+ 行叙述性文档；只核对了与本 scope 相关的断言：`mem.md:881,895` 记录了 orchestration 包与 noexpand 绕路，与 SCF-001/SCF-002 相互印证）。替代手段：结构化抽查 + 与本 part 实测结论交叉验证 |
| `pnpm-lock.yaml` | 未审（不在本 scope，且 `pnpm install` 被 METHOD §0 禁止） |

## 4. 存疑/需人工确认

1. **SCF-001 的"完全未类型检查"是推断，未做破坏性验证确认。** 已确证：orchestration 不在 root references、无包依赖它、`tsc -b --dry` 的 25 个项目列表不含它。未做的是"在 `packages/orchestration/src` 里注入一个类型错误，看 `pnpm typecheck` 是否仍绿"——那需要改被跟踪文件，违反 METHOD §0。建议 Lead 或修复者用一次临时分支验证（注入 `const x: number = "s";` → `pnpm typecheck` 期望变红，实际预期仍绿）。

2. **SCF-017 的"哈希不符"不是缺陷，但需要 owner 确认冻结策略。** 4 个脚本当前哈希与 8+ 份历史清单全部不符；我方判断是 R89/R94 之后按计划重写所致（`docs/E4-R89-report.md:245`、`docs/E4-R94-report.md:249` 有记录）。缺的信息：是否存在一份"以 HEAD 为准"的现行冻结清单；若有，应当核对它而不是历史快照。

3. **`scripts/research/**` 与 `scripts/e4/**` 未逐行（162 个文件）。** 缺的信息：其中 25 个 `scripts/e4/r97-*` 等脚本是否仍被某个未提交的本地流程使用。若 Lead 需要逐行级结论，需在下一轮单独派一个"一次性脚本"审查员（本 part 已给出入口引用面与冻结哈希两项机器证据）。

4. **`.gitattributes` 的 14 条 `whitespace=cr-at-eol` 是否应长期保留。** 实测这些文件的 git blob 仍是 CRLF（如 `packages/contracts/src/contracts.test.ts` = `i/crlf w/crlf`），规则正在生效、不是死代码。但"源文件长期存 CRLF"本身是否可接受，取决于项目的 renormalize 计划——文件注释说"pinning to LF would bury a ~10-line change under a whole-file renormalization"，是权衡后的决定，我方不判为缺陷。

5. **`fix-links.mjs` 是否仍在使用。** 全仓零引用（无 `package.json` 入口、无 CI 调用、无 docs 说明）。若 owner 确认已不再使用，它是纯粹的 C 类可删对象而非 P2 风险项。
