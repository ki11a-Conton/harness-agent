# 精确编辑失败后如何定位重读范围

Aider 在 SEARCH 块失配后用相似行提示下一步。Gemini CLI 的编辑工具提示先重读相关行，再根据当前文件给出精确的旧文本。Harness 将这两种做法用于精确编辑失败后的定位。当差异仅为行首空格或制表符、且整段只有一个候选位置时，错误消息给出 `read_file` 的 `offset`、`limit` 和 `versioned=true`。单次替换和批量替换共用这一逻辑。[Aider 的失败诊断](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_coder.py#L92) · [Gemini CLI 的重读提示](https://github.com/google-gemini/gemini-cli/blob/08e9a20f749aefcbda38622ac757899c3d6216e0/packages/core/src/tools/edit.ts#L568)

例如，模型提交八个空格缩进的两行代码，文件中的对应代码分别以制表符和两个空格开头。首次编辑失败，文件保持原样。工具给出这两行的位置后，模型可以重读原文、核对内容，将读回的 SHA-256 随下一次精确编辑提交。候选重复、内部空白或标点不同，以及重读窗口超出默认字节预算时，工具保留原有失败诊断。诊断扫描限定于归一化后最多 256 Ki 个 UTF-16 码元的文件和 8192 个分行条目，锚点最多 4096 个码元、32 行。

## 配对验证

基线为 `70cdb1be`。同一离线脚本通过真实 `ToolOrchestrator` 分别运行单行、多行和批量替换，每种各用 LF 和 CRLF 文件。脚本从首次错误中提取重读参数，用返回的文件内容和版本执行重试，然后比对文件字节和回执哈希。使用 `node scripts/research/edit-anchor-recovery.mjs <待测版本的 packages/tools/dist/index.js>` 复测。[配对脚本](../../scripts/research/edit-anchor-recovery.mjs)

| 观测项 | 基线 | 本次实现 |
| --- | ---: | ---: |
| 首次失配后文件字节保持原样 | 6/6 | 6/6 |
| 首次错误直接给出正确重读范围 | 0/6 | 6/6 |
| 重复候选、内容不同等对照样本得到错误的位置提示 | 0/6 | 0/6 |

本次实现的六个正例均在重读后完成了带版本校验的精确编辑。另有一项真实 Harness 回合测试，脚本模型从面向模型的工具结果读取行号，完成重读和重试，再由独立 Node 命令验证修改并得到 `verified_complete`。这些结果衡量工具反馈和恢复链路，真实模型的任务成功率仍需单独测量。[工具回归](../../packages/tools/src/edit.test.ts) · [Harness 回合回归](../../packages/harness/src/edit-receipts.integration.test.ts)
