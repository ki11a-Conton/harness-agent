# Backend 与正式 Ask Gate 最终复核

此目录是最终集成复核增量证据，均使用项目真实 Harness、受控 ToolOrchestrator、实际文件/持久记录及 loopback HTTP provider；没有付费模型调用。这些测试证明接线、身份和确定性安全边界，不证明模型 coding 质量或默认 Web UI 已完成全部 parity。

## 修复与验收

| 问题 | 做法 | 证据 |
| --- | --- | --- |
| 生产 HTTP 的 `tools` 未包含正式 `ask_user`，模型无法发现提问能力 | 在冻结 step 中加入独立 `formalActionSpecs`，克隆冻结并纳入 router fingerprint；固定闭合 schema，在现有 phase controller 校验并暂停/恢复。没有注册 ToolDefinition。保留旧显式 gate catalog/handler 和无 store 的 event-proof 兼容路径 | `formal-ask-production-red.json`、`formal-ask-targeted-green-v2.json`（55/55）、`formal-ask-runtime-protocol-green.json`（93/93） |
| 默认 workspace service 漏掉未推广的 durable inbox 工作，归档可假成功 | 检查本人及 descendants 所有非 consumed prompts；没有真实原子 queue cancellation 时 `stopActivity` 后仍拒绝归档 | `archive-queued-red.json`、`archive-queued-green.json` |
| 文件预览可能在 alias CAS 与 activation 之间把稳定会话缓存成缺失 | 每次 file RPC 与 watch sample 使用同一 owner 的短锁；不跨 watch yield 或等待持锁 | `preview-alias-activation-red.json`、`preview-alias-activation-green.json` |
| 凭证检查只覆盖返回的 byte/text fragment，可通过多个小范围绕过 | 在同一个 opened fd 获取完整 ≤32 MiB 有界 snapshot，检查完整凭证内容与 stat 版本，之后仅从该 immutable snapshot 返回范围或行页 | 上一独立审查的 `final-review/composition-security-preview-red.log`；本目录 `preview-credential-range-green.json`，正常 UTF-8/binary 范围也在最终联合套件回归 |
| 私有 owner-index 可指向 outside hardlink；stat 后文件增长可绕过 byte limit | 私有 fd `nlink===1`、按 descriptor 读取 ≤2 MiB+1 的硬界、前后 stat 校验；打开后 ENOENT 不被当作首次空索引 | `private-metadata-hardlink-bounds-red.json`、`private-metadata-hardlink-bounds-green.json` |
| 私有 staged upload receipt 可被 hardlink 替换 | opened fd 私有单链接、已有 bounded read、前后 stat/路径一致性检查 | 同上 |

额外实际验收：typed alias 在 approval/ask/inbox/artifact/checkpoint 保持 native 存储身份，checkpoint checksum 不变，physical private ID 与跨会话 turn forgery 被拒绝；实际 staged upload durable commit 与 model replacement 共锁，上传确认前不会切换 owner。`typed-alias-and-upload-lock.json` 是这两项的单独运行。

官方 desktop path DTO 在 headless host 返回 `canOpenWorkspacePath=false`、applications 空数组、open/reveal 明确 unavailable；多余/未知参数与未知 endpoint 被拒绝且没有创建会话、进程或改变文件。见 `official-desktop-path-contract.json`。

## 最终结果与历史记录

- `final-domain-and-formal-ask-suite-v2.json`：302 tests，302 PASS / 0 FAIL / 0 pending，覆盖全部当前 `apps/web/src/deepseek` module tests 以及正式 Ask、answer identity、step snapshot/invariant、Runtime 和真实 wire protocol。
- `typecheck-final-v2.log`：`pnpm typecheck` 完成，exit 0。后续根任务仍需在固定 source 上执行整个仓库与 portable/platform 门。
- `initial-domain-suite.json`：修改前 owned 域 57/57；`all-deepseek-module-suite.json` 保存当时 146 tests / 4 FAIL 的真实中间结果，未覆盖成最终绿色。
- `formal-ask-targeted-green.json` 文件名是第一次尝试的预期目标，实际内容 **15 FAIL，不是 GREEN**；正式结果在 `formal-ask-targeted-green-v2.json`。失败主要暴露旧 explicit gate catalog/no-store event-proof 的兼容契约，已修复并回归。
- `final-domain-and-formal-ask-suite.json` 保存 302 tests / 1 FAIL 的中间结果：selected coding fixture 使用不符合官方 provider ID 约束的 `localCoding`。fixture 修正为 `local-coding`，生产 regex 未放宽；单独运行 `canonical-provider-fixture-green.json` 和最终 v2 全套均通过。
- `capture-publication-barrier-green.json` 修正测试对内部 numeric convenience key 的过早读取；原来的实际 HTTP 查询仍在 durable announcement 发布期间断言立即可用，没有降低客户端可见的正确性要求。

使用 `-t` 的单项 JSON 会把未选择的测试记录为 pending/filtered；只能按实际执行数解读，不能把单项运行称为完整套件。
