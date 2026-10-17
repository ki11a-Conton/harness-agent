# 剩余 PR 审查原件

固定 PR head、文件清单、全部原检查记录和独立反例见本目录；source/API 文件的
合成凭据补丁没有重复入库，files.json 明确是带原始摘要的无 patch 投影。
原公开 Git commit 保留完整实现。所有 copied 日志按原字节保留，gzip mtime=0。

安全合入基底 499bc4e9 clean 全仓 9874 PASS / 15 既有 SKIP / 0 FAIL；
安全 2146、类型和文档门禁通过。ui-main-3b3f4e9f/ 是之前 UI 修正 main 的
精确四工作流/十项主 CI 全通过复核，不能替代随后最终合并提交的独立 CI。

PR #11：targeted 102 PASS / 2 独立反例 FAIL。PR #13：targeted 187 PASS /
6 FAIL（4 个 PR 原测试、2 个独立反例）；实际稳定别名 owner 另有 1 FAIL，
无别名对照 1 PASS。-t 选择命令的其他用例显示 skipped，只代表未被这次选择，
不能算该套件全部通过。所有失败阻塞合并，保留候选本地 worktree，不进入 main。
合成 JWT 与运行时生成的私钥仅为无外部权限的测试值；没有真实凭据、付费调用、连接器、子 agent 或 release。

最终精确 main 的 CI 报告留在工作区外及 GitHub Checks，避免归档改变已验收 SHA。
