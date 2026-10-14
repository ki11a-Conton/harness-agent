# PR 集成及 Web 连接验收原件

固定产品源码 `3af15705a9046a370617b9f0dd2948719fee7102`，Git tree `8e82a39e4c96f2048ca432dcda8e76083f92adc5`。验收与合并结论见 [审查报告](../../pr-integration-web-20261014.md)。归档子提交只增加报告和原件，产品验收结果绑定上述 SHA。

`raw.tar.gz` 保存原始文件字节；把深层临时测试目录封入 tar，避免增加 Windows Git checkout 的路径长度。`manifest.json` 列出每个文件的大小与 SHA-256、归档摘要和松散文件摘要。运行 `python3 verify.py` 可在内存读回逐项验证，无需解包。

原件目录索引：

- `original-pr-review/`：原始 PR 元数据、固定 head 差异、审查报告、17 个 RED 反例及 2 个正向控制；这是审查时点的快照。
- `red/`、`offline-red/`：Web 原始离线提示和时钟/连接反例；`browser-source*` 保留失败、诊断与修复后结果。
- `full-3af15705.log`、`full-final-receipt.json`：固定源码全量 9,707 PASS / 15 SKIP / 0 FAIL，退出 0；相关测试计数与全量重叠。
- `installed-ui-diagnostic-fix/`：真实安装包的三视口编码 UI、连接恢复、截图及原始消息记录；`installed-cli-diagnostic-fix/` 保存真实编码、审批、验证、重启和篡改验收。
- `portable-diagnostic-fix/`：内部测试包的 build receipt、摘要和构建日志；不归档大型包二进制，不替换公开 v1.10.0。
- `ci/final/`：原生 GitHub API 的固定源码运行/任务/步骤状态、公开 check annotations 与恢复出的 case records；Windows 用例摘要再次核对。
- `remote-before/`、`remote-after/`、`merge-result.json`：实际 PR heads、main 更新、merged 状态及既有 release/tag 资产标识。
- 其余 JSON/log：构建、资源封存、依赖公告、回归、早期失败与取消记录。`2b8265c0` 已撤销验收，不报告为通过。

未下载原始 Azure artifact；保存的 API、annotations 和无损恢复原件不冒充其原始 vitest JSON。远端 installed 工作流按真实固定 SHA 的成功任务/步骤验收；本地安装包详细 receipt 完整归档。旧冻结证据和公开 v1.10.0 资产没有重写。

工程调用均为 loopback 测试 provider，付费调用为 0；模型质量和完整默认 UI parity 未在本轮晋升。用户本机提示的原始触发没有日志可确认，已关闭的是两个确定复现并实测恢复的连接状态缺陷。

12a43d30 的本地通过记录保留为前一阶段；其 Windows 第二轮 test gate 失败，整轮 CI 不通过。R12 两个摘要反例先 RED 再 GREEN；新提交 3af15705 重新执行全部验收，原始 Windows 失败用例仍不能从旧摘要确认。
