# 全面审查 R2：确认的缺陷与修复

基线：`9f111af91cffcb567fe0030baa62d74e5c324186`。独立 worktree；保留原 workspace 的未提交变更和所有旧验收记录。本轮没有改 Core Runtime、默认权限、模型策略、依赖或 UI 品牌。

| 确认缺陷 | 处理 | 真实验收 |
| --- | --- | --- |
| write_file 路径 stat 非 ENOENT 故障后按新文件放行，可能截断大文件 | 用实际打开的描述符 stat，在 truncate 之前执行安全检查 | 注入路径 stat EIO，实际大文件字节保留 |
| 路径首次不存在，竞争创建后重新打开时未重新评估覆盖风险 | 所有既有文件都经过同一描述符检查 | 在实际打开/独占创建之间竞争创建大文件，拒绝覆盖 |
| write_file 和 UTF8 事务接受孤立 UTF16 surrogate，Node 将其静默替换为 U+FFFD | 在目录创建/事务暂存/文件写入之前拒绝不可无损编码的字符串 | 覆盖、追加、嵌套创建、两种 UTF8 编码拒绝；中文、完整 emoji、显式 U+FFFD、latin1 正常 |
| Web 小页面预览先 split 全文件，额外创建数百万数组项 | 保留完整受限快照/凭据检查，按行扫描目标页面并限制输出 | 1600 万短行的实际生产编译模块：原版在 byteLength 边界观测 heapUsed 134670432 字节，修复版不超 64MiB |
| Web 原生短读时每个片段留存一个 64KiB 缓冲 | 循环填满同一个块再保留 | 真 fd 每次最多读 17 字节：360 字节文件原分配 1507328 字节，修复不超过 128KiB |
| mkdir 已真实创建后晚到取消却报告 cancelled | 创建完成后返回真实已提交结果 | 创建后注入取消仍 success；预先取消不创建；EEXIST 保持失败 |
| 关闭阶段 undefined 拒绝被吞、null 拒绝被后续异常覆盖 | 单独记录是否发生拒绝，继续逆序排空并保留第一拒绝值 | undefined/null/Error 身份及逆序排空 |
| MemoryStoreCloser 不返回异步 close，依赖资源先关闭 | 返回实际 Promise，由 Lifecycle 等待 | 真实 deferred close 屏障，在释放前依赖不关闭 |

## 集成、边界和排除项

- 完整 coding 回合经过 createHarness、ToolOrchestrator、权限、沙箱和 Verification：一次版本化读取，无效写入反馈后保持字节，使用同一有效版本纠正内容，执行实际 Node 检查并达到 verified_complete。脚本模型只证明工程链路，不证明付费模型能力。
- 实际 Web 文件服务验证页面偏移/EOF和未请求尾部凭据拒绝。保留已有目录权限、跨 Session、路径/链接、二进制和失效编码测试。
- edit_file 已有 UTF8 原字节 round-trip 保护，本轮没有重复认领。未复现 SSE 新错误，没有凭推测修改 provider。关闭幂等性及跨进程外部编辑不作新增契约承诺。
- 受限堆仅设置启动参数的 800 万和 1600 万行原版测试均正常退出，不能据此声称崩溃。本轮以实际分配采样证明问题，未观察到 OOM/SIGABRT。
- 原始 regression-red（测试错误使用不存在的 apply 方法）、integration-green/v2（测试错误假定 success 文本标签/私有读取历史事件）保留，但不算产品缺陷。更正测试后再验收，未通过放宽产品约束使测试通过。

## 验收状态

新增回归与集成先执行；随后在干净实现 SHA 上运行类型、全量、相关安全、实际安装版 CLI/Web；最终 main 的四条 CI 单独记录。最终数字和 SHA 以 clean-acceptance.json、远端 CI 收据为准，未完成项不标通过。不发布 release、不调用付费模型，不宣称穷尽所有可能缺陷。
