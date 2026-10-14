# 最终审查原件归档

产品验收源码：88504f013eec54f1ae0328783345c8c4cf8265e3。后继 8613c6e 仅修生产组装测试、补 Windows 目标列表和文档；product-source-identity.json 比较 1,320 个产品/构建输入的 Git blob，全部相同。

- source-identity.json：产品验收时的 clean 源码与环境。
- acceptance-summary.json：按实际运行记录汇总；源码 SHA 不随归档提交改写。
- logs/、reproductions/：最初失败、修复回归、终止的旧全量、最终完整全量及边界实测原件。初次测试夹具的误报也保留。
- installed/：最终源码独立包的 manifest、校验、CLI/Web/品牌和问答/脱敏实测。historical-installed-7e0295a/ 属于此前源码，不作为最终包证明。
- ci/：原生 GitHub HTTP 返回的 workflow/job/annotation 原件；Windows notice 分片恢复 case records 并验证 JSON.stringify 的 SHA-256。包含早期失败和修正后记录；pending 不能算通过。
- installed-question-acceptance.mjs：从校验后的包、全新项目/状态目录重现真实 HTTP + 三个 CLI 进程的问答恢复及输出保护。只使用本地 scripted provider。
- inventory.json：除本清单自身以外，每个归档文件的原字节大小与 SHA-256。GitHub artifact 的原始 ZIP/日志下载曾被代理 403 拒绝；没有伪造为已下载。

未归档测试包的 tar.gz；其 SHA256SUMS 与完整 PORTABLE-MANIFEST.json 可复核包内容。未发布 release/tag。合成测试凭证不可用，归档不包含用户 GitHub token；paid model calls 为 0，模型质量及完整默认 UI parity 仍为 NOT_PROVEN。
