# v1.12 发布门禁的平台计数修复

## 观察与缺陷

源码 `b1c4c982d4c3a7bc7270815b90a3a91267045f22` 的 [同包安装工作流](https://github.com/ki11a-Conton/harness-agent/actions/runs/39825488950) 在 Ubuntu、Windows 均成功。[Linux 收据](actual-linux.json)和 [Windows 收据](actual-win32.json)从该工作流对应 job 的 `Coding acceptance receipt` Checks 注解 lossless gzip/base64 解码，格式化后保存；计数和内容未改动。

| 平台 / job | 实际编码断言 | 实际 HTTP 请求 | 明示跳过 |
| --- | ---: | ---: | --- |
| Linux / 119987970018 | 50 | 19 | 无 |
| win32 / 119987970055 | 49 | 18 | POSIX SIGINT CLI case |

`scripts/research/coding-audit-20261007/acceptance.mjs` 的 `process.platform !== 'win32'` 分支仅在 POSIX 发送 SIGINT，产生一项取消断言及一次模型 HTTP 请求；Windows 收据明确说明原生进程树取消由专项覆盖。同源码的 [真实 Windows 专项](https://github.com/ki11a-Conton/harness-agent/actions/runs/39825564386)成功，包含原生取消和超时回归。

原 exporter 把两平台统一要求为 `>=50` 断言、`>=19` 请求，必然拒绝上述完整 Windows 收据。原 21 项测试把 Windows fixture 也写成50/19，漏掉了真实平台差异。[导出 run 39830447189](https://github.com/ki11a-Conton/harness-agent/actions/runs/39830447189)失败，草稿资产仍为空；该 run 的可获取 Checks 只提供 exit1，没有完整异常栈。本地以实际收据计数构建的门禁回归明确在旧代码触发 `CANDIDATE_CLI_CONTROLS_REJECTED`，不据此推断该远端 run 是否还遇到其它错误。

## 修复与验收

- exporter 按实际完整适用项要求 Linux `>=50/19`，win32 `>=49/18`；源码、版本、归档哈希、doctor、cleanroom、篡改拒绝、零付费/工作区链接及逐资产草稿保护保持。
- 测试默认使用这两份实际收据的计数；原 Windows49/18反例在旧 exporter 下 RED，在修复后 GREEN。分别拒绝 Linux49/18、Windows48/17，以及非安全整数和无效标志。
- 保留 POSIX SIGINT 原用例、真实 Windows 专项及所有原始收据。新候选必须重新固定源码 SHA，完成全量、实际同包 Web/CLI、四组 CI 与导出、公开下载验收；本目录不代表新候选已发布。

本地红绿原始日志和哈希索引保存在 `/workspace/.cache/harness-longrun-20261020/release-v112-platform-fix`，最终工程报告由发布协调者另行冻结。
