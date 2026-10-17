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
