# Harness Agent Web 品牌

产品页面统一采用 Harness Agent 和独立 H 图标。首次欢迎、空会话、侧栏、浏览器标题、PWA/收藏夹图标、组件显示名称、设置/插件/文档预览文案及账号欢迎插画均使用本项目品牌；旧客户端也纳入浏览器扫描。真实模型供应商和技术模块 ID 不冒用其他身份。

原始开源组件、版权、许可证和来源材料保留在原件归档中。六个明确标记的本地展示衍生组件、两个独立 SVG 经 `scripts/research/web-branding.mjs` 确定性生成。离线 verifier 对 334 个原始发布文件与原始 npm tar 逐字节比较，再独立重算衍生件；不能用 seal 批准任意修改的 JavaScript。boot 版本标识实际交付字节，旧版本请求被拒绝。不是 CSS 隐藏、DOM 扫描改字或聊天内容过滤。

验收记录：Web typecheck、22 文件/186 测试、安全静态路由，资源/传输 20 测试，独立包路径 3 测试通过。生产浏览器中英文、桌面/移动/窄高三视口已实测欢迎、品牌 slot、设置深浅主题、模型页、内置组件搜索、插件页、重载和旧客户端。首次测试脚本误把管理页当成内置组件列表，随后未展开折叠分组；两次失败保留，不计作产品通过。

固定源码：`bda6b2082c721896247705e786d6a5f33a17508a`，源码 tree：`a05e5cff6f9462dd3ed8ddc7adf4ab871a4d83e1`。独立包 3,043 文件，SHA256：`34d324f7b9276aaed52f597a896827fcf296adb20974b13160a504be55374147`。同一包中英文、桌面/移动/窄高 6 场景/90 品牌断言，以及普通 coding 30 场景/75 断言全部通过；包括会话、设置、模型编辑、读取、批准/拒绝写入、问答恢复和实际流式 Markdown。原 Chromium 路径缺失失败保留，指定已安装浏览器后通过；无产品修补。启动阶段的只读 SVG 观察未捕获上游鲸鱼/字标帧。付费模型调用 0。

原始数据、失败记录、文件哈希及截图在 [验收目录](evidence/web-branding-20261013/receipt.json)，其中 [英文桌面截图](evidence/web-branding-20261013/screenshots/en-desktop-empty-conversation.png)与[中文移动截图](evidence/web-branding-20261013/screenshots/zh-mobile-empty-conversation.png)可直接检查。实际 docs gate 的 `gitSha` 为 bda6b20，`cleanBefore/cleanAfter/passed` 均为 true。归档提交仅更新文档，产品源码与该固定源码相同。

更新后重启 Web 服务并刷新页面以加载新资源版本。历史 UI/Windows/模型质量结论仍绑定其原源码，本次品牌修改不替代完整功能或付费模型验收，也不创建新的生产 release。
