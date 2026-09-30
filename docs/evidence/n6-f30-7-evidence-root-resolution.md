# N6 / F30-7 — join 的 evidence-root 解析：artifact-relative 优先，绝不取无关 cwd

Plan: `plan(20260930-061557).md` §1.3 F30-7 / §9「怎么做」第 3 条。
起始基线 HEAD: `00c8660a`（本机工作树上另有 task-1/task-2/task-4 的并行改动，与本切片文件不相交）。
实现 commit: 承载本文件的提交，subject `fix(e4): N6/F30-7 — the join resolves its evidence root artifact-relative, never from an unrelated cwd`
（哈希见 `git log -1 --format=%h`——它包含本文件，故无法在本文件里自引用）。本地 `main`，未 push（本机到 github 的通道不可用）。
测量平台: Windows 10 / PowerShell 7.6.5，Node `v24.14.0`，vitest `4.1.10`。
证据日志（均在被 gitignore 的 `.ci/baseline/`）: `n6-dp-before.txt`、`n6-mutations.txt`、`n6-demo-post-fix.txt`。

## 1. 标签（诚实标注）

| # | 交付项 | 标签 | 依据 |
|---|---|---|---|
| F30-7.1 | auto-resolution 不再让无关 cwd 路径优先 | **PASS** | cwd 已从自动候选中**移除**（不只是排后）。DP-W 在 cwd 中放置陈旧 bundle 后仍 exit 0；直接 CLI 演示的 `tried` 列表**不含任何 cwd 候选**（`n6-demo-post-fix.txt`） |
| F30-7.2 | 多候选不得静默 first-exists | **PASS** | 按写入 verdict 的**明确排序规则**选（`evidenceRootRule` + `evidenceRootCandidates` 全量记录）；≥2 个**不同**的既有 root 时 refuse `EVIDENCE_ROOT_AMBIGUOUS` 并列出全部候选（DP-Z） |
| F30-7.3 | 显式 override 最先生效、从不被静默忽略 | **PASS** | override 权威化：不可读即 refuse `EVIDENCE_ROOT_OVERRIDE_UNUSABLE`，绝不回落到 auto 候选（DP-Q 保持绿 + 新增 DP-Y） |
| F30-7.4 | 归属 / escape（`..`、symlink）校验 | **PASS** | 复用仓库既有 `resolveInsideRoot`（词法 `..` + realpath 链接双重拒绝），自动候选一律须落在 leg artifact 自身树内；越界且**确实存在**时 refuse `EVIDENCE_ROOT_ESCAPE`（DP-X） |
| F30-7.5 | 修复后 DP-R 在陈旧 cwd bundle **仍存在**时通过 | **PASS** | 同一个 124 条目陈旧目录未动（`Test-Path` = True，条目数 124），`28 passed (28)`，DP-R 全绿 |
| F30-7.6 | 真实 CI 布局（两平台 join）端到端 | **部分** | DP-R 复刻 ci.yml 已实测的下载布局并通过；**未在真实 GitHub runner 上重跑**（本机网络到 github 不可用），故 CI run 级别的确认留给 task-4 的 workflow 变更 |
| F30-7.7 | Ubuntu 适用性 | **NOT_PROVEN** | 全部测量为 Windows 本地；解析逻辑只用 `node:path`/`node:fs`，无平台分支，但未在 linux runner 上执行 |

## 2. 缺陷（本机确定性复现，非推断）

`resolveEvidenceRoot`（旧 L352-395）把 **cwd 候选排在第一位**：

```js
candidates.push([isOverride ? "override(cwd)" : "cwd", resolve(recorded)]);   // 第一位
```

`inputs.evidenceRoot` 是**相对路径**（CI 里 `--evidence-root .ci/prereg-production-e2e/pos-exec-runs/evidence`），
于是 `resolve(recorded)` 命中的是 **join 进程自己 cwd 下恰好存在的同名目录** —— 本机就是上次运行的残留
`.ci/prereg-production-e2e/pos-exec-runs/evidence`（124 条目，只有 `*-baseline` / `*-candidate` 子目录、
**没有** `identity.json`）。谁先 `existsSync` 谁赢，所以 join 拿**旧 bundle** 去复验并拒绝。

修复前实测（同一棵树、同一残留目录、未改任何实现）：

```
❯ apps/cli/src/dual-platform-acceptance.test.ts (23 tests | 1 failed) 6260ms
 FAIL  ... > DP-R: the REAL nested CI artifact layout resolves
AssertionError: ... REFUSED: the two legs are not one acceptance unit
  RAW_EVIDENCE_MISMATCH: re-verifying windows's bundle reported:
    MISSING_RAW_EVIDENCE: identity.json is missing or unreadable under the evidence root
: expected 2 to be +0
 Tests  1 failed | 22 passed (23)
```

`identity.json is missing` 正是**陈旧 cwd 目录**的形状 —— 新 bundle 有，旧残留没有。这条 RED 是缺陷的活体证据。

## 3. 新规则（可写进报告、可被审阅）

**旧候选顺序**（first-exists，无声）：
`cwd` → `leg-dir/basename` → `leg-dir/recorded` → `leg-root/recorded` → `leg-root/without-dot-ci` → `leg-root/basename`

**新解析顺序（auto 模式）**：

1. **显式 override 权威**：`--windows-evidence-root` / `--ubuntu-evidence-root` 按给定值解析（绝对按原样、相对对 cwd），**不进入排序**。不可读 → `EVIDENCE_ROOT_OVERRIDE_UNUSABLE` refuse（**不回落**）。
2. 记录的路径是**绝对**路径 → 按记录使用，但必须是**目录**（是文件时 `EVIDENCE_ROOT_UNUSABLE`）。
3. 记录的路径是**相对**路径 → 仅排序 leg artifact 自身树，规则与顺序固定写入 verdict：
   1. `leg-dir/basename`（bundle 就在 leg JSON 旁边 —— DP-O 的扁平布局）
   2. `leg-dir/recorded`
   3. `leg-root/recorded`（uploader 保留 `.ci/` 段的那种打包）
   4. `leg-root/without-dot-ci`（**实测** CI 下载布局：uploader 剥掉 `.ci/` 段）
   5. `leg-root/basename`
   - **cwd 不是候选**（F30-7 的修复本体）。
   - 每个候选必须 `resolveInsideRoot(legRoot, …)` 通过（词法 `..` + realpath symlink）；越界候选被逐条 REJECTED 记录；越界且**实际存在**时整轮 refuse `EVIDENCE_ROOT_ESCAPE`。
   - 同一目录被两个候选名命中（例如 `recorded` 无目录分量）→ **去重**，不算第二候选。
   - 去重后 **≥2 个既存 root** → refuse `EVIDENCE_ROOT_AMBIGUOUS`，列出全部候选与出路（用 override 明确指定）。
   - 0 个既存 → `NO_RAW_EVIDENCE`，列出 `tried` 全部候选（保持 DP-P 语义）。

**为什么选「排序规则 + 全量记录」而不是「所有多命中一律报歧义」**：把每一个「多命中」都判死会让真实 CI 在一个**可解释**的布局差异上变红；而把顺序写死＋把规则、全部候选、命中原因写进 verdict，使选择不再是「扫描顺序的副作用」。对**真正拿不准**的情形（两个不同的既存 root）则一律 refuse —— 既不静默，也不猜。真实 CI 布局下只有一个候选命中（§5）。

**verdict 新增可观察字段**（每个 leg）：

| 字段 | 含义 |
|---|---|
| `evidenceRootResolvedFrom` | 既有字段；命中候选名（`leg-dir/basename` / `leg-root/without-dot-ci` / `override(absolute)` …） |
| `evidenceRootRule` | 规则原文（含 `the joining process's cwd is NEVER an automatic candidate (F30-7)`） |
| `evidenceRootCandidates` | **全部**候选 `{from, path, exists, note}`，含被 REJECTED 的越界候选 —— 审阅者能看到「为什么是它」和「还有谁存在」 |

## 4. 反例纪律（负例从已通过正例派生，一次一维）

| 用例 | 派生自 | 单一改动维度 | 断言 |
|---|---|---|---|
| **DP-W**（新增） | DP-R | 把 join 的 cwd 指向一个**装了诱饵**的目录 | exit 0；`from=leg-root/without-dot-ci`；`evidenceRoot` = artifact-relative 路径而非诱饵；**把新候选集与顺序整体钉死**（`leg-dir/basename, leg-dir/recorded, leg-root/recorded, leg-root/without-dot-ci, leg-root/basename`，无任何 cwd 条目；先断言 `length > 0` 以免空列表造成假通过） |
| DP-W **对照组** | DP-W | 把诱饵**显式**命名为 override | exit 2 + `RAW_EVIDENCE_MISMATCH` —— 证明诱饵本身是**致命**的，所以「选对了 root」是行为事实而非记录字符串 |
| **DP-X**（新增） | DP-R | recorded 加 `../../` 前缀（逃出 leg 树） | exit 2 + `EVIDENCE_ROOT_ESCAPE` + 逃逸路径；同一 bundle 用 override 读取则 exit 0 → 证明拒绝是**归属**问题而非 bundle 损坏 |
| **DP-Y**（新增） | DP-W | 加一个不存在的 `--windows-evidence-root` | 无 override 时 exit 0（对照）→ 加 override 后 exit 2 + `EVIDENCE_ROOT_OVERRIDE_UNUSABLE`，**不回落** |
| **DP-Z**（新增） | DP-O + DP-R | 同时放置两个**不同**的既存 root | exit 2 + `EVIDENCE_ROOT_AMBIGUOUS`，stderr 同时列出两个候选 |
| **DP-Z2**（新增） | DP-Z | recorded 去掉目录分量（两候选名指向**同一**目录） | exit 0 + `from=leg-dir/basename` —— 证明去重规则，避免把「一个 root 两个名字」误判为歧义 |

## 5. 载重性（mutation：证明修复不是装饰）

变异施加于 `scripts/e4/dual-platform-acceptance.mjs`（一次一个，从 pristine 副本施加，跑完立即还原；harness 在 `%TEMP%\n6-mutate.mjs`，日志 `n6-mutations.txt`）：

| 变异 | 语义 | 结果 |
|---|---|---|
| **M1-cwd-first** | 恢复修复前行为：cwd 命中即赢 | **3 failed** — DP-R、**DP-W**、DP-Y 全红 |
| M2-no-ambiguity-refusal | 还原为静默 first-exists | **1 failed** — DP-Z 红 |
| M3-escape-allowed | 不校验归属，读越界 root | **1 failed** — DP-X 红 |
| M4-override-silently-ignored | 完全不看 override，让它被静默忽略 | **2 failed** — DP-Q、DP-Y 红 |

M1 是关键的「回到 cwd-first」击杀项：**DP-W 与 DP-R 同时红**，而 DP-R 的红色依赖本机残留目录是否在（CI 不可见），DP-W 则是**自足的**（诱饵由用例自己创建、断言诱饵确实存在）。二者互补。

## 6. 实测命令与结果

```
# 修复前（基线，陈旧 cwd bundle 存在）
npx vitest run apps/cli/src/dual-platform-acceptance.test.ts
→ Test Files 1 failed (1) / Tests 1 failed | 22 passed (23)；DP-R 红，exit 2

# 修复后（同一棵树、同一 124 条目陈旧目录仍在）
npx vitest run apps/cli/src/dual-platform-acceptance.test.ts
→ Test Files 1 passed (1) / Tests 28 passed (28)

# 直接 CLI 演示：leg 树内无 bundle，cwd 里就是那个残留目录
node .ci/baseline/n6-f30-7-demo.mjs <repoRoot> scripts/e4/dual-platform-acceptance.mjs <HEAD>
→ stale cwd bundle present: true
→ exit 2（NO_RAW_EVIDENCE）
→ tried leg-dir/basename=… , leg-dir/recorded=… , leg-root/recorded=… ,
        leg-root/without-dot-ci=… , leg-root/basename=…     ← 无 cwd 候选

# 类型检查
npx tsc -b
→ 仍有 2 处 error TS18048，全部位于 apps/cli/src/n2-script-scope.test.ts（**他人在写、未入库**的文件）；本切片两个文件 0 error
npx tsc -p .ci/baseline/n6-tsconfig.json   # 只编译本测试文件，沿用 apps/cli 的真实配置
→ exit 0
node --check scripts/e4/dual-platform-acceptance.mjs → exit 0
```

CI 真实布局复核（本机推算，与 ci.yml L1732-1740 的实测注释一致）：
`--windows .ci/dual/windows/r97-r98/ci-readiness.json` ⇒ legRoot = `.ci/dual/windows`；
uploader 的 `path:` 为 `.ci/r97-r98/ci-readiness.json` + `.ci/prereg-production-e2e/pos-exec-runs/evidence`，
其公共前缀 `.ci` 被剥掉，故下载后 bundle 落在 `.ci/dual/windows/prereg-production-e2e/pos-exec-runs/evidence`
＝ 唯一命中的 `leg-root/without-dot-ci`，其余 4 个候选均不存在 ⇒ 不触发歧义拒绝。**未在真实 runner 上复跑**（见 F30-7.6）。

## 7. 变更文件

| 文件 | 变更 |
|---|---|
| `scripts/e4/dual-platform-acceptance.mjs` | 重写 `resolveEvidenceRoot`（override 权威 / 绝对路径分支 / 仅 artifact-relative 排序 / cwd 移出候选 / 归属与目录校验 / 去重 / 歧义拒绝）；新增 `EVIDENCE_ROOT_RULE`、`usableDirectory`；`loadLeg` 消费解析期 problems 并把 `evidenceRootRule`、`evidenceRootCandidates` 写入 verdict；header 与 usage 文本同步 |
| `apps/cli/src/dual-platform-acceptance.test.ts` | `scratch().run` 支持 `cwd`；`Verdict` 接口补两个字段；新增 `CI_RECORDED_EVIDENCE_ROOT`、`copyBundleInto`、`nestedLeg` 夹具；新增 DP-W / DP-X / DP-Y / DP-Z / DP-Z2（23 → 28 例） |

## 8. 剩余问题 / 边界

1. **真实 runner 未复跑**：本机 git 到 github 不通（代理 `127.0.0.1:7897` 未监听），F30-7.6 只能是「按 ci.yml 实测注释推算 + DP-R 复刻」。
2. **`tsc -b` 全局非 0**：2 处 `error TS18048` 在 `apps/cli/src/n2-script-scope.test.ts`（**未入库**、属 n2-cli 的 task-1 切片）。本切片文件 0 error，已用 scoped tsc 单独证明。需要的收口动作在 task-1，不在本切片。
3. **歧义拒绝的边界**：若将来真实 artifact 同时带上 `.ci/…` 与剥掉 `.ci/` 的两种目录，join 会 refuse `EVIDENCE_ROOT_AMBIGUOUS`（这是有意的 fail-closed），出路是显式 override。真实 CI 目前只有一种（§6）。
4. **`--windows-evidence-root` 语义收紧**：不可读的 override 从「静默回落」变为「refuse」。这是 requirement「从不被静默忽略」的直接实现，但属于行为变更，已在 DP-Y 钉住。
5. **建议的 mutation registry 条目**（`scripts/e4/r97-mutation-check.mjs` **不在本切片 write scope，未改动**）：可登记
   `id: "f30-7-cwd-first-evidence-root"`，`file: "scripts/e4/dual-platform-acceptance.mjs"`，
   `find: "  const legRoot = dirname(legDir);"`，
   `replace: "  const legRoot = dirname(legDir);\n  if (existsSync(resolve(recorded))) return outcome(resolve(recorded), \"cwd\");"`，
   `suite: "apps/cli/src/dual-platform-acceptance.test.ts"`，`test: "DP-W"`，
   `catchExpectation:` 陈旧 cwd bundle 赢过 artifact-relative root，join 复验了错误字节并拒绝（本机实测 3 failed：DP-R/DP-W/DP-Y）。
6. **`.ci/prereg-production-e2e/pos-exec-runs/evidence` 按指示原样保留**（124 条目，未删除/移动），继续充当活体复现器。
