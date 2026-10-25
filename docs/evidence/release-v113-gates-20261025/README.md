# v1.13 首个候选的 Windows 门禁失败

源代码 `50a294be2e50825d3f64c1a00b7f9d5c2bbf3aac` 在本地全量10,271/0/16及完整安装Web/CLI通过，但远端 [综合CI](https://github.com/ki11a-Conton/harness-agent/actions/runs/40211388645) 和 [同包UI](https://github.com/ki11a-Conton/harness-agent/actions/runs/40211388658) 失败；第一代安装与原生Windows专项成功。四项均为attempt1且自然终态；没有创建发布草稿、重跑或取消这些工作流。

## 静默命令夹具的预算

原始Windows完整日志确认 quiet-long-command 用例第6次工具调用附近触发 `maxDurationMs (10000ms) exceeded after 11272ms`。生产 Runtime 正确执行原时间限制。夹具为等待四次观测而额外消耗四个一秒poll，混入实际Windows持久化/调度耗时后不足以完成。

修正只改该测试协调：先在原turn截止时间内确认真实子进程的HTTP请求已到达，再收集四次非阻塞观测，之后恢复有界等待实际退出。仍为10秒turn、8秒job、15次工具预算；四次观测期间子进程必须实际保持连接，原TaskVerifier必须通过，命令只启动一次。生产工具、权限、沙箱、deadline及验证器未改。

独立双臂控制在同一生产源码上给每次脚本provider调用加入相同1000ms耗时。两臂同样先确认真实连接、同命令和相同预算：原方法10,178ms、time_limit；新方法8,220ms、verified_complete，四次连接观测均为true，启动1次。注册与结果指纹见本目录JSON；原始事件和请求在工作树外保留。它证明夹具窗口问题，不代表真实模型质量或Runtime性能收益。

原日志由只读 [取证工作流40214857271](https://github.com/ki11a-Conton/harness-agent/actions/runs/40214857271) 从原test-report artifact提取，未重跑测试、修改原失败或放宽预算。

## Goal/Plan 浏览器输入准备

原失败前15次commands/execute调用均成功结束，没有未完成RPC；下一次typed /plan没有发出新请求，所以不能将30秒回执超时归因为后端挂起。原Windows的确切前端/输入法状态没有被记录，仍为NOT_PROVEN。本地同包CPU6倍慢速探针24次交接没有重现该历史状态。

独立控制直接执行实际分发的原生键盘处理器：compositionend后的DOM组合标记已清，组件仍有10ms的Enter保护期；立即Enter被正常消费且不提交，经过渲染帧后一个Enter提交一次。原验收脚本只判断文本/标记，不能据此承诺下一键必产生RPC。只补验收准备：清空后等待原生plain阶段、文本和组合状态提交，再等待两次真实浏览器绘制；输入新命令也确认同样交接。保留原24项业务断言、一次真实按键、30秒RPC门槛、无错误门禁及实际权限/Goal/Plan行为；不增加RPC重试、不修改应用资产。失败时另保存编辑器状态以便以后直接区分。

[取证工作流40212512134](https://github.com/ki11a-Conton/harness-agent/actions/runs/40212512134) 成功读取原composer归档。截图导致26个包只暴露10个注释包；从连续gzip前缀中解析到四个完整文本JSON投影，包括原RPC、失败文本、日志和host stderr。未取得完整截图及gzip尾校验，不能宣称完整原归档下载。原归档、部分包及投影均保留，没有改判。新准备条件的同一旧归档独立控制24项通过，新的源码仍须全部正式门禁成功才能发布。
