# `docs/evidence` 归档与保留策略提案（20261017）

状态：提案（proposal）· 未执行任何证据删除或历史改写。
关联：`docs/reviews/code-audit-20261017/README.md`（AST-01、AST-03、AST-06、AST-08）。

## 0. 结论摘要

- **本提案不改动任何被跟踪证据的字节**。证据是发布门禁的凭据，删除等于销毁审计线索。
- 现实问题不是「证据该不该留」，而是**它以什么形式留在 Git 里**：`docs/evidence` 占了仓库打包体积的绝大部分，且其中 91.5% 的字节没有任何代码读取。
- 建议分三阶段：
  - **阶段 0（本 PR 已部分完成）**：哈希输入钉 eol、生成物进 `.gitignore`。零风险、可立即合入。
  - **阶段 1（需审批 + 一次协调的 force-push 窗口）**：把三类纯二进制（`.png` / `.gz` / `.db`，共 67.3 MB）转入 Git LFS。
  - **阶段 2**：新增证据默认外置（CI artifact 存储），仓库只留 `manifest.json` + sha256。
- **不推荐**：直接删除历史证据目录（会破坏 122 个引用点与字节级校验链）；也不建议在阶段 1 之前做任何历史改写。

## 1. 现状实测

测量口径：`git ls-files "docs/evidence/*"` 得到的 7,410 个被跟踪文件，按工作区字节数求和（2026-10-17 本机实测）。

| 指标 | 数值 |
| --- | --- |
| 被跟踪文件 | 7,410 |
| 合计体积 | **244.4 MB** |
| 顶层子目录 | 43 |
| 仓库打包体积（`git count-objects -vH` → `size-pack`） | 278.86 MiB |

### 1.1 按扩展名

| 扩展名 | 文件 | MB |
| --- | --- | --- |
| `.json` | 4,184 | 163.2 |
| `.png` | 716 | 31.4 |
| `.gz` | 89 | 30.7 |
| `.log` | 1,183 | 6.9 |
| `.db` | 112 | 5.2 |
| `.jsonl` | 518 | 3.9 |
| `.md` | 203 | 1.1 |
| 其余（`.mjs`/`.ts`/`.py`/`.txt`/`.js`） | 405 | 1.7 |

### 1.2 体积最大的十个子目录

| 子目录 | 文件 | MB |
| --- | --- | --- |
| `agent-next-20261004` | 539 | 32.3 |
| `gen1-final-20261008` | 215 | 21.0 |
| `final-audit-20261014` | 565 | 19.6 |
| `v1.10.0` | 614 | 19.2 |
| `web-deepseek-parity-20261013` | 266 | 15.6 |
| `coding-evolution-20261015` | 439 | 15.5 |
| `agent-next7-20261006` | 57 | 13.9 |
| `agent-next2-20261005` | 816 | 11.7 |
| `web-ui-20261017` | 152 | 9.6 |
| `agent-followup-20261005` | 409 | 9.2 |

单个最大文件：`docs/evidence/agent-next7-20261006/execution/main/campaign-result.json`（7.38 MB）。

### 1.3 引用面（关键：绝大多数证据没有读取者）

- 除证据目录自身外，**122 个被跟踪文件**提到 `docs/evidence`：`docs` 25、`scripts` 27、`packages` 22、`tasks` 20、`apps` 7、`benchmarks` 3、根 `plan*.md` 14、`HANDOVER.md` 与 `.github/workflows/ci.yml` 各 1。
- 其中**真正以路径读取字节**的证据只有 **270 个文件 / 20.8 MB**，集中在四处：
  - `docs/evidence/agent-next6-20261005/`
  - `docs/evidence/agent-next7-20261006/`
  - `docs/evidence/agent-p-20261006/`
  - `docs/evidence/source-audit-fixes-20261007/`
  - 以及 `docs/evidence/` 根目录若干单文件 JSON（`e4-r85-failure-taxonomy.json`、`e4-r87-case-selection.json`、`tool-call-efficiency-case-selection.json`、`prereg-*.json/md`、`e4-r9x-phase-a-manifest.json`）。
- 其余 **7,140 个文件 / 223.7 MB 没有任何代码读取**，只被 markdown / plan 引用。

### 1.4 完整性约束（为什么不能直接删）

1. **字节级哈希链**：`docs/evidence/**/artifact-index.json` 由 `scripts/research/*/verify-artifacts.mjs` 逐字节校验；`benchmarks/coding-repositories-v1/upstream-seeded.json` 被 `upstream-tasks.py` 以 `read_bytes()` 算 `catalogSha256` 并写入 8 份证据。任何 re-encode、换行转换、格式重排都会让历史哈希对不上。
2. **测试运行时读取**：上述 270 个文件被 20 余个 `.test.ts` 直接 `readFileSync`/`new URL(…, import.meta.url)`，路径变化即测试失败。
3. **审计语义**：`docs/evidence` 是「当时到底跑了什么、得到什么」的凭据；删除等于销毁审计线索，与 `AGENTS.md` 的 Verification 精神冲突。

## 2. 三个候选方案

### 方案 A：Git LFS 迁移纯二进制（推荐作为阶段 1）

只迁移 `.png`（31.4 MB）、`.gz`（30.7 MB）、`.db`（5.2 MB），合计 **67.3 MB / 917 个文件**；`.json`/`.jsonl`/`.log` 仍是纯文本、diff 有意义，保留在常规对象库。

- 做法：
  1. `.gitattributes` 追加 `docs/evidence/**/*.png filter=lfs diff=lfs merge=lfs -text`（`.gz`、`.db` 同理）。
  2. 一次性历史迁移：`git lfs migrate import --include="docs/evidence/**/*.png,docs/evidence/**/*.gz,docs/evidence/**/*.db" --everything`。
  3. 迁移后**所有历史提交 hash 改变**，需协调一次 force-push（main + 所有活动分支），并要求所有克隆重新 fetch。
- 收益：仓库打包体积可降到与「纯文本证据」相当的量级；克隆时间主要取决于 20.8 MB 的运行时依赖集。
- 成本与风险：
  - 需要一次全仓库协调窗口（本项目当前有 PR #11、#12 活动，必须串行）。
  - Windows 上 LFS 指针与 `eol` 交互需要复核（AST-01 已经踩过一次换行归一化）。
  - CI 必须显式 `lfs: true`，否则证据文件在 CI 里是指针文本、哈希校验会以「文件很短」的形式失败。
  - LFS 配额：67.3 MB 内容 + 历史版本，需确认远端配额。

### 方案 B：证据外置（推荐作为阶段 2，仅覆盖新证据）

新证据不再进主仓库，产物上传到 CI artifact 存储（或 `harness-agent-evidence` 独立仓库 / release 附件），仓库内只保留：

- `docs/evidence/<round>/manifest.json`：文件清单 + 每个文件的 sha256 + 大小 + 生成命令；
- 一小段 markdown 说明该轮结论与产物获取方式。

- 收益：增量不再推高主仓库体积，且保留「可核验」性质（manifest 里的 sha256 就是核验手段）。
- 成本：证据不再 `git clone` 即有，需要网络与权限；历史 244.4 MB 仍在库内（阶段 1 才能降低）。
- 前置：需要确定 artifact 保留期（建议 ≥ 2 年或与发布版本同寿命）与访问控制。

### 方案 C：只冻结 + CI 尺寸闸门（不做迁移）

- 保持现状，新增两道闸：
  1. **体积闸门**：CI 校验 `git diff --cached --numstat` 中单个新增文件 > 2 MB 且不在 allowlist 时失败；
  2. **文本归一化闸门**：对「被哈希的输入」强制 `eol=lf`（AST-01 的修法已在本 PR 落地）。
- 收益：零迁移成本、零风险，能阻止继续恶化。
- 成本：244.4 MB 存量仍在，克隆成本不变。
- 定位：**无论走 A 还是 B，方案 C 都应立即生效**，否则一边迁移一边继续堆积。

## 3. 推荐路线

| 阶段 | 内容 | 前置 | 风险 |
| --- | --- | --- | --- |
| 0（本 PR） | `.gitattributes` 补 `benchmarks/**` eol 钉、清掉 3 条失效属性行；`.gitignore` 忽略 `__pycache__/`、`*.pyc`、`.trae-html-share-packages/` | 无 | 无 |
| 1 | 方案 C 的 CI 体积闸门脚本 + 评审纳入 CI | 需决定阈值与 allowlist | 低 |
| 2 | 方案 A：`.png/.gz/.db` 迁 LFS（一轮协调窗口） | 远端 LFS 配额、活动 PR 清空 | 中（历史改写） |
| 3 | 方案 B：新证据外置 + manifest 化 | artifact 存储与保留期策略 | 中（流程变更） |

验收口径：阶段 2 完成后 `git count-objects -vH` 的 `size-pack` 应有可复现的下降记录，并写回本文件；阶段 1 的闸门需要一条「故意提交 3 MB 文件 → CI 失败」的自测证据。

## 4. 本 PR 内已完成的仓库治理（不含 `docs/evidence`）

| 项 | 处理 |
| --- | --- |
| `.trae-html-share-packages/apps/web/public/index.html.zip`（7,225 B） | 删除；全仓零引用，且是在「编写计划文档」的提交里被夹带进来的；`.gitignore` 追加该目录 |
| `scripts/research/agent-next5-20261005/__pycache__/frozen-acceptance.cpython-312.pyc`（22,940 B） | 删除；`.gitignore` 追加 `*.pyc`、`__pycache__/` |
| `.gitattributes` 三条指向已删除 plan 文件的属性行 | 删除 |
| `benchmarks/coding-repositories-v1/**`、`benchmarks/r98-fixtures/**` | 追加 `text eol=lf`（AST-01；与 R12、R94 同一失败模式） |

以下为**本地工作区**治理，不入库（`gitignored`，故无 diff 可审）：

| 项 | 处理 | 效果 |
| --- | --- | --- |
| `harness-agent-src/`（7,142 文件 / 99.6 MB，head 的陈旧分叉副本） | 移出到工作区外归档目录 | 工作区不再有第二份源码，避免误读误改 |
| `.ci/n7`（11,470 文件 / 509.3 MB）、`.ci/n6-n5`（665 文件 / 117 MB） | 移到同一归档目录 | `.ci` 从 645.3 MB 降到 19.2 MB（2,347 文件），释放 626.3 MB |

## 5. 待决策

1. 是否批准阶段 2 的历史改写（需要一次协调窗口；建议在 PR #11、#12 合并之后）。
2. 阶段 1 的体积阈值取 2 MB 还是 1 MB；allowlist 是否沿用第 1.3 节的 270 文件清单。
3. 阶段 3 的 artifact 保留期与访问控制归属。
