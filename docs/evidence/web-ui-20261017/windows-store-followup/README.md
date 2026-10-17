# Windows 原子替换与问答续跑

原 main 0d960c2c 的 Windows canonical test gate 确认真实产品故障：
waterfall 答复的原 turn 保持 waiting_for_user，后台继续任务错误为状态文件
rename EPERM。原日志 304628 字节、SHA256
613966a9d1b5134bf82085f5c291f4e2b413ffe19cf29710f47428bc49446519，
只读诊断先核对 gate 的 source/exit/state 和 logRef 摘要后投影原错误。
诊断 workflow 0880ce71、run 39026749313，不重跑应用或原验收。

旧共享 atomicReplace 对 win32 三类锁错误最多 16 次、总退避 5.13s。
加强现有真实文件回归为连续 16 次 EPERM，原版确定性失败；并非测试等待
不足而伪造错误。采用仓库 R97 ledger 已有的 20 次尝试预算；退避合计
7.13s（不含实际 IO），保留同一源/目标、不删除旧目标、错误分类、失败和
取消语义。持锁进程没有被定位；超过新上限仍应报告真实 IO_ERROR。

相关会话/存储/checkpoint 80 项、安全 2146 项、UI/网络脚本 19 项及类型
通过；还需新的 clean 全仓、新包及真实 Windows/Ubuntu 验收。原 12d /
4ae 的通过仅证明 U13 之前的应用，不代表新产品源码验收完成。

持久化语言等待局部从 6s 改为已有 RPC 等待量级 12s，以容纳新的 7.13s
实际存储退避和双向传输；仍核对真实落盘、RPC 回执和 DOM/刷新，完整套件
总时限不变。这项预算调整有明确 SUT 契约变化，不能替代存储反例或消除
原失败。原始 0d 全部工作流已结束且 NOT_GREEN，见 ../original-0d/。
