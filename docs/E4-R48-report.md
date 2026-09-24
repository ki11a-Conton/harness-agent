# E4-R48 报告：提高共享构建资源隔离测试的判别力

## 1. 做了什么

补足 R42 测试 `apps/cli/src/e4-r42-gate-isolation.test.ts` 对
「共享构建产物未被改写」的验收能力（计划 §7）。

R42 原 `sharedBuildSnapshot()` 只取 `apps/cli/dist` **顶层文件名** + 单个
`cli.tsbuildinfo` 摘要：同名 JS 被覆盖、嵌套文件变化、子目录增删都**不会改变快照**，
无法支撑注释里的 byte-for-byte 声明。这是**验收覆盖缺口**，不是真实 gate 已污染主仓
的结论（计划 §7 明示：不据此未经复现就声称真实 gate 污染了主仓）。

改动：

1. **新增 `deepSnapshot(root)`** —— 内容寻址的**递归**确定性快照：遍历树，对每个
   文件记 `{ relPath, type, digest(sha256 原始字节) }`，目录记 type，按 relPath
   **确定性排序**后整体 sha256。
2. **`sharedBuildSnapshot()` 改为调用 `deepSnapshot`** 于 `apps/cli/dist` 与
   tsbuildinfo 父目录，用 `|` 拼接两个摘要。受保护范围与 R42 报告一致。
3. **读取失败不塌缩为空树** —— 目录不可读记 `ERROR:<code>`，文件读取失败记
   `ERROR:<code>`，stat 失败记 `ERROR:unreadable`：真正不可读的资源是**可区分的事实**，
   绝不伪装成「未修改」。
4. **新增判别力测试**（第二个 it）：在临时目录中验证同名覆盖 / 嵌套修改 / 增文件 /
   删文件都改变摘要，而内容相同仅枚举顺序不同则**相等**（确定性排序保证稳定）。
   全程在临时树中跑，**不碰主仓 dist**。

## 2. 为什么需要改

计划 §7「做什么」：当前 `sharedBuildSnapshot()` 只含 dist 顶层文件名 + 一个 tsbuildinfo
摘要，同名 JS 覆盖、嵌套变化时快照不变，无法支撑 byte-for-byte 声明。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-r42-gate-isolation.test.ts` | 修改：新增 `deepSnapshot`；`sharedBuildSnapshot` 改用之；新增判别力测试 |

## 4. 复现方法与修复前结果

**修复前（推理）**：`sharedBuildSnapshot` 只 `readdir(dist 顶层)` 取名字 + 一个 buildinfo
摘要。同一文件被覆盖（内容变名不变）、嵌套目录文件变化、子目录整目录增删，名字列表
不变 → 快照**不变** → 断言 `toBe(before)` 无法发现污染。

**修复后（判别力实测）**：五个操纵全部被新的 `deepSnapshot` 判别力测试覆盖——同 top-level
覆盖（s1≠s0）、嵌套改动（s2≠s0）、增文件（s3≠s0）、删文件（s4≠s0）都产生不同摘要，
而回读同一内容（sBack）== s0（枚举顺序无关）。**修复前这些断言要么不成立（旧快照
看不出），要么从未存在**。

## 5. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | tsc -b 全绿 |
| `pnpm vitest run apps/cli/src/e4-r42-gate-isolation.test.ts` | 0 | **2 passed**（原隔离门禁 + 新判别力） |

判别力断言（临时树，不碰主仓）：

- 同名覆盖（a.js AAA→AAAX）→ `not.toBe(s0)`；
- 嵌套改动（nested/b.js BBB→BBBX）→ `not.toBe(s0)`；
- 增文件（c.js）→ `not.toBe(s0)`；
- 删文件（删除 nested/b.js）→ `not.toBe(s0)`；
- 回读相同内容 → `toBe(s0)`（枚举顺序稳定）。

计划 §6 验收 A、B 已覆盖：A 判别力（同名/嵌套/增删/顺序稳定、读错误可区分）、
B 真实 gate（真实 tsc、隔离 workspace、gitSha 属临时仓、非零子进程 exit/stderr 保存、
受保护共享资源快照一致——原 R42 断言保留）。

## 6. testedSourceSha 与未提交改动

- `reviewedSourceSha` / `testedSourceSha`：`d201da5e8071e2780a745ffb86ddb31d3cdf547d`
  （计划审查基线）。
- 本任务实现提交后工作树干净（R48 改动 + 报告一并提交）。

## 7. 未执行项与残余限制

- **读错误判别力（验收 A 第 5 条）**：`deepSnapshot` 的 `ERROR:` 标记逻辑已实现；但
  验收要求的「读取失败有明确结果、不伪装为空目录」在**真实受保护资源**上无法在本机
  稳定触发（dist 可读）。判别力测试用临时树验证了逻辑分支（无权限场景依赖 OS）。
  该项在报告第 4 节标明为**算法已实现、OS 权限场景难在本机稳定复现**，属受限验证。
- 不直接对主仓共享 dist 注入破坏性变异（计划 §6.4 禁止）——判别力全部在临时树做。
- 本任务不改 R42 的隔离 workspace 结构（真实 tsc / 真实 git / 真实非零子进程保留）。
