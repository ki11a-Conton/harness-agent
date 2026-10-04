# 默认指令与记忆检索验收探针

依据实际源码审查制定的实施前规格：`plan(20261004-065049).md`。探针只用真实生产类和明确 scripted provider，paid=0，不测真实模型质量或promotion。

`context-probe.mjs`、`memory-probe.mjs` 从原始只读审查探针保留固定 fixture，增加独立 repo/output 参数，候选输出到新目录，禁止覆盖基线。原始探针与观测位于 `docs/evidence/agent-context-memory-20261004/raw/audit-*`，原件SHA由索引固定。应用层读回字节不是磁盘IO量；存储 search 无limit，TopK在retrieval层，10k探针如实记录补集扫描成本。

冻结候选提交并保证工作区 clean 后运行：

```bash
corepack pnpm build
node scripts/research/agent-context-memory-20261004/context-probe.mjs "$PWD" .ci/agent-context-memory-20261004/candidate-context
node scripts/research/agent-context-memory-20261004/memory-probe.mjs "$PWD" .ci/agent-context-memory-20261004/candidate-memory
python3 scripts/research/agent-context-memory-20261004/frozen-acceptance.py "$PWD" "$(git rev-parse HEAD)" .ci/agent-context-memory-20261004/frozen
```

最终 runner 依次执行 typecheck、build、三份生产探针、联合浏览器、security、docs、具名全仓 pnpm test、该run strict usage-audit、两个证据包完整性和diff-check，每步保存 argv、退出码、原日志SHA和执行前后clean检查。具名run只用于全仓与其后usage-audit，后续定向vitest不能覆盖其观测文件。Linux subreaper将测试子进程孤儿重新收养并wait，不将僵尸数量当作产品行为结论；Windows联合结果由仓库原有CI另行记录。

完整性核验：

```bash
node scripts/research/agent-trust-20261004/verify-artifacts.mjs docs/evidence/agent-context-memory-20261004/artifact-index.json
node scripts/research/agent-trust-20261004/verify-artifacts.mjs docs/evidence/web-dsh-20261004/artifact-index.json
```

验收报告区分静态UI原始受控基线、冻结UI浏览器候选、agent源代码基线、冻结联合候选及最终证据提交。历史失败记录不改写，付费模型、实验策略promotion均NOT_RUN。
