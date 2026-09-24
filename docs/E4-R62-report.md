# E4-R62 报告：让旧变异文件残留在编译前就被隔离

## 1. 问题（H62，P2；无依赖）

R59 把变异副本移到了 `apps/cli/test-infra/e4-r55-runs/run-<mkdtemp>`（**不在** `apps/cli/tsconfig.json`
的 `include: ["src"]` 内，也**不在**根 vitest 的 `include` 内）——这是正确成果，本任务**不退回**它。

但**旧版本升级路径**没补齐：pre-R59 的固定路径
`apps/cli/src/e4-r55-mutated-chain.generated.ts` **仍在 `include: ["src"]` 之内**，
而它只由父测试的 `afterAll` 删除。问题在于**时机**：

- `package.json` 的 `test` / `test:coverage` 都是 **`tsc -b && vitest run …`**，
  也就是说**每一次门禁入口都先编译、后跑测试**；
- 于是父测试 `afterAll` 的清理**结构上永远晚于**编译 —— 一个被中断的旧运行留下的残留，
  会在下一次 `pnpm test` 里被**真实编译进 `dist`**。

计划 §2.5 明确要求：不能靠"测试结束后的清理"来保护生产输入。

## 2. 修复前复现（隔离工作树里的真实编译输入与真实构建）

按要求**不在用户主工作树里写入**该文件。用 `git worktree` 建了一个**仓库外**的独立检出：

```
git worktree add --detach D:/r62-wt HEAD          # 2401 个文件，HEAD = 04edb9d
cd D:/r62-wt && pnpm install --frozen-lockfile    # 18.4 s（走本机 store）
cp apps/cli/src/e4-09-real-chain.ts \
   apps/cli/src/e4-r55-mutated-chain.generated.ts # 19586 B，还原旧残留
```

**修复前实测（`exclude: ["src/e4-r24-fixture-*.test.ts"]`）**：

| 观测 | 结果 |
|---|---|
| 真实 TS 文件列表 `tsc -b apps/cli --listFiles --force` | **7950** 个文件，其中命中 `e4-r55-mutated-chain` **1** 次：`D:/r62-wt/apps/cli/src/e4-r55-mutated-chain.generated.ts` |
| 真实构建 `tsc -b`（全仓） | exit **0** |
| 该模块的 `dist` 产物（**实测**，不是按扩展名猜） | `e4-r55-mutated-chain.generated.d.ts`(6344) / `.d.ts.map`(2683) / `.js`(17491) / `.js.map`(10781) —— **4 个** |
| `dist` 文件总数 | **296**（干净基线 292 → **+4**） |
| 真实业务源码是否仍被收集 | `src/e4-09-real-chain.ts` **1** ✅ |
| 父验证测试是否仍被收集 | `e4-r55-failure-wiring.test.ts` **1** ✅ |
| `test-infra` 是否被收集 | **0** ✅（R59 的成果保持） |

即：**旧残留确实是生产编译输入，并会产出真实的 `dist` 产物。**

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/tsconfig.json` | 修改：`exclude` 增加**精确**的 `src/e4-r55-mutated-chain.generated.ts`（1 行） |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 修改：新增 `LEGACY_GENERATED_OUTPUTS` 常量；afterAll 的窄迁移守卫增加对 4 个**精确文件名**的 dist 孤儿清理；新增 R62 结构守卫（+80 行） |

### 3.1 为什么选 tsconfig `exclude`（结构性、不删文件）

计划 §2.3 要求"优先不删除文件的结构性方案"，§2.6 禁止排除所有 `generated.ts`、所有测试文件或整个
`src` 子目录。因此：

- **机制**：`include`/`exclude` 是 TypeScript 决定**编译输入**的正式手段——不是 gitignore
  （计划 §1.5 明确禁止用 gitignore 替代编译器输入隔离）。`exclude` 精确到一个**已知历史路径**。
- **不删源码**：残留的 `.ts` 文件仍留在磁盘上（§4 实测确认），只是不再进入编译程序。
- **不需要先跑测试**：隔离发生在编译输入层面，与 `afterAll` 何时执行无关（计划 §2「怎么验收」）。
- **窄**：`exclude` 只有两项——既有的 R24 fixture 模式，加这一个精确文件名。

### 3.2 已有 `dist` 孤儿不会自动消失（计划 §2.5）

实测（同一工作树）：

```
去掉 exclude  → 重建 → dist 出现 4 个 e4-r55-mutated-chain.generated.*
加回 exclude  → 重建 → 那 4 个孤儿【仍然在】   ← tsc 不会清理过期输出
```

所以 `exclude` **只阻止新产出，不清理既有孤儿**。窄范围处理方案：父测试 afterAll 的
**既有**窄迁移守卫（原本只精确删 1 个源文件）扩展为同时精确删那 4 个输出文件名——
**无通配、无目录扫描、不清空 `dist`、不删源码**，且**先 `existsSync` 再删**，避免无谓删除。

**为什么这不构成风险**：`dist` 是 gitignore 的构建产物；**干净 CI 检出从来不会产生这些孤儿**
（旧源文件只存在于跑过 pre-R59 测试的开发者机器上）。

## 4. 修复后命令、退出码和关键断言

在**同一隔离工作树**上加上 `exclude` 后复测：

| 观测 | 修复后 | 判据 |
|---|---|---|
| `exclude` 内容 | `["src/e4-r24-fixture-*.test.ts","src/e4-r55-mutated-chain.generated.ts"]` | — |
| 旧源文件仍在磁盘 | ✅ `apps/cli/src/e4-r55-mutated-chain.generated.ts` 存在 | 结构性方案，未删文件 |
| 先删掉 4 个孤儿，再 `tsc -b apps/cli --force --listFiles` | 命中 `e4-r55-mutated-chain` **0** 次 | 编译输入已不含它 |
| 同一重建后 `dist` 是否重新产出 | **没有**重新产出 | 无新产物 |
| `dist` 文件总数 | **292**（回到干净基线，+0） | — |
| 真实业务源码 / 父测试 / `test-infra` | **1** / **1** / **0** | 正式源码与父验证继续被收集；R59 的 test-infra 隔离保持 |

逐条对应计划 §2「怎么验收」：

| 验收项 | 结果 |
|---|---|
| 旧残留存在时，真实编译输入不再包含它 | ✅ `--listFiles` 命中数 1 → **0** |
| 独立干净构建不产生旧变异模块输出 | ✅ 删除孤儿后强制重建，4 个产物**未重新出现**，dist 292 |
| 新活跃/中断残留 test-infra 副本仍不被生产编译或默认测试收集 | ✅ `test-infra` 在编译输入中命中 **0**；根 vitest `include` 仍为 `apps/*/src/**/*.test.ts`（R59 守卫未改动） |
| 正式业务源码和 R55 父验证继续被收集 | ✅ 命中数均为 **1** |
| 不需要先运行测试完成 afterAll 才能达到隔离 | ✅ 隔离在 `tsconfig` 层，编译期即生效 |
| 移除本次防护后，旧残留反例重新失败 | ✅ 见 §5 |

## 5. 判别力（去掉 exclude 后反例失败）

新增的 R62 结构守卫断言 `apps/cli/tsconfig.json` 的 `exclude` **精确包含**该路径、
且排除项**保持窄**（无目录项、无 `*.generated.ts` 通配），并断言真实源码与父测试**未被排除**。

```
有 exclude  → vitest run … -t "R62"  →  1 passed | 11 skipped
去掉 exclude → vitest run … -t "R62"  →  1 failed | 11 skipped
     AssertionError: apps/cli/tsconfig exclude must name the legacy fixed path, got ["src/e4-r24-fixture-*.test.ts"]
```

随后已从备份恢复，复跑 `1 passed`，`tsc -b` 退出码 **0**。

此外，§2/§4 的真实构建对照本身就是判别性证据：同一份残留、同一台机器，
**只**改 `exclude` 就使编译输入命中数 1 → 0、dist 产物 4 → 0。

## 6. testedSourceSha

- 基线提交（R62 开始时 HEAD）：`04edb9d90b28c08af46e038265e3aed4ba408abf`（R61 提交）
- 被测文件内容标识（`git hash-object`，提交前实测）：

| 文件 | blob（工作树） |
| --- | --- |
| `apps/cli/tsconfig.json` | `5c9a999ae9d978fdcf89ab0fca8a88cd8ee6f9af` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 见 R63 报告（R63/R64/R65 继续修改同一文件） |

> 注：本仓库启用行尾归一化，`git hash-object <工作文件>` 与 `git rev-parse <commit>:<path>`
> 会因 EOL 归一化而不同。本报告沿用仓库既有惯例记录**工作树**哈希；`9240f65` 中
> `apps/cli/tsconfig.json` 的提交 blob 为 `9b4e1ac8a703b0d2e2192d68839cff0d80a2988d`，
> 内容与上表**逐行一致，仅行尾表示不同**。

- 实现提交：`9240f65`（`apps/cli/tsconfig.json` +1 行、测试文件 +80 行）
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)

## 7. NOT_RUN

- 未在真实 CI 上验证（按计划顺序留给 R66；`#139` / `07aea10` 已覆盖）。
- 未做付费模型调用、未发布 release、未强推。

## 8. 残余限制

1. **`exclude` 不会清理既有 `dist` 孤儿**（§3.2 实测）。它们由父测试 afterAll 的精确路径清理处理；
   若将来出现**非这四个名字**的旧产物，需要重新评估，而不是扩大通配范围。
2. **`exclude` 是"已知历史路径"的白名单式防护**。若将来再引入新的固定生成路径，必须同样显式登记；
   结构守卫只保证**当前**这两个条目，不会自动发现新路径。
3. 隔离工作树需要额外步骤才能构建（`pnpm install` **必须先关掉本机删除垫片**，否则链接步骤会留下
   空目录；离线安装还会漏平台二进制，需要从主仓补拷）。这是**本机环境**的代价，与仓库无关。
4. 本任务只处理编译输入隔离，未处理 `appendBounded`（R63）、`killTree`（R64）、
   `copyTree`/`preserveEvidence`（R65）。
