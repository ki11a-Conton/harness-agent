# Optimization Report

`benchmarks/README.md`（"知道缺口→已修复"）与 `plan.md` 均引用本文件。本文件是
Agent Runtime 之行为/健壮性/可测性优化（非 benchmark 性能实现）的权威记录；
每项均为**已落地且有测试/typecheck 佐证**的事实，无规划性承诺。

## 适用范围

这里记的是「正确性 / 安全性 / 可靠性 / 可测性」优化轮次（`optimization`），
不是 benchmark 吞吐数字。结构上按时间与主题分块，新增项追加到对应块末尾并
标注日期。任何声称「已修复 / 已实现」的条目，必须能在此仓库中找到对应代码与
测试，否则视为失真写入（违反 Q-18 Documentation Truthfulness）。

## 已落地的修复与硬化

以下各项与 `benchmarks/README.md`「已修复」清单一一对应（为其详细版）：

- 事件发射：runtime 现发出 `context.built` / `context.compacted`。
- 工具重试：recovery 按能力门控（`retry:"safe"` 才自动重试），exec/write/edit
  绝不盲目重试。
- 压缩摘要：runtime 注入结构化摘要（goal/完成/命令/错误）+ transcript fallback。
- context-length 模型错误：reactive compact 一次后失败，不再盲目重试。
- 大 Tool Output：Tool Output Budget（>16KB 落盘工件 + 预览 + sha256）。
- 会话推进：SessionInbox（steer 安全边界注入；followup 队列）。
- 同响应多 tool call 相位机崩溃：修复。
- stall / 墙钟预算：`maxRepeatedToolCalls` + `maxDurationMs`。
- benchmark：Phase 6.5 四套 suite + retry taxonomy + recovery rate + judge_version
  跟踪；adversarial 13 + stress 11 用例已生成（holdout 仍属规划）。
- exec 沙箱：`packages/security/src/network-gate.ts`（shell 感知分词 + 五类判定，
  非朴素子串）对 exec 命令做结构化网络意图检测；deny 策略直接拒绝并 emit
  `security.network_denied`；allowlist 模式按 host 校验。
- memory/skill 写入前扫描：`injection-gate.ts`（HARD 指令劫持 deny + SOFT 载荷
  框架仅 flags）与 `secret-gate.ts`（API key/token/私钥/凭据赋值/DB 嵌入式凭据），
  接线 `evaluateCandidate` 优先于 importance/novelty，覆盖 JsonlMemoryStore /
  FileSkillLoader / JsonlSkillStore；`onSecurityDenied` 回调在 throw 前触发。
- skill 索引：ContextPipeline 将 skill 元数据转为 `source:"skill"` 块；runtime 发射
  `skill.discovered`。
- 故障注入集成：`fault-injection.test.ts` 8 类场景。
- 既有 memory 文件读取侧安全扫描：`JsonlMemoryStore.scanForSecrets()`。

## Q 阶段测试/可靠性硬化（2026-08-19）

`plan.md` Q-phase 低风险加固项，全部有独立测试与 typecheck 佐证：

- **Q-2 消除工具名启发式**：执行语义改由元数据/风险推导，弃用按名字猜测。
- **Q-3 共享错误分类学**：集中式类型安全错误码 / 终止原因 / 重试分类。
- **Q-5 稳定序列化**：排序键 + 循环引用/BigInt/undefined 显式处理 + SHA-256。
- **Q-6 时钟注入**：运行时确定性决策统一走注入时钟，无真实墙钟依赖。
- **Q-7 timer 抽象**：`contracts|timer.ts` 提供 `Timer`/`RealTimer`/`ManualTimer`/
  `sleep`，runtime retry backoff 与 approval expire 改走注入 timer，测试用
  `ManualTimer.advance` 确定性驱动，无需真实 sleep。
- **Q-8 确定性 ID**：`installDeterministicIds()` 计数式源，测试可重放快照。
- **Q-9 测试夹具构建器**：`contracts|testing.ts` 共享数据层 builder。
- **Q-10 无静默 catch**：全仓扫描，消除 `catch {}` / `catch { return default }`。
- **Q-11 资源清理**：timers/AbortSignal/子进程/文件句柄/SQLite 显式清理确认。
- **Q-12 路径一致性**：Windows/Linux 跨平台路径处理一致。
- **Q-13 CI 管线**：GitHub Actions（install/typecheck/test/build/bench 冒烟）。
- **Q-14 覆盖率**：关键包 per-package 阈值。
- **Q-15/Q-16 变异+模糊**：安全解析器对抗输入随机化。
- **Q-17 向后兼容**：schema 版本 fail-closed。
- **Q-19 生成态/临时文件卫生**：`.gitignore` 全覆盖生成物与运行态目录。
- **Q-20 来源/许可证纪律**：机制注册表 `provenance` 必填，`derived` 强制
  `attribution`，杜绝无意识复制长代码块。
- **Q-4 类型化事件负载**：contracts `event-payloads.ts` 关键事件具名 payload +
  规范 `toolNameOf` 访问器，消除 `payload.tool ?? payload.name` 字段漂移。

## 已知限制（诚实保留，未解决不声称）

与 `benchmarks/README.md`「仍存在」一致：

- **消息历史不参与上下文预算**：context budget 只治理 system prompt 块；消息级
  微压缩需 store 支持消息替换（Phase 8 已落地消息裁剪注入摘要，store 仍保留全量
  transcript）。
- **完整 benchmark 运行需 OPENAI_API_KEY**（未提供）。
- **holdout suite 仍属规划**（30 用例待生成）。