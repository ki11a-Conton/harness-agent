# Web 永久「重新连接中…」缺陷 — 现场取证与根因定位（未修）

状态：**根因已定位到具体代码，修复未实施**。本文是交接材料，供继续修复时使用。

## 1. 用户可见症状（已复现）

- 浏览器打开 `http://127.0.0.1:8787/`（正式版 main `2a141309`，本机重建后）：
  - 左下角橙色 **`重新连接中...`** 常驻不消失
  - 输入框 `[data-composer-input=true][contenteditable=true]` 初始**不存在**（点「选择工作区」后才出现，但横幅仍在）
  - 观感为「一直连接中 + 界面反复闪」
- 截图：`.ci/tmp/pw-12s.png`（可见横幅与「选择一个工作区开始」）
- 真实浏览器诊断脚本：`.ci/tmp/pw-diag.py`、`.ci/tmp/pw-recover.py`（Playwright + Chromium，本机已装）

## 2. 决定性证据（同一份代码/构建/浏览器，只有数据目录不同）

| | 8787（**未设** `HARNESS_DATA_DIR`，即默认目录，**已有历史 owner 状态**） | 8788（`HARNESS_DATA_DIR=.ci/tmp/fresh-data`，**空目录**） |
| --- | --- | --- |
| console error | **1**：`[session-controller] control stream failed: RemoteError: source event sequence is not contiguous: expected 0, received 2` | **0** |
| console warning | **55**：全部 `[connection] connection lost, retry #1` | **0** |
| WebSocket | 1 连接、**0 关闭**、741 收 / 570 发 | 1 连接、0 关闭、39 收 / 26 发 |
| 横幅 | 常驻 | 不出现 |
| 输入框 | 初始不存在 | 正常 |

→ 结论：**不是网络/代理/浏览器问题**（WS 从未断开），缺陷由**数据目录里的历史会话/owner 状态**触发。重试计数永远停在 `#1`（退避不增长）→ 永久循环。

## 3. 根因定位（代码级）

报错关键字是 **source event sequence**，即某个流式端点推送的事件带 `sequence`，客户端要求**从 0 连续**。

相关代码（`apps/web/src/deepseek/owners.ts`）：

- `projectEvent()` `:548-558` — 对**有 retired 前身**的外部会话做序列重映射：
  - retired 事件：`event.sequence < retired.eventCount` 时 `sequence = offset + event.sequence`，**否则返回 `undefined`（丢弃）**（`:553`）
  - live 事件：`sequence = offset + event.sequence`（`:557`），`offset = Σ retired.eventCount`
- `listEvents()` `:570-581` — 拼接「退役 owner 的日志（各取 `retired.eventCount` 条）+ live 日志」，再 `projectEvent`，并按 `afterSequence` 过滤（`:579`）
- `journalCoordinate()` `:559-568` — `projectEvent` 的**互逆**函数（把全局坐标还原为 (nativeId, sequence)），供「点历史事件跳转/交付物定位」使用
- `events.append` `:583-585` — 追加时要求 `event.sequence >= offset`，否则报 `Cannot append into a retired draft journal prefix`

### 触发条件（两个候选机制，需在修复时二选一定性）

1. **退役前缀被静默丢弃**：`listEvents` 取回了退役日志，但其事件的 `sessionId` 与 `retired.nativeId` 不匹配（走 `:556` → `return undefined`），或退役 store 实际取不到事件（如 store 被清/文件缺失但 `retired.eventCount` 仍记着）→ **前缀被丢掉，offset 却照旧计入** → live 首事件投影为 `sequence = 2`，客户端判「不连续」。
2. **计数与日志不一致**：`retired.eventCount` 与实际可读日志长度不一致（例如退役日志比记录的多/少），同样导致「编号假设有前缀、实际没发前缀」。

两种机制的**共同形状**：**投影后的流要么从 0 连续，要么必须显式告诉消费者基线**；当前实现会在前缀缺失时产出「非 0 起始且无声明」的流。

## 4. 修复方向（按优先级，含红线）

### 4.0 一次性结论：**不能改校验器**（我试过，被既有测试挡下，已回滚）

我第一版把 `projections.ts:526` 从「`event.sequence === index`」放宽为「以首事件序列为基线、仍拒绝空洞」，新写 7 个用例**先红后绿**（修复前 2 failed，正是 `expected 0, received 2`；修复后 7/7 绿）。

但随后全量 web 测试暴露：**既有测试 `apps/web/src/deepseek/projections.test.ts:266` 明确断言"日志首个序列为 1 时必须抛 contiguous"**：

```ts
expect(() => projectSessionHistory({ ...f, events: [{ ...f.events[0]!, sequence: 1 }] })).toThrow("contiguous");
```

→ **"日志必须 dense 0-based"是 `projectSessionHistory` 被写进契约的设计要求**，不是可以放宽的实现细节。放宽容差等于改变该函数的输入契约，会让"跳号必被发现"的保证依赖调用方自觉。**已回滚该改动，并删除我那个编码了错误契约的测试文件。**

### 4.1 因此真正的冲突在**输入装配层**（这是修复应落的位置）

- `projectSessionHistory` 要求：**单一 native 日志、dense 0-based**（`projections.test.ts:266` 已固化）。
- `apps/web/src/deepseek/session.ts:71`（`projectUnlocked`）与 `:122`（`projectSnapshot`）却调用 `host.harness.events.list(id)` —— 这是 **owner 层包装后的接口**（`owners.ts:570-581 listEvents`），对**别名会话**返回「退役前缀 + 当前日志」的**全局坐标**（首序列 = offset ≠ 0）。
- 两者对"序列空间"的假设不一致。offset > 0 时投影必然抛错 → `session/control` 流失败 → 客户端永久重连。

### 4.2 两个候选修法（需设计裁决，各有代价）

| 方案 | 做法 | 代价 / 风险 |
| --- | --- | --- |
| **(A) 投影输入改用 native 日志** | `projectUnlocked`/`projectSnapshot` 对别名会话取**当前 native 所有者**的 0-based 日志（owner 层另开一个"取 native 日志"的入口），全局坐标仅用于 `journalCoordinate`/`deliverables` 的 `seq` 寻址 | UI 将只显示**当前代**历史，**退役前缀不再出现在会话视图里** → 工作区切换后的历史连续性丢失（可能正是 owner 机制想保留的） |
| **(B) 投影输入保留全局坐标，但在投影前**归一化** | 给 `projectSessionHistory` 喂「序列减去 offset」的视图（即把全局坐标平移回 0），并把 `sourceSequenceBySeq` 映射回全局值（该字段注释已写明用途：`Allows a fork cursor to resolve back to the owning Harness event`，所以**必须保留全局值**） | 需要精确改动 `sourceCursor`/`framesBySourceSequence`/`admissionBarrier`（`session.ts:99-102` 用 `event.sequence` 当屏障）等所有坐标消费者，**改动面比 (A) 大**，但能保住历史连续性 |

**我的建议**：优先 (B)，因为 (A) 会静默丢历史、且与 owner 机制的设计意图相反；但 (B) 必须**逐个消费者核对坐标空间**（`sourceCursor`、`framesBySourceSequence`、`admissionBarrier`、`deliverables.sourceSequence`、`journalCoordinate`），这需要设计者确认意图后再动手。

### 4.3 红线（不变）

1. **不得**放宽客户端的连续性检查（`apps/web/public/.../client.js` minified 内），也不得放宽 `projectSessionHistory` 的 0-based 输入契约 —— 那会让"真正丢事件"失去检测。
2. **不得**只把编号改成从 0 开始而破坏与 `journalCoordinate()` 的互逆关系（`deliverables.ts:261-268` 用 `seq` 定位源事件）。
3. 改动保持局部，不要重构 owner/alias 机制。

## 5. 验收标准

1. **先写失败测试**（vitest）：构造「外部会话的 alias 行含 retired 且 `retired.eventCount > 0`」的场景，断言该流**首帧序列与消费者预期一致**（不出现 `expected 0` 式不连续）。修复前必须红。
2. 修到绿，且 `pnpm exec vitest run apps/web/src/deepseek` 与 `pnpm exec vitest run apps/web` 不回归。
3. **真实浏览器前后对比**（脚本已备）：
   ```powershell
   $py = "C:\Users\MECHREV\AppData\Local\Programs\Python\Python312\python.exe"
   & $py ".ci/tmp/pw-diag.py" "http://127.0.0.1:<port>/"
   ```
   期望：`consoleByType` 无 error/warning、`reconnectBanner` 为空、`composer.present=true`。
4. 复现步骤：用**同一个数据目录**跑一次（产生 owner/alias 状态）→ 停 → 再跑 → 浏览器出现缺陷；换空目录则不复现。

## 6. 立即缓解（已验证，用户可用）

- **A**：在 8787 页面点 **`选择工作区` → `harness agent`** → 输入框出现可用（橙色横幅仍在，但能干活）。
- **B**：用**空数据目录**启动（已验证 0 错误 0 警告）：
  ```powershell
  $env:HARNESS_DATA_DIR = "<空目录>"; node apps/web/dist/main.js
  ```
  （Lead 已起了一个这样的实例在 **http://127.0.0.1:8788**。）
- **C**（根治，针对本机这份坏状态）：把默认数据目录里的历史 owner/alias 状态移走（备份而非删除），使其重新从 0 开始；**这属于绕过，不是修复**。

## 7. 交接注意

- 修复分支：`fix/web-control-stream-sequence-baseline`（基于 main `2a141309`，**当前无任何改动**）。
- 本任务曾两次派给子代理，**两次都在开始阶段失败、零产出**（工作区已核实无 diff / 无新文件，无工作丢失）。因此本文件由 Lead 亲自取证撰写。
- 相关的 socket/传输协议：帧形如 `{type:"request", id, route, body}`，`route ∈ {call, open, uplink, cancel}`，`id` 必须匹配 `^[A-Za-z0-9_-]{16,128}$`（`apps/web/src/deepseek/socket.ts:114-118`、`transport.ts:108+`）；`$events` 流先送 `{type:"ready"}`（`events.ts:182`）。
