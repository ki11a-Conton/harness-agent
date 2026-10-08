# 第一代固定源码验收档案校验

本目录的最终产品源码固定为 `c5bbe61fef101a8c9eb10edab673be8b2e0935e3`，源码树为 `603f7cc88a3ac8b3897c296b70eef4df1133132b`。正式候选包选用 Ubuntu 生成的 `f7006e6c22655d35576bbb800870bda792cfb0df4834fc9405dd55f30e9a278b` 字节；Windows 自建包另存于原始 CI bundle，不替代同字节的 Windows 消费验收。

在解包后的本目录运行：

```sh
node verify.mjs
```

也可显式提供档案根目录与独立下载的 portable 包：

```sh
node verify.mjs /path/to/evidence /path/to/harness-agent-1.9.0-portable.tar.gz
```

第二个参数存在时，验证器还要求独立包逐字节等于原始 CI bundle 内的正式 Ubuntu 候选包。验证器仅使用 Node 内建模块，仅读本地文件，不执行被归档的程序、不联网、不修改文件。

检查包括所有 manifest 文件的安全路径、非符号链接、原始字节数与 SHA-256；gzip 原始 Vitest JSON 的解压长度/哈希及断言计数；完整套件 9284 PASS / 14 pending、安全 2143、协议 52 的真实退出与前后 clean 源码；docs、归档验证及 30 个 Node 测试的原始输出；实际 HTTP 24 项、host lease 3 项、浏览器 29 项/82 断言及其 artifact-index；两 tab 和重启 SSE 原始 turn/session/event 身份；正式 bundle 的 116 个原件及全部 portable 内部文件；Linux/Windows 安装、doctor、篡改拒绝、源码树和同包字节；三个独立 CI workflow 的源码、run/attempt、完整 job/step 终态。

`ci/installed-run.json` 和 `ci-data/export-receipt.json` 必须共同指向实际成功的 export attempt 3。历史 review 中保留的 attempt 1 及 `history/` 的失败证据只说明当时发生了什么，不能替代当前 API 门或改成 PASS。原始 receipt 里的旧路径保持不变，验证器通过 `manifest.json` 的 `originalPath` 和明确归档映射查找相同字节。

主 CI 必须完整完成固定 workflow 的 10 个具名 job、安装 CI 完成 4 个 job、原生 Windows 完成 1 个 job，并全部 success；仍运行、缺失、失败、取消或必需执行步骤跳过都会退出 1。主 CI 的冷启动、测试/构建、coverage、closed loop、formal、same-SHA 汇总和 release-attestation 均检查相应步骤的执行成功。`Fail job when…` 两个专用负向断言只在 reducer 的负面结果上执行；正常通过要求它们存在且 skipped，同时 reducer 和产物上传步骤必须 success。局部通过和 draft 资产存在不能越过这些门。浏览器 82 次断言包含 78 次逐场景断言及 4 次全局启动/清理/源码检查；Linux 的 14 个 pending 保留原值。

验证器输出 `PASS` 只表示这份固定源码的工程验收档案内部一致且必需门已通过，不代表 release 已发布；输出中的 `releaseStatus` 沿用 manifest 的实际阶段。`paidModelCalls: 0`、`realModelQuality: NOT_PROVEN` 始终保留。离线检查不能提供 GitHub API 的远程数字签名，原始 API 快照的来源由采集过程负责；本工具验证其哈希、来源身份和终态，不伪造外部证明。

这份档案在三套 CI 已全部完成、公开发布尚未发生时采集，因此记录 `ACCEPTED_NOT_RELEASED`。后续公开 release 不会回写或重新登记这些原始字节；公开发布的实际状态应查询 GitHub release，而工程证明仍以本档案记录的源码和包哈希为准。

整个档案的 manifest 包含验证器、README 等交付文件时也应登记它们；manifest 本身不做循环自哈希。历史原件只检查字节完整性，不重算失败实验或重新运行旧 probe。
