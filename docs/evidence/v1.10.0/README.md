# v1.10.0 工程验收原件

固定产品源码：`b65801e49a6991853867106c77d968d7dec2c074`。最终公开状态以仓库当前发布报告为准，旧失败、私有候选收据及采集时间不改写。

发布包：`harness-agent-1.10.0-portable.tar.gz`；SHA-256：`6b27c4643ffd6416cc9960033774657be7e79ac56e64fbf928e80488979928b9`。

`exact-distribution/SOURCE-ACCEPTANCE.json` 保留同一源码、同一 tar 的 Ubuntu/Windows Web/CLI 四份原始收据及成功的工作流/子 job。该文件的 ACCEPTED_NOT_PUBLISHED 是收据生成时状态，不把生成前已接受安装包等同为完整工程门通过。

`native-windows/` 是原公开 notice 分片恢复的全部最终 case records，校验 Node JSON.stringify 的 caseRecordsSha256；未取得原始 Vitest JSON 字节。Windows 393 PASS / 2 SKIP / 33 文件，两个 SKIP 是 POSIX chmod 语义。

`logs/` 和 `ci/` 保留早期失败、取消、各实际源码的本地记录与原生 API 结果。`exact-distribution/original-windows-full-failure.json` 是原完整 CI artifact 中的失败行投影，并记录原日志 bytes/digest；不声称投影等于整份原日志。首次 Windows EPERM 原子替换拒绝保持原等待状态，后续复验单独记录。

240 个较长路径的实际 fixture 文件逐字节保存在 fixture-records.tar.gz 中。index 记录每个原相对路径、长度及 digest，避免 Git Windows checkout 路径超限。验证不会向磁盘解出这些成员。

运行 `python verify.py` 校验 inventory 和 tar 中的全部字节。`** -text` 禁止 core.autocrlf 改写这些原件；不会改变历史 N7 或其他 evidence。

installed-question-acceptance.mjs 只执行本地 HTTP fixture，可对校验后解出的安装包复算 EOF 问答恢复、原工具/改动摘要保留及碎片化敏感输出脱敏。付费模型质量仍为 NOT_PROVEN。

最终发布：v1.10.0 已正式公开，注解 tag 指向固定产品源码。publication/ 保留公开状态及 4 项无需登录下载的字节/摘要复核。ci/cohort3/ 保留主 CI 38534860525 attempt-3 的 10 项全部成功记录；ci/attempt2/ 和请求记录保留局部复跑成功后同轮收据规则正确拒绝混合旧产物的失败，不改写旧 verdict。发布证明依据成功的真实 job/steps，未下载其 Azure 原始 JSON artifact。
