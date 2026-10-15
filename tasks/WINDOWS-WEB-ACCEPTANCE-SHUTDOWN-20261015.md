# Web 验收子进程关闭

main ef0cf955 的 CI 38788848496 / Windows verify 116607834019 在
source-audit-fixes 的 beforeAll 运行 web-acceptance.mjs 时，删除临时 cwd 报 EBUSY。
保留原 CI，不重跑或取消。源代码中 stop 只等待 exit，finally 发 SIGKILL 后不等待，
进程的 stdio/close 尚未结束就可删除 cwd；原主错误也会被 finally 清理错误覆盖。

做什么：修复验收脚本对子进程与临时目录的生命周期所有权。怎么做：在 spawn 后
立即跟踪 close；软停超时后强停并等待；清理前收拢所有进程；保留原错误；独立
分配可用的真实目录租约作为持久化 fixture，不改变产品租约策略。仅改研究验收
基础设施及回归，不再改 Runtime。怎么验收：实际父/孙进程继承管道的屏障反例，
旧 stop 在 close 前返回、新实现等待；异常/重复停止与资源清理；真实 Web 宿主
重启/HTTP边界及21条审查验收；类型检查；提交后真实 Windows/main CI。

不使用连接器/子 agent/付费模型，不发布 release，不触碰原始脏工作区。
