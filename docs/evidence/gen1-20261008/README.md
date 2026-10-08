# 第一代开发回归证据

本目录保存 2026-10-08 已完成的局部 RED/GREEN 原始结果、真实子进程 probe、短日志、会话索引与对应审查/来源清单快照。JSON 保留完整结构；文件没有重新命名成“固定版本通过”，没有把中间失败隐藏在最终局部通过里。

`manifest.json` 为每个文件记录 SHA-256、字节数、kind、scope、原路径、状态及其依据、来源快照引用。`baselineContext` 只说明审查从哪里开始；每个 `fixedSource` 均为 null，因为这些结果来自不同阶段的开发工作树。局部 GREEN、mock/离线协议测试与 native probe **不等于最终 release acceptance，也不证明付费模型的 coding 成功率**。发布必须另行把 clean 源码 SHA、完整检查与真实平台结果绑定；主交付流程负责增加该验收记录，不能用本目录替代。

会话的 `stateful-provider-restart.json` 保留已观察到的 CONFIG_DRIFT_REJECTED RED，包括其当时 sourceHashes；`provider-config-identity-red.json` 保留后续独立 RED。它们描述测试时的源码状态，不表示后续修复一定仍失败。`session/index.json` 中“Final”指会话子任务当时最后一轮，仍属于开发回归。

空 typecheck 日志标为 UNVERIFIED，因为空字节不能证明退出码。独立日志标为 OBSERVED；有对应 Vitest JSON 的日志只引用该结果，不作为独立验收计数。GREEN 报告中的 skipped/pending 数量仍保留，例如 Linux 上跳过 Windows 专项，不能宣传为 Windows 已验收。

来源清单快照记录已阅读上游的 Git SHA、文件 SHA-256 与许可；验证器检查引用结构和归档字节，不在线下载上游，也不把上游清单当作当前产品源码绑定。native probe 中的旧 sourceHashes 同理，只保存当时观察，不能强制套用到后来工作树。

在仓库根目录执行：

```sh
node scripts/research/gen1-20261008/verify-evidence.mjs
```

也可给验证器传入独立归档目录。它不依赖 npm 或网络，校验所有 manifest 文件哈希与长度、来源引用、session index 的引用及 Vitest 摘要，并拒绝未知 schema、缺失文件、目录逃逸、重复路径、未登记 artifact 与未经证明的固定源码声明。开发归档总量小于 5 MB。

收集完成时：85 个 artifact，共 1,383,954 字节，正常验证通过。四个独立临时副本反例分别改文件字节、使用未知 manifest schema、删除来源引用目标、篡改 session index 的引用哈希（同时更新外层 artifact 哈希），全部被验证器拒绝。该结果只验证归档完整性与拒绝行为，不会重新执行旧测试。

完整验收产物不在本次局部归档范围内；交互报告中的 `.ci/gen1/interaction` 命令是验收入口，本次收集时该目录不存在，因此没有伪造该输出。
