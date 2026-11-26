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

## 直接用读回的文本编辑 CRLF 文件

上表的 CRLF 重试在脚本中手工去掉了页尾的 `\r`。在 `3ef97ae7` 上将真实 `read_file` 的 `content` 原样交给 `edit_file`，三个 LF 用例成功，三个 CRLF 用例全部报锚点缺失。六次首次失败均保留了原文件。[原始脚本](https://github.com/ki11a-Conton/harness-agent/blob/3ef97ae733878dc7ee9563c76241ecca288fb55c/scripts/research/edit-anchor-recovery.mjs#L58)

OpenCode 在展示行文本时处理行尾回车，Pi 将匹配位置映射回原文件以保留未编辑的字节。Harness 现在只在下一行也能放进分页时才返回两行之间的分隔符。这样，页内混合换行按原样返回，文件末尾独立的 `\r` 仍然属于正文，版本哈希仍取自完整原始文件。[OpenCode 读取实现](https://github.com/anomalyco/opencode/blob/f3b5e9fa0ae7fac2c5516ccb3481ecc3b3d15831/packages/core/src/tool/read-filesystem.ts#L244) · [Pi 编辑实现](https://github.com/earendil-works/pi/blob/47a73ff97d9c35c4a3268c4545755ae16bee3bd8/packages/coding-agent/src/core/tools/edit-diff.ts#L21)

移除脚本中的手工处理后，相同的六次重试全部成功，单行、多行和批量编辑的落盘字节与预期一致，写入回执的 SHA-256 也与落盘文件一致。[复测脚本](../../scripts/research/edit-anchor-recovery.mjs) · [跨读取块与字节上限回归](../../packages/tools/src/read-window-early-stop.test.ts)

`grep_search` 的固定文本和正则搜索也按相同的行边界返回匹配和上下文。正则 `^$` 可以找到 CRLF 空行，搜索回车字符则会命中正文中的独立回车。原来依靠匹配 CRLF 中的回车寻找行尾的正则，应使用行尾锚点 `$`。[搜索与重读一致性回归](../../packages/tools/src/navigation-work.regressions.test.ts)
