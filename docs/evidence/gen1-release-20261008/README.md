# 第一代公开交付记录

已公开发布 [v1.9.0](https://github.com/ki11a-Conton/harness-agent/releases/tag/v1.9.0)，产品源码/tag 固定 `c5bbe61fef101a8c9eb10edab673be8b2e0935e3`。本目录记录必要工程门通过后发生的发布，不改写此前214文件验收档案的采集阶段。

- `publication.json`：匿名公开Release API成功，以及从公开browser_download_url不带token下载产品包、产品checksum、最终证据包和证据checksum的实际字节/哈希。
- `public-release-api.json`：原始公开API快照，draft=false、prerelease=false，正式六个asset及原始发布时间；它是采集快照，不是远程数字签名。
- `tag-ref.json` / `tag-object.json`：原生API的annotated tag及剥离后的c5 commit；未覆盖历史tag。
- `publication-main-ref.json`：发布前已成功推送的文档归档提交 `3dab4815fe48a80599ca9cc901d0ed69ae11c78d`；后续发布状态文档子提交不改变已测试产品源码。
- `document-delivery.json`：该提交的Git-only新checkout启用core.autocrlf=true，历史90件及最终214件verifier均真实exit0；已上传证据包再次下载17,026,807字节、215文件（含manifest）逐字节一致。

产品包SHA256 `f7006e6c22655d35576bbb800870bda792cfb0df4834fc9405dd55f30e9a278b`。最终证据tar SHA256 `033cb382e3b226f46d460f5672f6644031340ce445797e1833bf3383e7aee0d4`。历史失败候选先按API digest/size核对备份到最终证据包，再清理本任务私有draft中的旧候选资产；历史RED继续交付。

所有原件的长度和SHA256见 `manifest.json`。证据范围、完整CI10/安装4/原生Windows1成功及实际工具闭环见 [最终验收](../../gen1-final-acceptance.md)。付费模型调用为0，真实模型质量保持NOT_PROVEN；不宣称已与参考agent模型效果相同。
