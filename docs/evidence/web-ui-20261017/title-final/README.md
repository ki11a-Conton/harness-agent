# 包含 U12 的完整最终本地验收

产品 clean 完整 suite：4e651587911523b1d67b8e3383be1d76faee755d，
9874 PASS /15 既有 SKIP /0 FAIL，测试前后 HEAD 和干净状态不变。

实际安装包及验收脚本：e4a95db6a2cb8551141a4e0d727300394ff9eec2，
该提交与 suite 产品的 apps/packages 没有差异；后续只修正测试确认条件和
归档文档。构建、完整安装验收前后均干净且 HEAD 不变。Chromium 140，
原 UI 30 场景/75 具名检查、daily 42/117、连接恢复 2/10 全部 PASS，
工作区外运行，3125 文件且 0 workspace links；安装前/运行中重复校验载荷。

完整 result/log、实际 launch/编译指纹和选定用例原件由 copy-map.json 绑定；
archive-SHA256SUMS 绑定新构建；完整 suite 原日志 gzip 解压后摘要见 full.json。
先前 7026 的完整安装失败在 ../locale-followup/，不得覆盖或冒充通过。

原 main 61ef8e20 四工作流已完整结束，../original-61/ 保留 NOT_GREEN：
主 CI 10/10、原生 Windows、普通安装成功，Ubuntu UI 语言旧探测失败。
最终归档 main 的 CI 必须另按其精确 SHA 和首次 attempt 核对；本地通过不能
替代 Windows 运行或证明付费模型质量。未发布 release。
