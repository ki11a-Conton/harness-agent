# 工作区真实 capture 等待边界

ff86ace7 候选的 Ubuntu 主 CI、两类跨平台实际安装、原生 Windows 及本地下载包复验通过；本地完整9974PASS/16SKIP。但 Windows 主 CI 的 BOM 格式变更用例在测试自有的500次/5ms轮询后报 Actual Harness turn did not settle。主 CI 不全绿，候选禁止发布，不重跑。

已用真实 ScriptedModelProvider 将首次返回延迟3500ms：保留原轮询时1FAIL，等待实际持久完成及 deliverables.observe 完成时22项相邻测试全部PASS。原始 CI 的具体耗时未从受限日志端点取得，不猜测额外产品故障；反例直接证明原等待假设不成立。

修复仅涉及工作区集成测试：原有两个格式案例名称保持，文件真实字节、公开 diff、旧捕获不可污染、发布即可查断言保持；增加真实 turn 必须 completed。新增延迟案例列入原生 Windows 必跑，20增加为21。测试仍受同一个 Vitest 有限超时约束，不改变产品运行超时，不重试业务，不伪造完成或文件。

同时保留旧本地完整测试137/OOM原件、8GiB cgroup计数和同SHA完整范围--maxWorkers=2成功记录。最终新SHA从一开始限制并发，所有必需四类CI、完整/安全/类型、同字节Windows/Ubuntu实际包及本地下载包仍须重新全部通过。

旧手机 UNKNOWN_CLICK_DELIVERY_NOT_REPRODUCED 观察及全部之前失败仍保留。本等待边界修复不宣称解决未知手机现象。
