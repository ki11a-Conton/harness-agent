# Web 日常交互原始证据

本目录保留原 b6 配对失败、设置异步关闭调用栈、阶段候选失败及通过验收。
来源为拥有的临时测试目录，文件复制时不改写原始结果。清单绑定原字节摘要；
引用的临时绝对路径是运行时身份，不要求在别的机器存在。

`red/` 是固定 b6 的六个真实浏览器失败与原验收脚本；`diagnostic/` 保存
U11 实际关闭栈和确定性组件失败；`probes/` 保存真实缺陷及探测前提错误，
解释见[审查报告](../../web-daily-interactions-20261017.md)。通过记录随后追加，
不得把候选失败改写为通过。完整 suite 必须绑定 clean 源码及前后 Git 状态。

没有付费模型调用，没有使用 GitHub 连接器，没有发布 release。

固定源码 `1a85b345d7d3b6a5016f671268a32da5c8bdcde6` 的本地验收已全部通过，见 [validation.json](validation.json)。`final/` 保存完整 suite、同包 30+42 场景、连接恢复、provider 请求、编译指纹及选定截图；gzip 中的原始内容摘要记录在 final-copy-map.json。`supplemental/` 是额外分屏发送和原生键盘焦点实测，失败的探测前提及后续观察分别保留。远端结果必须以最终 main SHA 的 GitHub Checks 和独立 CI 复核记录为准，本目录不把本地通过当作 Windows/远端 CI。

`original-e4/` 保留四个原始工作流完整结束后的 NOT_GREEN 复核，未取消、未重跑；
`d9/` 保留过期测试材料的真实失败与定向修正，`ci-followup/` 保留专用闭环
567/567、9/9 矩阵、Chromium 140 反例及同包完整复验。原 1a 的应用/完整套件
SHA 与后续测试脚本 SHA 分别记录；修正后的精确 main CI 需另行核对。

`title-final/full.*` 是包含 U12 的 clean 4e651587 完整 suite；
`locale-followup/` 保存原 61ef8e20 Ubuntu UI 失败的只读投影、本地探测反例、
持久化确认后的三视口通过与其脚本身份，不覆盖旧记录。

`title-final/README.md` 记录包含 U12 的完整新构建与同包 30/75+42/117+
连接 2/10 通过；`original-61/` 保留主 CI 十项成功但 Ubuntu UI 旧语言
探测失败的完整 NOT_GREEN 复核。最终 main CI 在归档推送后按精确 SHA 核对。
