# Agent 源码对照探针

这些脚本记录 `acf8dcc394de6c6efefed52602e49014b372f372` 的行为缺口，用于复核研究和编写回归测试。它们不运行收集仓库的代码，不调用真实模型或真实 HTTP。编辑/技能探针只操作可清理的临时目录；provider/runtime 探针使用内存 SSE 和 FakeOrchestrator，工具派发不等于真实写盘。

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
node scripts/research/source-agent-review.mjs --out .ci/source-research/reproduced.json
```

总入口先核对证据中当前项目源码的 SHA-256；文档提交不影响这些指纹。源码修复后应转为常规 unit/integration/security 回归，不能继续把新实现标记为旧基线。

**退出 0 只表示观察完成。** JSON 中的 `contractChecks:false`、丢失约束、超限字节、过期技能或派发未完成调用，表示缺陷仍存在。有些脚本断言旧基线确有问题，因此也不能用它们作为候选实现的绿色验收。

| 脚本 | 观察范围 |
| --- | --- |
| source-review-codex.mjs | 对象输出与无预算分支、安全 hooks、UTF-8 字节限额和分块解码 |
| source-review-pi.mjs | provider 结束语义、实际 Runtime 派发边界、CRLF 编辑 |
| source-review-hermes.mjs | 当前 turn steering 的裁剪保留、memory prefetch 取消/期限 |
| source-review-claude.mjs | 技能正文更新/删除后的生产 provider 缓存、公开输出限额 |
| source-review-edit.mjs | 过期行号风险与跨 session 编辑丢更新 |
| source-review-verification.mjs | 现有验收失败闭环中诊断信息的缺口 |

单文件运行方式：`node scripts/research/source-review-pi.mjs`。所有相对 imports 指向当前项目构建的 `packages/*/dist`。上游测试只进行了源码阅读，其结果不包含在这些探针内。当前实测环境为 Linux；不借此声称 Windows 实机或 CI 通过。
