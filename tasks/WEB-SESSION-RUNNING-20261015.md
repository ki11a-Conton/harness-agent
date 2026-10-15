# Web 会话结束状态协议修复

用户要求定位 main 847e2452 的 Windows installed UI session-lifecycle/narrow-tall 失败根因。本次已用精确客户端 bundle 确定性复现：列表加载 running=true 的已打开会话收到 added(false) 后仍为 true，status(false) 才真正更新驻留实例。修复限定宿主 events 层，不改 Core/Runtime 或不可变 upstream bundle；补齐真实 composition → events → 实际客户端状态的回归，并记录修复前失败/修复后通过。验证类型、unit/integration/security，以及同源 Web 安装与真实 Windows CI，保留原失败证据。正常 Git 交付，不强推、不使用 GitHub 连接器或子 agent，不发布 release。
