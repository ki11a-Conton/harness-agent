# 固定运行时代码验收 b38566d

Runtime source `b38566d5c370509db58cbb495aaf4eb68cbe3ce3` / tree `bf6272b1e03ba788a1437f0520dfaba4d614f94c`。本地完整 9,473 PASS / 15 skipped（549 文件）、安全 2,146 PASS、协议 52 PASS。原始 JSON/日志与 inventory 一起保留。

实际官方 UI 独立包消费：本地 Node 24 三视口 30 场景 / 75 断言 PASS；GitHub Ubuntu 与 Windows 在同一 archive SHA256 `337011c5f54c1d505f2988b79f4451c3562a2003267f70b340bedb24a639e293` 各 30 / 75 PASS（run 38388121962）。本地 Node 24 archive 为 `8fc0620a8e9a78b0c84bff53e5f81589b1fa82e0431e63d9b1fcfd70597aae54`，不能混作 CI 的 Node 22 archive。文件数均为 3,034，没有 workspace links。

真实 Windows_NT 10.0.26100 / Node 22.23.3 专项：253 PASS / 1 skipped，run 38388122089。原 receipt 和全部 case records 在 native-windows-receipt.json。同一 Linux-built CLI 包在 Windows 消费：49 断言 / 18 请求、doctor errors=0、篡改校验及启动拒绝 PASS，run 38388121954；本地 CLI 消费为 50 / 19。旧 CI 脚本的 1.9.0 文件名仅是此固定源码的候选产物名，不是改写已发布 v1.9.0。

模型浏览器 18 项实际断言 PASS，包括两个 tab、真实 alternate HTTP request、原前缀历史、配置持久化、进程重启后的原角色 DOM/projection 与 Core artifact identity。一张 started-selection-refused screenshot timeout 被单独记录为 BLOCKED，不计为图片成功；相关真实请求/断言通过。

主 CI run 38388121891：真实 Ubuntu/Windows formal、两端 r97/r98、coverage 和 cold-start 通过。verify 两端最终 docs 门因 plan.md 缺“当前执行计划入口”标记失败，后续 aggregate 拒绝/attestation skipped；原始工作流不能称整体通过。根入口已补当前 marker 与真正的当前日期规格，实际 docs:verify RED → GREEN 原件保留。后续 docs-only SHA 的 gate 另行记录，运行时代码不改动。禁止把不同 SHA 的整套 CI 拼成最终 HEAD 全绿。

vendor-unchanged-assets.log 是 9c02f1b 执行的 772 文件 verifier；资产、notice 和 verifier 在 9c02f1b → b38566d 完全无 diff。来源参考 Git SHA 与 npm 无 gitHead 分别记录。所有 provider 请求为 loopback / paid=0；付费质量和完整默认功能 parity 仍为 NOT_PROVEN。W3–W6 缺口仍在，本次没有全功能生产 release。
