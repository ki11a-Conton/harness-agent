# Web 验收进程关闭修复

main `ef0cf955` 的原始 CI [38788848496](https://github.com/ki11a-Conton/harness-agent/actions/runs/38788848496)
在 Windows verify 的 source-audit beforeAll 中报临时 cwd 删除 EBUSY。
原运行保留，不重跑或取消。其他三条独立工作流成功不能代替主 CI。

原 stop 等待 `exit`，finally 发信号后立即删除 cwd，遗漏 stdio 尚未关闭的窗口；
信号退出时 exitCode 仍为 null，旧逻辑还会重复发信号。真实父/孙进程继承管道的
屏障证明：替换回原提交的 stop，目录清理已返回时 owner.closed 仍为 false；
修复后直到释放孙进程、收到 close 才清理目录。此反例证明生命周期缺陷，原始
EBUSY 注释未标识所有 Windows 句柄的具体持有者，最终效果仍须真实 Windows CI。

新 owner 在 spawn 后立即注册 close，覆盖退出/信号/重复关闭，软停超时后强停
并继续等待 close，同时释放计时器。统一收尾先收拢全部进程，再删除目录；
如进程不能关闭则保留目录；清理异常与原主错误同时保留。对新 fixture 在应用
启动前用真实固定端口租约选择可用目录，仅重分配空白临时目录，不重试业务断言，
不改产品租约或使用随机端口绕过互斥。所有原 B14/B15 断言保留。

固定源码 `242753e6db5b3de3dcf70f39ebe8746f0ff98571` 的干净工作树本地结果：

- 进程生命周期 5 项与真实 source-audit 21 项：26 通过。
- 单独真实 Web 进程、HTTP 边界和持久化重启：B14/B15 通过，JSON 绑定该 SHA。
- 原 stop 对照：1 项预期失败、4 项跳过；保留完整日志和可重放的配置。
- 类型检查、安全 2146 项、文档检查通过；付费调用 0。

原始失败、日志、结果与校验和见 [证据目录](evidence/web-process-20261015/validation.json)。
原 stop 对照可用 `pnpm exec vitest run --config docs/evidence/web-process-20261015/legacy.config.ts -t 'inherited pipes'` 重放，预期退出 1。

此提交只修研究验收进程基础设施与回归，未改产品 Runtime。完整本地套件未在该
SHA 重跑；推送后精确 main 的四条工作流、主 CI 十个任务完成前不能称全部通过。
上轮 d6 的成功与 ef 的失败分别保留。原 25 秒单次超时的根因仍未确立，不把
60 次 Windows 未复现当作修复证明。本轮不发布 release。
