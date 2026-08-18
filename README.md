# Mechanism Registry (P2-8)

每个候选机制有一个 manifest 文件（YAML），记录来源、问题、方案、风险与评估用例。

## 规范

### 必填字段

| 字段 | 说明 |
|------|------|
| id | 全局唯一标识（kebab-case） |
| source_agent | 来源 agent（codex / claude-code / hermes / opencode / pi） |
| source_report | 来源报告路径 |
| category | 类别（见枚举） |
| problem | 解决的问题 |
| preconditions | 适用前提 |
| expected_benefit | 预期收益 |
| risks | 风险 |
| implementation_scope | 影响范围（包名/模块） |
| evaluation_cases | 评估用例列表 |
| status | 状态（见枚举） |

### 状态枚举

`candidate` → `proposed` → `evaluating` → `accepted` | `rejected` → `shipped`

### 类别枚举

`prompting` / `memory` / `planning` / `tool_use` / `learning` / `scheduling` / `error_recovery` / `context_management` / `evaluation` / `other`

### 来源约定

manifest 的 `source_report` 字段引用 `research/reports/<agent>/<file>.md`。报告目录结构：

```
research/reports/
  codex/
  claude-code/
  hermes/
  opencode/
  pi/
```

## 校验

```bash
npx tsx apps/cli/src/mechanisms.ts <path>
```

或通过 CLI：

```bash
agent mechanisms validate research/mechanisms/
```

## 提交流程

1. 创建 manifest 文件（可参考 `_template.yaml`）
2. 运行 `agent mechanisms validate` 确认格式正确
3. 提交 PR