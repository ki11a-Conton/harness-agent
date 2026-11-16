# Windows 前置验收诊断补强

首次 main `d980f8c95a6ca90eb05c3b16bf1a52aea7378c97` 的 native-windows 在 `Check the acceptance report parser` 失败，原生 120 文件/46 必需用例尚未执行，不能把前面 Linux 成绩当作 Windows 成绩。API 日志接口先返回302，附件下载403；网页步骤日志404，检查元数据只有退出码1，未能识别原始失败用例，因此未猜测修改业务代码、超时或断言。

相同原始4文件命令在本地67项通过。补充 Node test 失败报告器，与原spec报告并行消费真实测试事件，在检查回执中保留用例、文件和实际断言cause，最多6条且每条小于3500字节；原日志、进程退出码、测试断言与全部46个必需场景不变。加2个子进程用例验证真正通过/失败、Unicode和工作流转义、消息上限以及第9个失败仍留在完整输出中。

开发试跑发现子进程需去掉继承的 NODE_TEST_CONTEXT，避免 Node 把独立测试当作递归；另用实际cause优先输出，保证长消息截断前保留断言类型。两次开发失败和最终完整69项通过均归档于 `preflight-development.json.xz`，哈希见同名JSON。这两个开发问题与原Windows失败分别记录。

此补丁只增强前置诊断；原Windows失败根因仍以后续真实运行的回执为准，不将增加诊断本身宣称为修复了未知故障。最终main仍需重新检查四项CI。

干净诊断提交 `7433bfedcfd2ca2f695a50217b1288ec601b3d79` 在 Node24.19 和 Node22.23.5 上各69项通过。Windows前置组将连续执行3次，每次失败立即退出，3次全部通过才继续；不重跑workflow attempt，不改变原测试时间预算。

报告器仅发布全局 test:summary，避免 Node22 的每文件摘要重复占用检查消息预算。实际通过与失败子进程验证全局摘要各只发1条，且分别记录1项通过和9项失败；完整Node22前置组69项通过。摘要包含源码SHA、平台、Node版本、完整counts和原success。

同一轮主CI的Windows全量测试也失败，公开回执定位到 `managed-commands.integration.test.ts > default-off leaves the old tool list, prompt and blocking execution unchanged`：status为failed而非completed。为该固定离线夹具增加仅在失败时输出的有界outcome元数据，并纳入现有CI诊断脚本明确允许的前缀。未扩大超时或放宽成功条件；原始运行缺少outcome详情，不能据此宣称已独立归因。Linux主任务、Windows/Linux formal offline、闭环及两类安装验收均成功，汇总门禁仍正确为失败。

原 main 四项CI已完整结束：两类安装验收成功；主CI的Windows默认关闭模式回归和Windows专项前置组失败，双平台汇总随主测试失败。回执与诊断补丁干净源码Node22/24通过记录归档于 `ci-followup.json.xz`，未取消或手动重跑工作流。最终main的四项CI将在普通推送后重新核对。

诊断提交9c02150在真实Windows得到明确错误：原67项通过，新增2项子进程报告器自检失败，原因是把D盘绝对路径传给ESM加载器（ERR_UNSUPPORTED_ESM_URL_SCHEME），该新增问题由本轮引入。改为file URL的href，不改变断言或期望退出码；Node22/24的真实子进程通过/失败场景均通过。原失败、67/2计数与当时其他流水线仍运行的快照见reporter-url-fix.json.xz。按正常源码修复再次推送，未手动重跑或取消workflow。此明确新增路径问题与首轮未取得详情的两处Windows失败分别记录。

4c02c8f只有主CI触发：新报告器脚本未进入Windows push.paths。补充其精确glob；同时发现新的搜索浏览器/生成器/派生适配器与第三方源码未进入Web安装验收触发条件，且portable源码快照使用third_party但第一代安装验收缺少该输入触发，分别补齐。9个具体路径由旧配置均不匹配变为新配置匹配，3个YAML解析通过；见trigger-path-check.json。按普通源码提交触发最终同一SHA验收，不把无运行的检查当作通过。
