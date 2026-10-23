# Windows 会话菜单诊断：固定 54cd 原包

## 做什么

定位正式 run39978722387 / job120500528484 的 narrow-tall 会话菜单可见性失败。历史检查只证明 reload 后第二次 actions 点击超时，不能证明生产根因。本地六组原动作对照均未复现，因此不猜改生产代码，不改 main，不将后续诊断成功覆盖原失败。

## 怎么做

仅诊断分支 `diagnostics/ui-session-actions-54cd-20261023` push 触发独立 Windows workflow。下载该正式 run 已成功 archive job 的 `deepseek-portable-54cd148eae82c2d9b9f4ab00ee7e0c2eb5ce2d5e-39978722387`，用其 SHA256SUMS、原 verifier、完整 manifest 校验版本1.12.0、源码54cd和源码树。只运行解包的生产程序，Node22 / Playwright1.55.1 / Chromium140；不重建，不调用外部或付费模型。

固定54cd原浏览器脚本和原 loopback fixture。在 runner 临时脚本副本中仅追加被动诊断；去除诊断块必须与原文件逐字节相同。按正式顺序完整执行30个 browser case / 三个 viewport，每个只执行一次。保留4000ms action timeout和10分钟整个 browser body，不跑 PR15、daily，不 force click、不重试、不加 sleep、不改 RPC、模型输出或断言。

session-lifecycle 的 reload、三次 hover 和三次点击开始/返回/失败分别留独立有限 phase 快照。每文档观察实际 row/button/sidebar/frame 几何、hover、祖先裁剪和滚动、按钮中心命中、可见 conversation owner、真实动画；每 RAF150条环加每三 RAF150条环，均有界。失败包保存原 JSON、gzip，并将 gzip 的 base64 按小于40KB的 Checks notice 分块输出，带总长度、分块号及哈希，能无损重组。全序列最多7个 packet notice及1条汇总错误/超预算说明；超预算明确 `CHECKS_PROOF_INCOMPLETE`，必须拒绝整包投影并保留完整 artifact，绝不截断冒充无损。观察异常另记，不能替换原业务异常或改变原 verdict。所有原结果、日志、fixture及诊断包始终上传 artifact。

字节等价只证明原动作/断言未被修改，不是时序等价：额外的被动快照与 evaluate 有观察开销，未复现只能作为阴性证据。固定工具以Git原字节检验，Windows checkout 明确禁用自动CRLF转换，不归一化原证据或修改包。

## 怎么验收

1. `node --check` 通过；离线自检证明插桩去除后原字节/哈希不变，模拟修改原断言被拒绝，gzip/base64分块无损且每块小于40KB。
2. 独立审查 workflow 分支/权限、固定旧包来源、版本/源码/树/完整 manifest、原动作保留、包的边界和 cleanup。提交、push 由主任务另行执行。
3. 真 Windows 运行保留30个原 case的真实 exit/verdict、环境版本和完整包证据。PASS仅表示该次诊断未复现；FAIL保留原错误及包；缺失证据不得记为生产问题已解决。
4. 验证前后生产 manifest 及全部生产 JS 摘要一致。不修改原54cd包、原失败证据、main发布门禁或历史 release。诊断分支的 generic CI 也保留，不当作 main 四组 qualification；本 workflow 永远不是 release acceptance。
