# E4-R59 报告：将 R55 变异副本移出生产编译输入

## 1. 问题（G59，P2；依赖 R58）

父测试把变异副本写到**固定**路径 `apps/cli/src/e4-r55-mutated-chain.generated.ts`，child 从
该固定路径导入。该文件虽然 gitignored，但**位于 `apps/cli/tsconfig.json` 的 `include: ["src"]`
之内**，因此属于生产编译输入；两个验证进程还会共享同一路径的写入/删除。

## 2. 修复前复现（真实编译输入证据）

计划要求"先复现再报告，不能声称已经观察到污染事故"。实测结果**比预期更严重**：

```
$ ls apps/cli/dist | grep -i "e4-r55-mutated"      # 基线：并未新建任何文件
e4-r55-mutated-chain.generated.d.ts
e4-r55-mutated-chain.generated.d.ts.map
e4-r55-mutated-chain.generated.js
e4-r55-mutated-chain.generated.js.map
```

即：**dist 里早已存在这 4 个产物**（来自之前某次运行），而**源文件当时并不存在**——
父测试的 `afterAll` 会删掉源文件，但 `tsc` **不会清理过期输出**，所以生成模块的产物
在源码删除后仍然留在共享 dist 中。

随后把源文件按固定路径放回并执行真实生产构建：

```
$ cp apps/cli/src/e4-09-real-chain.ts apps/cli/src/e4-r55-mutated-chain.generated.ts
$ tsc -b apps/cli        # exit 0
$ ls apps/cli/dist | grep -i "e4-r55-mutated"      # 再次产出 4 个文件
```

结论：该固定路径**确实是生产编译输入**，并会产出 dist 产物。证据类型是**真实构建输出**
（不是静态推断，也不是"只靠 gitignore 论证"）。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-09-real-chain.ts` | 修改：新增 `rewriteChainRelativeImport`（搬迁副本时重写唯一相对导入，并断言数量） |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 修改：`prepareChainModule`（真实模块 / 每次 run 独享的变异副本）+ `runChild` 绑定本 run 模块 + 归属与编译输入断言 |
| `apps/cli/test-infra/r55-vitest.config.ts` | 修改：通过 `resolve.alias` 把 `@r55-chain` 绑定到 `E4_R55_CHAIN_MODULE`；未设置即**配置期报错** |
| `apps/cli/test-infra/e4-r55-fixtures/failure-wiring.child.test.ts` | 修改：改为**静态** `import ... from "@r55-chain"`；把本次加载的模块路径+sha256 记入每个 bundle |
| `.gitignore` | 修改：忽略 `apps/cli/test-infra/e4-r55-runs/`（**仅为 git 洁净**，见 §3.2） |

### 3.1 设计要点

1. **每次 run 独享目录**：`apps/cli/test-infra/e4-r55-runs/run-<mkdtemp>`。该位置
   - **不在** `apps/cli/tsconfig.json` 的 `include: ["src"]` 内（路径无 `src` 段），
   - **不在** 根 vitest `include`（`apps/*/src/**/*.test.ts`）内。
   两个并发的父验证各写各自目录，不可能互相覆盖。
2. **按 run 绑定，绝不扫描"最新文件"**：父进程把本 run 的模块绝对路径经
   `E4_R55_CHAIN_MODULE` 传给子进程，子进程 config 用它建立 `@r55-chain` 别名。
   控制轮指向**真实模块本身**（不产生任何副本），变异轮指向本次生成的副本。
   env 缺失时 config 直接抛错，不存在默认值。
3. **仍然加载真实链与真实依赖**：副本是真实模块的变异文本，其唯一相对导入被
   `rewriteChainRelativeImport` 重写为指向**真实** `e4-09-diagnostics.ts`
   （断言"恰好一处"，否则抛错）；裸 `@ar/*` 依赖照常解析。**没有**复制成独立的伪业务实现。
4. **可核对的模块身份**：child 把本次加载的模块路径与 sha256 写进每个 bundle 的
   `extra.chainModule`；父进程断言它与本 run 选择的一致，且变异轮与控制轮的 digest 不同。
5. **只清理自己拥有的资源**：`runChild` 在自己的 `finally` 里删除自己的 run 目录；
   `afterAll` 只做**窄范围**旧路径迁移防护（精确删除 `src/e4-r55-mutated-chain.generated.ts`
   这一个文件），不做批量删除、不使用通配符、不扫描源码。

### 3.2 为什么 gitignore 不是隔离机制

计划第 5 条明确禁止用 gitignore 代替编译器/收集器的真实输入隔离。本任务中：
**位置**（`test-infra/`，无 `src` 段）才是把副本挡在 tsc 与 vitest 之外的原因；
`.gitignore` 只用于"中断后残留目录不要把工作树弄脏"（否则并发 promotion benchmark 会拒跑）。
§4 的编译输入与收集器证据都是**位置**带来的效果，不是 ignore 规则。

## 4. 修复后命令、退出码和关键断言

| 验证 | 命令/方式 | 结果 |
| --- | --- | --- |
| 活跃副本不进入生产编译 | 在 `e4-r55-runs/run-probe/chain.ts` 存在时执行 `tsc -b apps/cli` | **exit 0；dist 文件数 288 → 288（无新增）**；`dist/chain.js` **不存在**，而探针源文件存在；`dist` 中匹配 "chain" 的 4 个条目全是真实模块的 `e4-09-real-chain.*` |
| 默认测试不收集残留副本 | 残留副本存在时执行 `vitest list` | **来自 runs root 的收集数 = 0**（同一命令共收集 5812 条，说明收集器本身正常） |
| 并发归属 | `R59: two concurrent runs own distinct per-run copies…`（同步屏障：两份副本先同时生成，再清理其中一份） | **通过**：路径互不相同；同源同摘要；两份副本的重写导入**都解析到真实** `e4-09-diagnostics` 模块；删除 A 后 B 的副本仍在且摘要不变 |
| 无遗留副本 | 主用例末尾断言 runs root 为空 | **通过**（`toEqual([])`） |
| 编译输入/收集范围的**结构性守卫** | `R59: the per-run copy location stays outside…` | **通过**：断言 `apps/cli` tsconfig `include` 含 `src` 且不覆盖 `test-infra`；runs root 相对路径以 `test-infra/` 开头且不含 `/src/`；根 vitest include 仍为 `apps/*/src/**/*.test.ts` |
| 判别力保持 | `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts` | **3 passed (3)**，54.8 s / 76.9 s 两次实测；控制轮通过、变异轮被同一验收拒绝（decision 未落盘） |
| 源树与共享 dist/cache | 每次验证后检查 | `git status --porcelain` 为空；`dist` 无 `e4-r55-mutated*` 产物 |

## 5. 过程中被守卫抓到的一个真实缺陷（如实记录）

`rewriteChainRelativeImport` 最初用**字面量** needle `from "./e4-09-diagnostics.js"` 计数，
结果在真实模块里数到 **2 处**——第二处就是**该常量自身的声明行**。守卫因此直接抛错，
没有产出损坏副本。修法与仓库既有的 P14-6 静态扫描一致：**用拼接构造 needle**，
使模块自身不再包含它要搜索的字面量：

```ts
const DIAGNOSTICS_IMPORT_NEEDLE = ["from", '"./e4-09-diagnostics.js"'].join(" ");
```

修复后实测该 needle 在模块中出现 **1 次**。这与变异标记当初踩到的"常量含同样文本"是同一类
陷阱，说明"独立行/拼接"这类防御在本模块里是必需的，不是洁癖。

## 6. testedSourceSha

- R59 基线（R58 提交）：`db0a232`
- 被测文件内容标识（`git hash-object`）：

| 文件 | blob |
| --- | --- |
| `apps/cli/src/e4-09-real-chain.ts` | `09fc18eb9def9abbdcac8dd2ce42c287ae7fa718` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | `569d51610821f8aa3ba1e103ac099c3967e92f1c` |
| `apps/cli/test-infra/e4-r55-fixtures/failure-wiring.child.test.ts` | `3b46bc8b079c80b1fbbddc48b69f54fbb1c2321e` |
| `apps/cli/test-infra/r55-vitest.config.ts` | `bd829517f3d4bd66e8b93b7da192a44d0911d359` |
| `.gitignore` | `4eb316c0fe0e2cc82385bd2394b45af57ee80259` |

- 本任务实现提交：`252768d`、`3eecca4`、`f57f325`、`ad62636`
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。

## 7. NOT_RUN

- 未在真实 CI（Windows/coverage）上验证：留给 R61。
- 未做"两次**完整子进程**并行父验证"（本任务用的是同步屏障 + 同一份 `prepareChainModule`
  真实代码路径，成本可控；完整双跑会把本文件推到 ~4 分钟，留给需要时再评估）。
- 未重跑全量 `pnpm test` / `pnpm test:coverage`：留给 R61。
- 未做付费评测、未发布、未强推。

## 8. 残余限制

1. **残留目录的清理依赖 `rm` 成功**。在**本机代理沙箱**下，safe-delete 垫片会在单个 turn
   内第 50 次删除后拒绝执行（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），导致 run 目录偶发清不掉；
   此时主用例末尾的"无遗留"断言会失败。实测：隔离运行 3/3 通过；与其它用例同跑时曾因该垫片
   失败一次。这是**环境**问题（CI 无此垫片），但确实暴露了"清理失败被 `.catch(() => {})`
   静默吞掉"的健壮性缺口——**该缺口由 R60 负责修**（保留失败证据、报告明确位置）。
2. `afterAll` 会尝试移除**空**的 runs root；若同时有别的 run 正在使用它，则该次删除失败并被忽略
   （有意如此：不做跨 run 的递归删除，避免删掉别人的副本）。因此 runs root 可能以空目录形式
   残留，它被 gitignore 覆盖，不影响工作树洁净。
3. 结构性守卫是**配置级**断言（读 tsconfig / vitest.config 文本），不是"编译程序文件列表"本身。
   本任务用**真实构建输出**（dist 无新增、无 `chain.js`）作为主证据，两者互补。
4. `rewriteChainRelativeImport` 断言"恰好一处"相对导入。若将来真实模块新增第二个相对导入，
   函数会**明确抛错**而不是产出解析不了的副本——这是有意的失败方向，但需要届时同步更新。
5. 本任务未处理 `spawnSync` 无超时、`proc.error/signal/stdout/stderr` 未保留、
   `report.json` 读取直接抛错、`afterAll` 无条件删诊断、变异分支退出/身份校验不如正常分支严格
   ——**这些全部是 R60 的范围**，本报告不声称已解决。

---

## 9. 补记（2026-09-14，E4-R61）：CI 全绿，且 §8.1 的垫片缺口已定性

§7 的"未在真实 CI（Windows/coverage）上验证"已由 R61 关闭：run `#137` `34809270367`
（head `08584422061322d82465377a773624a8f7f0315f`，attempt 1）四个 job **全部 success**
（ubuntu / windows / coverage gate / release attestation）。详见 `docs/E4-R61-report.md`。

**关于 §8.1 的垫片缺口**：R61 把机制查清了——`node-safe-delete-shim.cjs` 经 `NODE_OPTIONS`
预加载进每个 Node 进程，按 `CODEBUDDY_CONVERSATION_REQUEST_ID` 累计本 turn 的删除次数，
达阈值（本机 50）即拒绝且**同一 turn 不回落**；`CODEBUDDY_SAFE_DELETE_ENABLED=0` 可整体关闭。
R61 用同一 HEAD 做了三档对照（守卫开 / 抬阈值 / 完全关闭），证明"无遗留副本"断言的失败
**完全由垫片造成**：抬高阈值后 `e4-r55-failure-wiring.test.ts` 两例（含本报告 §4 的并发归属例）
全部通过，且全量失败从 17 项降到 6 项（剩余 6 项全为符号链接 EPERM）。
真实 CI 没有该垫片，故 §8.1 的"偶发清不掉"在 CI 上不成立——#137 全绿即为证。
本报告 §8.3 的结构性守卫在最终实现中仍保留（`e4-r55-failure-wiring.test.ts:1141`），
且 R61 独立复核了 `apps/cli/tsconfig.json` `include: ["src"]` 与根 vitest include 均不含
`test-infra/`。
