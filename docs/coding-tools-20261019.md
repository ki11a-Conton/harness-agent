# 从开源 coding agent 学习：工具效率与定位可靠性

本轮在 `7a596f058d4f7df28cbc39bc1740b725916e00d5` 上实施两项工具改进。详细范围和验收合同见 [计划](../plan(20261019-004500).md)。不调整 Core/Runtime 架构，不改变默认策略，不把已有能力重新记为新增。

## 源码对照与取舍

固定快照、实际阅读文件和 SHA-256 见 [sources.json](evidence/coding-tools-20261019/sources.json)。HARNESS-SRC-FORK 的 SHA 是收集仓库的快照，不是每个上游项目独立的 revision。

| 参考实现 | 代码中的做法 | Harness 现状及本轮落地 |
| --- | --- | --- |
| pi `edit-diff.ts::applyEditsToNormalizedContent`、`edit.ts` | 所有锚点在同一原文匹配，拒绝歧义和重叠，再应用变更 | 设计改编到 `applyBatchReplace`；增加版本必填、原文偏移、BOM/局部换行保留。保留 MIT 许可，不引入 fuzzy/Unicode 匹配 |
| Aider `repomap.py` | 任务相关候选、个性化排序及受限上下文 | Harness 已有 AST/候选关系图/PageRank；此次补 `queryPath`，使已知工作范围不被根目录的扫描上限遮住 |
| Codex `apply-patch/src/parser.rs`、`context_manager/history.rs` | 结构化编辑校验；保持工具调用/结果配对和上下文边界 | 参考预校验思路，保留现有 Orchestrator 与压缩体系，无 Runtime 移植 |
| Hermes `agent/coding_context.py` | 有界源码检查、聚焦当前工作集 | 显式缩小代码候选范围，继续复用既有预算与版本失效机制；本轮不重写记忆系统 |
| DeepSeek `context/file-reference/src/grammar.ts` | 显式文件范围、能力接口由组件拥有 | 通过现有工具参数暴露能力，更新工具拥有的建议，不叠加一套全局提示词 |

ZCode/Claude 的旧分析不作为本轮新阅读或新增代码的证据。pi 的改编说明和完整许可证位于 [third_party/coding-tools](../third_party/coding-tools/NOTICE.md)。其余参考没有复制实现代码。

## 可用接口

先调用 `read_file`，参数 `{"path":"src/example.ts","versioned":true}`，保留真实返回的 `sha256`，再调用：

```json
{
  "path": "src/example.ts",
  "expectedSha256": "这里必须填入版本化读取返回的64位sha256",
  "edits": [
    { "oldText": "const first = 1;", "newText": "const first = 10;" },
    { "oldText": "const second = 2;", "newText": "const second = 20;" }
  ]
}
```

同一批最多 64 项。锚点在原文中唯一且互不重叠；后项不能依赖前项生成的文本。缺少版本、版本冲突、缺失/重复/重叠锚点、混用旧选择参数或整批无变化时，不写文件。失败后依据实际错误重新读取并计算。原有单项、occurrence、replaceAll 和行范围接口继续可用。

已知目标子目录时调用：

```json
{ "query": "formatInvoice", "queryPath": "packages/billing", "maxFiles": 20, "maxCodeTokens": 1600 }
```

`queryPath` 必须与 `query` 同用，支持工作区内文件或目录，保留路径中的有效空格。它只限定 `relevantCode` 的扫描、文件和指纹；全局概览仍由 `maxFiles` 独立控制。`scope` 明示结果所属范围。TS/JS、Python、Rust、Go 使用现有 Tree-sitter 索引，引用仍是候选关系，`semantic:false`。预算不足以保存 scope 身份时返回错误，不输出超预算或冒充全仓的结果。

## 已测结果

通过实际生产 CLI 入口、Web HTTP 消息、SSE 审批、原生工具和 Verification 执行。两组使用同一脚本 provider、模型身份、权限策略、验证命令、独立项目及状态目录；脚本只依据实际 schema 选择接口，并从实际工具输出取得锚点和版本。

| 指标（CLI 和 Web 均相同） | 基线 | 本轮 |
| --- | --- | --- |
| 总工具调用（含一次代码图及一次测试命令） | 8 | 4 |
| 版本化文件读取 | 3 | 1 |
| 编辑工具调用 | 3 | 1 |
| 三处修改后的文件 | SHA-256 `a95bc4f26775eb0fb603e8e51dd11bc4a040f90c4ca5a5ef6074943b5d6ba6dd` | 完全相同 |
| 独立 Node 测试及宿主 Verification | 通过 | 通过 |
| 510 个干扰文件前置的代码定位 | 根扫描到 500 文件上限，漏掉目标 | 指定已知目录后扫描 2 文件，目标和调用方均可见 |

调用计数不含两组相同的宿主 Verification 命令。编辑调用是工具层计数；“一批一次实际写入”另由真实 FS 写入的观测回归验证，未将工具调用数冒充任意进程的底层写次数。

原始请求、Web 事件、运行日志、独立测试、diff 和回执保存在 [证据目录](evidence/coding-tools-20261019/README.md)。候选本地验收使用未提交的工作树，回执保留 `sourceTreeClean:false`，以文件哈希识别实际变更；提交后的精确 SHA 由远端 CI 验证。

## 验证边界

新增回归覆盖原文匹配、BOM/混合换行、歧义/重叠/缺失锚点、版本冲突、并发一胜一败、取消、无效 UTF-8、真实权限/沙箱拒绝、四种语言超扫描预算、指纹失效、单文件 scope、ignore、软链接逃逸、小预算及有效路径空格。实际 Runtime 测试先触发失败批量，再使用同一未受损版本修复并验证。

最终本地全量在干净提交 `86cde6ff` 上 10018 项通过、0 失败、16 项平台条件跳过；另有安全2147项、旧接口/策略兼容42项、Windows回执解析器7项和类型/docs检查通过。原先由未提交源码及输入变化触发的7项评测失败保留原件，固定源码后相同检查全部通过。

主 CI 的双平台验收及原生 Windows 流程均执行新的真实 CLI/Web 脚本；Windows 回执额外强制核对四项新用例，原有必验项目保留。

本轮结果证明工具接口和工程链路的效率及正确性。付费真实模型调用为 0，真实模型的自主成功率、提示词服从、长任务质量仍为 `NOT_PROVEN`。不推广 challenger 为默认策略，不据此发布新 release。批量编辑沿用进程内锁和落盘前的 best-effort 版本复核，不承诺与任意外部写进程之间的原子 CAS、断电安全或多文件事务。

真实Windows主CI另暴露了测试夹具的派生owner端口可用性缺口，已补充完整准备阶段的有界分配及6项真实回归；详见[跟进证据](evidence/coding-tools-20261019/windows-fixture-followup/README.md)。此修复不改生产租约协议，第一次失败保留，新提交继续执行完整CI。
