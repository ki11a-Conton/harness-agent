# Mechanism Registry (P2-8)

每个候选机制有一个 manifest 文件（YAML），记录来源、问题、方案、风险与评估用例。

## 规范

### 必填字段

| 字段 | 说明 |
|------|------|
| id | 全局唯一标识（kebab-case） |
| source_agent | 来源 agent（codex / claude-code / hermes / opencode / pi） |
| source_report | 来源报告路径 |
| provenance | 来源关系（Q-20）：original / inspired / reimplemented / derived* |
| attribution | derived 必填：明确指出复制/沿用了来源中的哪些内容与出处 |
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

### 来源声明（Q-20）

仓库含多个参考 Agent 源码。每个机制 manifest 必须用 `provenance` 声明其代码与参考来源的关系，杜绝无意识复制长代码块：

| provenance | 含义 |
|------------|------|
| `original` | 无外部参考，在本仓库从零设计 |
| `inspired` | 概念/设计受参考 agent 报告启发，实现是本仓库原创代码 |
| `reimplemented` | 基于同一公开契约独立重实现某个参考特性（clean-room），未复制其行 |
| `derived` | 从参考来源复制/沿用了非平凡代码或结构 —— **必须同时填写 `attribution` 精确说明沿用了什么、来自哪里** |

> 校验强制：`provenance: derived` 而缺 `attribution` 会被判为无效。

### 类别枚举

`prompting` / `memory` / `planning` / `tool_use` / `learning` / `scheduling` / `error_recovery` / `context_management` / `evaluation` / `security` / `other`

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