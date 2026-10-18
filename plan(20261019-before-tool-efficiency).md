# Harness Agent 当前执行计划入口

当前任务：第一代 v1.11.0 更新与 Web 交互复验。详细规格：[plan(20261018-184000).md](plan(20261018-184000).md)。

用户授权：拉取最新 main，重新测试 Web 各种按键交互，修复实际问题；通过后以最新源码更新第一代 release。执行合同：[RELEASE-REFRESH-20261018](tasks/RELEASE-REFRESH-20261018.md)。此前 PR 修复计划保留在 [历史入口](plan(20261018-before-release-refresh).md)。

## 做什么

1. 以最新 main 为基线，在独立工作区构建，复验日常 Web 按钮和真实 coding 闭环。
2. 准备 v1.11.0 的固定源码安装包；保留 v1.10.0 等历史版本及 tag。
3. 通过同源码工程门及同字节 Ubuntu/Windows 安装验收后，发布新版本并校验公开下载。

## 怎么做

- 实际 Chromium 操作工作区/文件、模型/设置、发送/停止/队列、审批/问答、会话/分支/归档、反馈/附件、快捷键/语言、Chat/Trajectory 和连接恢复，覆盖桌面、390px 和 320px。
- 采用生产 HTTP/WebSocket、Runtime、工具和 JSONL，脚本模型只运行在 loopback；不拦截或伪造后端响应，不调用付费模型。
- 发布工作流和受限 draft exporter 的版本一起更新到 1.11.0；原校验、必跑用例、权限和源码/资产哈希契约不放宽。
- 无新产品缺陷时，不修改产品行为。若有缺陷，先保留失败与独立反例，再做最小修复及相邻回归。
- 等原 main 四工作流结束后正常快进推送；新 main 的四工作流独立验证，仅未被路径触发的流程在新 SHA 首次 dispatch。
- 创建绑定精确 SHA 的新 draft，只导出已验收的同一包；本地再次运行实际下载包，然后发布并检查无认证下载。

## 怎么验收

- 浏览器日常交互 42 场景/117 检查和基础 coding UI 30 场景，以及中英文真实断线恢复全部通过；失败保留，不把未实现能力算作通过。
- 类型、相关发布回归、安全及同一 clean SHA 的完整 suite 成功；主 CI 十项和原生 Windows、两类安装流程全部成功，核对 SHA、分支和 attempt。
- 最终发布 tar.gz 在 Ubuntu/Windows 上经过 Web/CLI 验收，所有收据的 sourceSha/sourceTree/version/archiveSha256 完全一致。
- 正式 release 与 tag 指向已验证源码；公开资产大小、SHA-256 与已验证字节一致；旧 release 不改写。完整证据附 release，付费模型质量仍单独报告。


## 发布前追加：可用临时目录与产品锁契约

做什么：修复首个发布候选60bc1a5f本地完整suite的测试准备错误。该候选的Web/CLI真实跨平台与下载包复验成功，但本地完整suite仍有1失败，保留原件，不作为完整工程通过。

怎么做：用真实lease占据临时目录固定端口，确定性复现原owner在开始业务断言前被正确拒绝。测试最多选择16个新临时目录，仅重试明确busy的初始准备，原进程退出后才进入下一个候选；API准备保留已取得的lease。产品不切换随机端口，也不改变固定端口/拒绝契约。竞争、保护持久数据、SIGKILL和同目录接管仍使用同一已选目录且不重试。非busy失败和耗尽必须明确失败。

怎么验收：原红对照保留；新增busy初候选/非busy传播/16次耗尽三项通过；原断言保持。Windows专项加入该文件和3个必跑名，与旧14项合计17个必跑。原候选四工作流全部结束后才能推送新main；新源码重新通过clean完整、安全、类型、全部CI和同字节UI/CLI安装验收，才发布。旧private draft改为带源码后缀的未发布候选以保留全部原证据；历史正式版本不改写。原件见[验收归档](docs/evidence/release-v111-lease-fixture-20261018/README.md)。


## Windows审批锁与发送事件验收追加

做什么：修复9c9d39fa主CI Windows的claim exclusive-open rawEPERM。该候选其他三工作流及本地全量成功仍不替代主CI失败；原件保留，不重跑/取消。

怎么做：先在原生产源码用真实FS seam确定性得到4FAIL/3PASS；claim anchor采用同文件预算锁已有的EEXIST/EPERM分类，保持既有期限、所有权和拒绝语义。补持续EPERM、活owner不被夺、非相关错误立即传播及真实writer/name-gap回归。仅额外增强日常驱动的原生click与唯一prompt断言，不给尚未复现的手机现象添加猜测UI补丁。

怎么验收：77项邻接与新7项claim场景通过，20项原生Windows必跑（旧17+3）。原手机发送失败保持UNKNOWN_CLICK_DELIVERY，零延迟/350ms只读探针10场景及增强普通三尺寸42/117通过；最终新安装包若再现则停止发布。旧9c9所有工作流结束后，正常快进新main；新源码全部四工作流、主CI十项、clean完整、安全、实际包Ubuntu/Windows与本地下载复验通过才正式发布。原件见[归档](docs/evidence/release-v111-claim-lock-20261018/README.md)。


## 变异验收锚点消歧追加

做什么：修复 daa619ed 新增 claim EPERM 分类后，S7 账本变异单行锚点出现两次的验收耦合。主 CI 失败保留，不发布该候选。

怎么做：仅限定 scripts/e4/r97-mutation-check.mjs 的账本独有上下文，仍施加完全相同的语义变异；不改生产代码或放宽反作弊门。

怎么验收：86 项锚点/保护测试通过；clean 新源码实际 S7 注入必须 KILLED 并完整还原。旧四工作流全部终结后才推送新 main；新 SHA 首次运行四工作流，主 CI 十项、原生 Windows20项必跑、完整/安全/类型及同字节跨平台和本地下载包 Web/CLI 全通过才能发布。旧失败 draft 保留，原手机观察仍未确定根因。证据见 [归档](docs/evidence/release-v111-mutation-scope-20261018/README.md)。


## 工作区 capture 验收等待追加

做什么：修复 ff86ace7 Windows 主 CI 中格式变更用例自有500次/5ms轮询误判，保留原失败，不重跑候选。

怎么做：真实模型首次返回延迟3500ms，原实现确定性FAIL；改为等待已存在的持久完成/capture事件，保留文件字节、diff和即时可见断言，并增加必须成功完成。仅测试层更改，不改变产品时限或重试业务。

怎么验收：22项相邻回归通过；新延迟案例纳入Windows必跑，合计21项。前候选四工作流终结后快进新main，新SHA重新完整、安全、四类CI、同包跨平台与本地实际下载交互全通过才发布。本地直接--maxWorkers=2避免8GiB环境OOM，测试选择范围不变。详见 [原件及反例](docs/evidence/release-v111-capture-wait-20261018/README.md)。
