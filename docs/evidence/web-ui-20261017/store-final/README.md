# U13 修正后的固定源码完整验收

实现、全仓测试、构建和安装验收脚本均固定为
`f2788ee508be6e204fe1ce73527a8a0f32022599`，tree
`c8ccd70684081a85f9fb3cd107c75e33ac7a7b20`；前后 HEAD 不变且工作树干净。

| 验收 | 结果 | 原件 |
| --- | --- | --- |
| 全仓 pnpm test | 9874 PASS / 15 既有 SKIP / 0 FAIL；594 文件通过 / 2 跳过 | store-full-clean.json、store-full-clean.log.gz |
| 离线 portable 构建 | 3125 文件；退出 0 | store-portable-build.json/log、archive-SHA256SUMS |
| 仓库外同包实际浏览器 | 原 UI 30/75，新 UI 42/117，连接恢复 2/10 | installed.json、browser/daily/connection.json.gz |
| 安装与驱动身份 | 0 workspace links，应用/脚本 f2788ee5，逐文件载荷复验 | store-installed-final.json、compiled-*、launch、实际 provider 请求 |
| 首次候选 Windows/Ubuntu | 两个工作流完整成功，attempt 1；代码相同 | ../store-candidate/README.md |

归档 SHA256 `1463e7af8f7aa592e2220fb3406e2f95e8d637ec523c643390a652e13a2c31da`。
Chromium 140，合计 74 场景/202 具名检查。copy-map.json 保留原路径、原始摘要和
压缩关系；gzip 时间固定为 0，解压日志仍保持原字节。原失败位于相邻原件目录，未覆盖。

候选仅证明该固定实现的首次 Windows 专项和双平台同包 UI/CLI；最终 main
四工作流/十项主 CI 仍需按精确推送 SHA 独立复核，记录由 GitHub Checks 与
工作区外 CI 报告提供，避免再次归档改变已验收 SHA。付费调用 0；不证明模型
质量、完整默认 UI parity，或本地强沙箱内 PTY 执行。本轮不发布 release。
