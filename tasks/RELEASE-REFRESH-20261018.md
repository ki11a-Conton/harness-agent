# 第一代 release 更新与 Web 交互复验

## 做什么

用户已授权复测最新 main 的 Web 按钮交互，修复问题后更新第一代 release。本任务取代旧 PR 任务中“本轮不发布”的任务范围限制；保留旧记录，不覆盖旧 tag。

## 怎么做

按 [plan.md](../plan.md) 执行，固定最新 main 与独立工作区。v1.11.0 使用真实 portable 构建和现有安装验收，受限 exporter 只能写绑定同 SHA 的新 draft，正式发布由最后独立核对执行。禁止 GitHub 连接器、付费调用、force push、删除失败证据或修改其他人的工作区。无需子 agent。

## 怎么验收

42/117 日常按钮、基础 coding UI、中文/英文连接恢复；同一安装包 Linux/Windows Web/CLI 通过；精确 SHA 四类 CI、主 CI 十项、完整测试及安全通过；tag、release、公开下载哈希一致。报告实际跳过与未覆盖能力，不作所有潜在 bug 或付费模型质量保证。


## 发布前追加：可用临时目录与产品锁契约

做什么：修复首个发布候选60bc1a5f本地完整suite的测试准备错误。该候选的Web/CLI真实跨平台与下载包复验成功，但本地完整suite仍有1失败，保留原件，不作为完整工程通过。

怎么做：用真实lease占据临时目录固定端口，确定性复现原owner在开始业务断言前被正确拒绝。测试最多选择16个新临时目录，仅重试明确busy的初始准备，原进程退出后才进入下一个候选；API准备保留已取得的lease。产品不切换随机端口，也不改变固定端口/拒绝契约。竞争、保护持久数据、SIGKILL和同目录接管仍使用同一已选目录且不重试。非busy失败和耗尽必须明确失败。

怎么验收：原红对照保留；新增busy初候选/非busy传播/16次耗尽三项通过；原断言保持。Windows专项加入该文件和3个必跑名，与旧14项合计17个必跑。原候选四工作流全部结束后才能推送新main；新源码重新通过clean完整、安全、类型、全部CI和同字节UI/CLI安装验收，才发布。旧private draft改为带源码后缀的未发布候选以保留全部原证据；历史正式版本不改写。原件见[验收归档](../docs/evidence/release-v111-lease-fixture-20261018/README.md)。


## Windows审批锁与发送事件验收追加

做什么：修复9c9d39fa主CI Windows的claim exclusive-open rawEPERM。该候选其他三工作流及本地全量成功仍不替代主CI失败；原件保留，不重跑/取消。

怎么做：先在原生产源码用真实FS seam确定性得到4FAIL/3PASS；claim anchor采用同文件预算锁已有的EEXIST/EPERM分类，保持既有期限、所有权和拒绝语义。补持续EPERM、活owner不被夺、非相关错误立即传播及真实writer/name-gap回归。仅额外增强日常驱动的原生click与唯一prompt断言，不给尚未复现的手机现象添加猜测UI补丁。

怎么验收：77项邻接与新7项claim场景通过，20项原生Windows必跑（旧17+3）。原手机发送失败保持UNKNOWN_CLICK_DELIVERY，零延迟/350ms只读探针10场景及增强普通三尺寸42/117通过；最终新安装包若再现则停止发布。旧9c9所有工作流结束后，正常快进新main；新源码全部四工作流、主CI十项、clean完整、安全、实际包Ubuntu/Windows与本地下载复验通过才正式发布。原件见[归档](../docs/evidence/release-v111-claim-lock-20261018/README.md)。


## 变异验收锚点消歧追加

做什么：修复 daa619ed 新增 claim EPERM 分类后，S7 账本变异单行锚点出现两次的验收耦合。主 CI 失败保留，不发布该候选。

怎么做：仅限定 scripts/e4/r97-mutation-check.mjs 的账本独有上下文，仍施加完全相同的语义变异；不改生产代码或放宽反作弊门。

怎么验收：86 项锚点/保护测试通过；clean 新源码实际 S7 注入必须 KILLED 并完整还原。旧四工作流全部终结后才推送新 main；新 SHA 首次运行四工作流，主 CI 十项、原生 Windows20项必跑、完整/安全/类型及同字节跨平台和本地下载包 Web/CLI 全通过才能发布。旧失败 draft 保留，原手机观察仍未确定根因。证据见 [归档](../docs/evidence/release-v111-mutation-scope-20261018/README.md)。
