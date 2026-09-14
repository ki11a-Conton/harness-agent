# E4-R51 报告：让读取错误和提前关闭必定结束采集

## 1. 问题（F51，P1）

`apps/cli/src/e4-09-diagnostics.ts` 的 `readArtifact` 把 Promise 的**唯一**完成出口
挂在 `stream.on("end")` 上：

```ts
stream.on("error", (err) => {
  readError = msg(err);
  // drain so 'end' still fires and we report the error exactly once
  stream.destroy();
});
stream.on("end", done);   // ← 唯一 resolve 点
```

`destroy()` 之后的流**不会再发出 `end`**，而代码里没有任何 `close` 分支。因此只要
错误发生在 `stat` 成功之后（即所有 `stat` 拦不住的错误：EIO、流中途失败、打开瞬间
文件被删除），这个 Promise 就**永远 pending**。

后果不是观感问题：`captureFailure` 对每个已注册 artifact 都 `await readArtifact`，
所以**失败取证链路本身会挂死**，测试的 `afterEach` 也拿不到执行机会——正是 R40 想
解决的"失败现场丢失"以另一种方式复发。

`stat` 阶段能拦住的错误（ENOENT / EISDIR）不受影响，所以 F51 只在"stat 通过之后"
才可见；这一点决定了复现必须做 I/O 边界注入。

## 2. 复现命令与修复前实际结果

复现文件：`apps/cli/src/e4-r51-read-settle.test.ts`（新增，6 例）。
注入方式：仅包裹 `node:fs.createReadStream`，对登记在故障表里的路径返回一个**真实
的 `Readable`**，由测试手工驱动真实的 `data` / `error` / `close` 事件；`stat`、
recorder、`captureFailure`、bundle 落盘全部是**未改动的生产模块**。文件真实存在，
所以 `stat` 一定通过。

```
node_modules/.bin/vitest run apps/cli/src/e4-r51-read-settle.test.ts
```

**修复前实际结果（未改动源码，退出码 1）**：

```
 Test Files  1 failed (1)
      Tests  5 failed | 1 passed (6)
   Duration  12.41s
```

5 例失败的断言全部是同一句：

```
AssertionError: captureFailure never settled — readArtifact Promise is still pending
- Expected: true
+ Received: false
```

唯一通过的是第 4 例"正常 data/end/close"——符合预期：正常路径本来就是唯一有完成出口
的分支。这 5 红 1 绿正是 F51 的判别力证据。

> 说明：测试里的 `settledWithin(..., 2000ms)` 只是**断言级防挂保护**，不是修复手段，
> 生产代码没有引入任何 timeout。没有它，旧实现只会表现为框架的裸超时。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-09-diagnostics.ts` | 修改：`readArtifact` 改为**单一 settle-once 完成协议**（+63 / −12 行） |
| `apps/cli/src/e4-r51-read-settle.test.ts` | 新增：I/O 边界故障注入回归套件（6 例） |

`readArtifact` 的改动要点：

1. `settled` 标志 + `settle()`：**唯一的** resolve 出口，重复调用为空操作。
2. 四个终态各自有明确结果：
   - `error` → 结构化读取失败，携带真实错误；
   - `end` → 成功（若此前已收到 error，则按失败收尾）；
   - `close` **先于** `end` → **失败**，原因写明 premature close；
   - `close` 在 `end`/`error` **之后** → 空操作，**不会把已成功的采集翻成失败**。
3. 清理：settle 时摘掉自己持有的 `data`/`end`/`close`/`error` 监听器；`error` 监听器
   换成 no-op 守卫而不是直接移除——否则拆流后迟到的 error 会变成 unhandled `'error'`
   并让进程崩溃。
4. `captureFailure` 无需改动：读取失败现在返回结果而非挂起，循环自然继续处理后续
   artifact，最初的业务异常与 stage 保持不变。

未采用的做法：加大 timeout、吞掉 error、给生产代码加测试开关。计划明确禁止，且都
只是把"挂起"换成"错误结论"。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node_modules/.bin/vitest run apps/cli/src/e4-r51-read-settle.test.ts` | 0 | **6 passed (6)** |
| `node_modules/.bin/vitest run` R47 + R46 + R45 + R42 四个既有套件 | 0 | **15 passed (4 files)** |

R51 六例对应的验收项：

| 例 | 验收项（计划 §3「怎么验收」） | 关键断言 |
| --- | --- | --- |
| 1 | stat 成功后异步 EIO：采集正常结束，失败文件 captured=false，原因含 EIO | `settled === true`、`captured === false`、`error =~ /EIO/` |
| 2 | 部分 data 后 error：不能标记完整采集成功 | `captured === false`、`sourceDigest` 未产出 |
| 3 | close 先于 end：不 pending，记录提前关闭 | `settled === true`、`error =~ /close|premature|incomplete/i` |
| 4 | 正常 data/end/close：正确完成一次，摘要正确 | 记录数 `=== 1`（非每事件一条）、`sourceDigest === 独立 sha256`、副本逐字节相等、`summary` 正确 |
| 5 | 一份失败 + 一份成功：诊断包仍写出，成功项可读，失败项有原因 | bundle 落盘可解析、good 副本可读、bad 有 EIO 原因 |
| 6 | 最初业务异常仍保存在 failure 中 | `failure.message === "original assertion failure"`、`stage` 保留 |
| — | 改回旧 error/end 实现，新回归测试失败 | §2 已实测：旧实现 5 failed |

## 5. testedSourceSha

- 基线提交（任务开始时 HEAD）：`79cba18ecdadb701fc57edb0c0dcf44447178da8`
  （与计划 §0 `reviewedSourceSha` 一致，工作树干净，仅计划文件未跟踪）。
- 被测源码内容标识（`git hash-object`，提交前实测）：
  - `apps/cli/src/e4-09-diagnostics.ts` = `b4ac6c17bf720e931eb45f5f7f67153a0c6d812d`
  - `apps/cli/src/e4-r51-read-settle.test.ts` = `2068356cb09bcfb2255f09508731c6753c34437e`
- 运行环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。
- 说明：本任务结束时改动**尚未提交**（见 §6）；上述 blob 哈希是对被测字节的精确标识，
  最终提交 SHA 在 E4-R56 报告中统一绑定。

## 6. 未提交差异

```
 apps/cli/src/e4-09-diagnostics.ts | 75 ++++++++++++++++++++++++++++++++-------
 1 file changed, 63 insertions(+), 12 deletions(-)
```

外加新增未跟踪文件 `apps/cli/src/e4-r51-read-settle.test.ts` 与本报告
`docs/E4-R51-report.md`。工作树另有仓库外计划文件 `plan(20260914-002710).md`
（按计划 §「计划文件使用约定」保留在仓库外，不纳入提交）。

## 7. NOT_RUN

- 未重跑全仓 `pnpm test` / `pnpm typecheck` / `pnpm docs:verify`：按计划顺序在 R56 于
  干净已提交版本上统一执行。
- 未跑真实 E2E 生产链路（`e4-09-production-e2e`）验证"失败取证链在真实链路上不再挂
  起"：该项属于 R55 的交付范围（真实生产接线验收）。
- 未核实该版本的远端 CI（Ubuntu/Windows/coverage/attestation）：本轮不推送，R56 记录。
- 未做付费评测、未自动发布、未强推、未改远端权限。

## 8. 残余限制

1. 本任务是**单元/故障注入级**证据：`node:fs.createReadStream` 被包裹以注入真实
   `Readable`，`stat` 与其余路径是生产代码。它证明的是 `readArtifact` 的完成协议，
   不等于整条生产 E2E 接线已被验证（留给 R55）。
2. 若流**既不 error、也不 end、也不 close**（纯 I/O 黑洞），仍会 pending。计划明确
   禁止用 timeout 掩盖，故未引入；`close` 分支覆盖的是"提前终止"这一现实形态。
3. 第 1、2 例断言"部分 data 后失败不算成功"，但未断言注入场景下 `total` 的具体字节
   数——字节语义（sourceBytes/headBytes/截断标记）是 R52 的范围，避免与 R52 重叠
   或互相干扰。
4. 第 4 例通过真实文件走真实 `createReadStream`，因此依赖平台的文件系统行为；在
   Windows 与 Linux 上语义一致（`end` → `close`）。
