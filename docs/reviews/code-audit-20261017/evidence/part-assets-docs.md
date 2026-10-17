# 静态资产与文档审查（part-assets-docs）

- 范围：`apps/web/public/`、`docs/`、`benchmarks/`、`research/`、`third_party/`
- 基线：HEAD `44f3f51f6ecfdc0da653a6e76a4149d032729961`
- 文件规模：**10,482 个被跟踪文件**（全仓 11,937 的 87.8%）
- 边界：只读审查，未修改/删除任何被跟踪文件，未执行 git 写操作

## 0. 结论摘要

1. 五个 scope 合计 10,482 文件、**318,039,926 B ≈ 318.0 MB（303.3 MiB）**，其中 `docs/evidence/` 一个目录就占 **243.5 MB / 7,175 文件**（= docs 的 96.1%，= 全 scope 的 76.6%）。提交历史里混入了大量本应外置的运行产物：698 个 PNG、112 个 SQLite `.db`、1,122 个 `.log`、511 个 `.jsonl`、10 个 `.tar.gz`。
2. 发现 **1 个 P1**：`benchmarks/coding-repositories-v1/upstream-seeded.json` 被 `upstream-tasks.py` 以**原始字节**计算 `catalogSha256` 并写入 8 份已提交证据，但该路径**没有** `.gitattributes` 的 `eol=lf` 钉；本机 Windows 检出已把它改写成 CRLF（5,609 B vs blob 5,471 B），实测哈希 `d5498cc8…` ≠ 证据记录的 `db483652…`。仓库此前已为完全相同的失败模式修过两次（R12、R94），这一处是漏网。
3. 发现 **1 个 C 类死资源**：`apps/web/public/deepseek/index.html` 全仓零引用（`apps/`、`packages/`、`scripts/`、`benchmarks/`、`.github/` 及 `docs/*.md` 全部 0 命中），但仍可通过 `serveVendor` 以 `/deepseek/index.html` 访问到 —— 是第二套入口的遗留物。
4. 大量"看似冗余实则不能动"的资产已按 B 类归档并写明理由：`tarballs/*.tgz`（67 个 13.7 MB）是供应链逐字节断言输入，`harness-brand/plugins/**` 是登记在册的品牌衍生，`legacy/` 是冻结的品牌回归夹具。
5. `third_party/`（12 文件）与 `research/`（20 文件）两个 scope 结构干净、许可与溯源记录齐全，仅 `third_party/coding-benchmark/README.md`、`coding-index/README.md` 的溯源粒度弱于 `xtermjs-MIT.provenance.json`。
6. 重复内容的上界估算：`docs/evidence` 内 >50 KB 的同字节长度分组 99 组，若全部为精确副本，可回收 **32.7 MB**；已实测确认其中至少 13 处为逐字节相同。

## 1. 发现总表

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
|---|---|---|---|---|---|
| AST-01 | benchmarks/coding-repositories-v1/upstream-seeded.json:1 | 该文件被 `upstream-tasks.py:71` 以 `read_bytes()` 计算 `catalogSha256` 并写入 8 份已提交证据，但 `.gitattributes` 未对它（及同目录）加 `text eol=lf`；Windows CRLF 检出后哈希不可复现 | D | P1 | 在 `.gitattributes` 追加 `benchmarks/coding-repositories-v1/** text eol=lf`；顺带评估 `benchmarks/**/case.json`、`benchmarks/r98-fixtures/**` |
| AST-02 | docs/evidence:1 | `docs/evidence/` 243,528,292 B / 7,175 文件，占 docs 体积 96.1%、占全仓跟踪文件 60.1% | A | P2 | 归档策略见 §1 说明 · AST-02；历史 run 超过 N 轮后转 LFS 或移出仓库 |
| AST-03 | docs/evidence:1 | 698 个 `.png` 共 31,793,217 B 全部提交在 `docs/evidence/` | A | P2 | 截图类产物走 LFS 或按 run 打包为单个 `.tar.gz` 后删除散图 |
| AST-04 | docs/evidence:1 | 112 个 `.db`（SQLite）共 5,505,024 B 被提交，二进制且无法 review diff | A | P2 | 改为 dump 成 `.sql` 或只在 evidence manifest 记录 sha256 + 元数据 |
| AST-05 | docs/evidence:1 | 1,122 个 `.log` 共 6,448,295 B；其中大量为 9 B 的 `typecheck` 占位日志与 0 B 的空 `stderr.log` | A | P2 | 空/占位日志不提交；其余按 run 汇总成单个 `logs.txt` |
| AST-06 | docs/evidence:1 | **88 个零字节被跟踪文件**（如 `final-audit-20261014/logs/final-audit-typecheck-*.log`） | A | P3 | 直接移除；零信息量且污染 `git ls-files` 清单 |
| AST-07 | docs/evidence:1 | >50 KB 的同字节长度分组 **99 组**，按"全部为精确副本"上界可回收 **32,700,574 B** | A | P2 | 先做 sha256 精确去重（成本低、收益 13 MB 已确认） |
| AST-08 | docs/evidence/gen1-final-20261008/history/ci:1 | 3 个近似重复 CI bundle：4,550,434 / 4,549,272 / 4,549,271 B（后两者仅差 1 B），合计 13,648,977 B | A | P2 | 只保留 release 目录那份；另两份在 manifest 里引用即可 |
| AST-09 | docs/evidence/agent-next-20261004/raw:1 | `frozen-{de346b9,91967f4}/r2-performance/result-{jsonl,sqlite}-{structured-do,warm-fts}.json` 4 组完全同尺寸（3,406,892 ×4、2,068,221 ×4），跨 frozen commit 重复 | A | P2 | 确认后只留一份 + 记录两个 frozen commit 均适用 |
| AST-10 | docs/reviews/source-audit-20261007/evidence/n7-main-dry/dry-run.json:1 | 该文件（940,504 B）与 `docs/evidence/source-audit-fixes-20261007/evidence/final-n7-main-dry/dry-run.json`（924,153 B）同主题重复；holdout 侧同理（936,313 / 920,002），合计 3,720,972 B | A | P2 | `docs/reviews` 只留结论与 manifest，dry-run 原始产物归 `docs/evidence` 一处 |
| AST-11 | docs/evidence:1 | 5 个 results 目录内 `holdout.json` 与 `holdout-runs.sanitized.json` **逐字节相同**（74,798–76,891 B/对） | A | P2 | 删除 `.sanitized` 副本，或改为符号引用 |
| AST-12 | docs/:1 | docs 根目录 **145 个 `.md` 平铺**，无 `README.md` 索引（仅有 `docs/gen1-audit-index.md` 一个局部索引） | A | P3 | 补 `docs/README.md` 作为导航；同时给无索引的 `architecture/`、`evolution/`、`harness-engineering/` 补 README |
| AST-13 | docs/r74-evidence:1 | `docs/r72/r74/r76/r77/r78/r79/r80/r81-evidence` 共 8 个碎片目录、16 文件、27,780 B，与 `docs/evidence/<run-name>` 命名体系不一致 | A | P3 | 并入 `docs/evidence/` 对应 run，或明确为保留的短索引 |
| AST-14 | apps/web/public/deepseek/index.html:1 | 全仓**零引用**的第二套入口 HTML（1,130 B）；无任何 HTML/JS/配置指向它，但仍可经 `server.ts:267` 的 `serveVendor` 以 `/deepseek/index.html` 取到 | C | P2 | 删除，或与根 `index.html` 合并并保留单一入口（删前确认 `provenance.json` 的 `files` 清单同步更新） |
| AST-15 | apps/web/src/server.ts:366-376 | `serveVendor` 无扩展名/路径白名单，把整个 `deepseek/**`（65 MB，含 9.88 MB 的 `sources/*.tar.gz`）当文件服务器暴露，且逐次 `readFile` 全量入内存、`Cache-Control: no-cache` | D | P3 | 加扩展名白名单（`.js/.css/.json/.svg/.woff2/.txt/.tgz`）与单文件大小上限；对 `.tar.gz` 走流式或直接拒绝 |
| AST-16 | apps/web/public/deepseek/provenance.json:1 | `sourceRelationship` 字段值为 "npm gitHead is absent; the separately frozen Git source reference does not release/source equivalence."，缺谓语（疑漏 "establish"），是**已提交的错误声明文本** | B | P3 | 需与 provenance 生成脚本一起改（`scripts/research/deepseek-frontend-vendor.mjs`），单改 JSON 会被 `--check` 覆盖 |
| AST-17 | benchmarks/adversarial/adv-credential-exfil-filenames/fixture/.env:1 | 夹具内含 `API_KEY=qa_000000_placeholder_only` / `DB_URL=postgres://user:pass@db.example:5432/app` | B | P3 | 保持现状（是"凭据外泄文件名"对抗夹具的一部分）；仅需在 secret-scan 白名单登记 |

### 说明 · AST-01

**这是本 part 唯一的 P1，且有完整的实测证据链。**

1. 消费者代码 `scripts/research/coding-evolution-20261015/upstream-tasks.py`：
   - `:12` `CATALOG = json.loads((ROOT / 'benchmarks/coding-repositories-v1/upstream-seeded.json').read_text())`
   - `:30` `def sha(data):`
   - `:71` `data = {'task': task['id'], 'catalogSha256': sha((ROOT / 'benchmarks/coding-repositories-v1/upstream-seeded.json').read_bytes()), ...}`
   → **以原始字节**（`read_bytes()`）计算，任何换行改写都会改变结果。

2. 已提交证据记录了该哈希（8 处）：
   - `docs/evidence/coding-evolution-20261015/final-4ee21776/python-upstream/{hermes-routing-01-fixed,hermes-routing-01-seeded,hermes-write-metadata-02-fixed,hermes-write-metadata-02-seeded}.json:3` → `db48365207d017eee3191aaafd4ac4d611b19fcf23a27ddb419029453bd32d54`
   - `docs/evidence/coding-evolution-20261015/followup/{同名 4 个}.json:3` → `0b41285e9ddb80bb77f6743e963aef4ad80965a324a00254b8ee25179de83fb3`（该组对应更早的 catalog 内容）

3. 实测（本机，Windows，`core.autocrlf` 生效）：
   - `git ls-files --eol` → `i/lf  w/crlf  attr/`（**blob 是 LF，工作区已被改写成 CRLF，且无任何 attr**）
   - 工作区文件：5,609 B，sha256 = `d5498cc89f022c3621312fa336218e01d7b394db27b4f04db40f447cfe312554`
   - git blob：5,471 B（`git cat-file -s HEAD:...`，blob id `aea559e6c6e40f53ab677053b8b3ffcde523d416`）
   - 把工作区内容归一化为 LF 后 sha256 = `db48365207d017eee3191aaafd4ac4d611b19fcf23a27ddb419029453bd32d54`
   → **完全等于 `final-4ee21776` 记录的 catalogSha256。**

4. 因此在本机（以及任何 `autocrlf=true` 的 Windows 检出）重跑 `upstream-tasks.py record`，产出的 `catalogSha256` 会变成 `d5498cc8…`，与已提交证据 `db483652…` 不匹配；而 LF 检出（CI ubuntu）才会匹配。这是**确定性、可复现的跨平台破坏**。

5. 为什么算漏网而不算设计：`.gitattributes` 已经为**完全相同的失败模式**修过两次，注释里记录了实测后果 ——
   - `# E4-R12 (N02): stable byte contract for hash-constrained evolution evidence.` + `# MEASURED: an all-CRLF read of the ledger refs produces 11 DIGEST_MISMATCH`
   - `# E4-R94 (finding C follow-up): ... MEASURED: run 35306276313 failed on BOTH windows-latest and ubuntu-latest`
   现有规则只覆盖 `docs/evolution/*.json`、`benchmarks/results/**/*.json`、`docs/evidence/**/*.json`、`scripts/benchmark/fixtures/r84-campaign/**`、`.github/workflows/*.yml`、`apps/web/public/deepseek/**`（`-text`）。`benchmarks/coding-repositories-v1/**` 是后来（coding-evolution-20261015）新增的，没有跟进。

6. 同批高风险但**尚未发现字节哈希断言**（建议同一条规则一起覆盖）：
   - `benchmarks/coding-repositories-v1/catalog.json` → `i/lf w/crlf attr/`
   - `benchmarks/coding-repositories-v1/README.md` → `i/lf w/crlf attr/`
   - `benchmarks/r98-fixtures/**` 全部 `i/lf w/crlf attr/`（被 `packages/evaluation/src/r98-fixture-cases.test.ts:32` 引用；目前只做解析不做哈希，故未升级为 P1）
   - `benchmarks/coding-repositories-v1/catalog.json` 被 `historical-tasks.py:11`、`qualify-history.py:8` 以 `read_text()` 读取（纯 JSON 解析，不受影响）

7. 修法：在 `.gitattributes` 追加
   ```
   benchmarks/coding-repositories-v1/** text eol=lf
   benchmarks/r98-fixtures/** text eol=lf
   ```
   并在 `docs/evidence` 侧不动（其 `**/*.json text eol=lf` 已覆盖）。

### 说明 · AST-02

`git ls-files -- docs` = 7,413 文件 / 248,897,576 B。顶层分布：

| 顶层目录 | 文件 | 字节 | 结论 |
|---|---|---|---|
| `docs/evidence` | 7,175 | 243,528,292 | 见 AST-02/03/04/05，主要问题源 |
| `docs/` 根（平铺） | 151 | 2,471,689 | 145 `.md` + 6 `.json`，见 AST-12 |
| `docs/reviews` | 20 | 2,400,430 | 见 AST-10 |
| `docs/discourse` | 12 | 192,774 | 有索引，无问题 |
| `docs/research` | 8 | 103,202 | 有索引，无问题 |
| `docs/evolution` | 19 | 77,667 | 无 README，见 AST-12 |
| `docs/harness-engineering` | 4 | 72,045 | 无 README，见 AST-12 |
| `docs/architecture` | 8 | 23,697 | 无 README，见 AST-12 |
| `docs/r72-evidence` | 5 | 7,131 | 见 AST-13 |
| `docs/r79-evidence` | 3 | 6,437 | 见 AST-13 |
| `docs/r81-evidence` | 1 | 3,672 | 见 AST-13 |
| `docs/r78-evidence` | 2 | 3,110 | 见 AST-13 |
| `docs/r80-evidence` | 1 | 2,753 | 见 AST-13 |
| `docs/r76-evidence` | 2 | 2,407 | 见 AST-13 |
| `docs/r74-evidence` | 1 | 1,753 | 见 AST-13 |
| `docs/r77-evidence` | 1 | 517 | 见 AST-13 |

`docs/evidence` 有 **103 个 run 目录**。体积 Top 10（实测 `git ls-files -- docs/evidence` 按第二段分组）：

| run 目录 | 文件 | 字节 |
|---|---|---|
| agent-next-20261004 | 539 | 33,861,878 |
| gen1-final-20261008 | 215 | 21,980,889 |
| final-audit-20261014 | 565 | 20,521,144 |
| v1.10.0 | 614 | 20,092,354 |
| web-deepseek-parity-20261013 | 266 | 16,337,957 |
| coding-evolution-20261015 | 439 | 16,258,004 |
| agent-next7-20261006 | 57 | 14,606,848 |
| agent-next2-20261005 | 816 | 12,308,023 |
| agent-followup-20261005 | 409 | 9,616,218 |
| web-deepseek-parity-20261012 | 100 | 7,134,613 |

归档/清理策略建议（**不执行**，仅建议）：
1. **先做精确去重**（零风险、可验证）：对 >50 KB 分组算 sha256，删除逐字节相同的副本，改在 manifest 中记录 "同 <path>"。已实测可确认 13 处（AST-08/09/11）。
2. **再转 LFS**：`.png`(698)、`.db`(112)、`.tar.gz`(9 在 docs)、`.gz`(85 在 docs) 合计约 79 MB 最适合 LFS；`.log`/`.jsonl`/`*.json` 是文本，保留在 Git 里反而利于 diff 与 grep。
3. **按 run 冻结窗口**：超过 2 个里程碑的 run 目录整体打成一个 `.tar.gz`（`docs/evidence` 现有 9 个 tar.gz 已证明这是本项目接受的形态），保留 `manifest.json` + 结论 markdown 在树内。
4. **不要动** ≤3 个月内的 run：`docs/evolution/*.json`、`docs/evidence/**/*.json` 被 `.gitattributes` 按字节钉住，且被 `packages/evaluation/**` 的测试直接读取（如 `packages/evaluation/src/e2-baseline-audit.test.ts:244`、`artifact-validate.test.ts:272`），改动即破坏回归基线。

### 说明 · AST-14

- 引用检索（全仓、排除 vendored bundle 与 docs/evidence）：
  - `apps/`、`packages/`、`scripts/`、`benchmarks/`、`.github/` 的 `.ts/.tsx/.js/.mjs/.json/.html/.md/.yml` 中 `deepseek/index.html` → **0 命中**
  - `docs/**/*.md` 中 `deepseek/index.html` → **0 命中**
- 可达性：`apps/web/src/server.ts:267`
  `if (/^(?:deepseek|legacy)\/[A-Za-z0-9@._/-]+$/.test(asset) && !asset.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) return this.serveVendor(res, asset);`
  → `/deepseek/index.html` 能返回 200，但不是任何入口的 `href`/`src`/重定向目标。
- 与根入口的差异：根 `index.html` 引用 `/deepseek/harness-brand/favicon.svg`、`/coding-workflow.js`、`/deepseek/harness-adaptations.css`，favicon 用单一 harness-brand SVG；`deepseek/index.html` 用 light/dark 双 `<link media>` + `favicon{dark,}.svg`，且不加载 harness 适配层。→ 是 harness 品牌化**之前**的快照。
- 风险不是"打不开"，而是：① 存在两套可访问 UI，排查问题时容易误导出快照；② `provenance.json` 的 `files`（785 条）把 `index.html` 的 `rootIndexSha256` 绑定在 `publicRoot/index.html`（`scripts/research/deepseek-frontend-vendor.mjs:149` `rootIndexSha256: sha256(await readFile(path.join(publicRoot, "index.html")))`），说明"根 index 才是被钉的那个"，`deepseek/index.html` 没有对应的完整性约束。

### 说明 · AST-15

`apps/web/src/server.ts:366-376` 的 `serveVendor`：
- 无白名单：`STATIC_FILES`（:34-47）只白名单了 12 项，但 `serveVendor` 是兜底分支，只要匹配 `^(?:deepseek|legacy)/[A-Za-z0-9@._/-]+$` 就服务。
- 有符号链接防护：`:370` `if ((await lstat(current)).isSymbolicLink()) throw new Error("Static symlink rejected");` —— 这部分是好的。
- 无大小上限：`:372` `readFile` 全量入内存；`deepseek/sources/upstream-client-reference.tar.gz` = 9,877,464 B，`tarballs/` 最大 4,660,813 B。
- 缓解因素：`:231-241` `verifyRequestOrigin` 校验 Host ∈ {127.0.0.1, localhost, [::1], 绑定 host} + 绑定端口 + 拒绝 `sec-fetch-site: cross-site`，因此暴露面限于本机进程。据此定 P3 而非 P1。
- 真正的改法很便宜：扩展名白名单 + `stat().size` 上限即可，不触及路由语义。

### 说明 · AST-16

`apps/web/public/deepseek/provenance.json` 的 `sourceRelationship` 值为：

> npm gitHead is absent; the separately frozen Git source reference does not release/source equivalence.

第二个分句缺谓语（"does not **establish** release/source equivalence"）。这是**对外发布的合规声明文本**，语法残缺会让"我们到底声称了什么"变得不可判读。归 B 类是因为：该 JSON 由 `scripts/research/deepseek-frontend-vendor.mjs` 生成并被 `deepseek-frontend-vendor.test.mjs` 做 `--check` 式比对，单独手改 JSON 会被生成器覆盖或导致校验失败 —— 必须连生成脚本一起改。

### 说明 · B 类"看似冗余、实则不能动"

| 对象 | 表面现象 | 为何不能动（证据） |
|---|---|---|
| `apps/web/public/deepseek/tarballs/*.tgz`（67 个 / 13,741,043 B） | 运行时 0 引用，`apps/`、`packages/` 的 TS 中零命中 | 是供应链验证**输入**。`scripts/research/deepseek-frontend-vendor.mjs:90-93` 读 `tarballs/${stem}.tgz` 后断言 `bytes.length === release.bytes && sha256(bytes) === release.sha256 && integrity(bytes) === release.integrity && sha1(bytes) === release.shasum`；`:107-108` 再逐文件断言 `installed.equals(data)`。删掉即失去"vendored 资产未被篡改"的证明 |
| `apps/web/public/deepseek/sources/upstream-client-reference.tar.gz`（9,877,464 B，scope 内最大单文件） | 像大而无当的归档 | `provenance.json`、`provenance/source-reference.json` 引用它；5 个 `docs/evidence/**/PORTABLE-MANIFEST.json` 与 `docs/web-deepseek-frontend-licenses.md` 记录其摘要。是 `sourceRelationship` 声明里"separately frozen Git source reference"的本体 |
| `apps/web/public/deepseek/harness-brand/plugins/**`（10 个 bundle / 4,099,850 B） | 与 `plugins/**` 同名，像重复 | 每个都**不同**（SHA256 实测全 DIFF）。`server.ts:318-319` 注释：`Only the entry file has a branding derivative; lazy chunks keep the original package path and still require the graph's current revision.`；`provenance.json` 的 `publishedArtifactPolicy` 明文登记 "10 explicitly marked Harness Agent UI derivatives" |
| `apps/web/public/plugins/**/client.js`（66 个 entry + 4 个 lazy chunk / 27,203,940 B） | 27 MB minified，无法 review | minified 发布产物，由 `boot-manifest.json` 66 条目逐一登记，`server.ts:314` 按 `entry.rev`（12 位 sha 前缀）校验后才返回；逐字节来源可回溯到 tarballs |
| `apps/web/public/legacy/{app.js,style.css}` | 与根同名文件**逐字节相同**（32,929 B / 15,658 B，合计 48,587 B） | 是**刻意冻结**的品牌回归夹具：`scripts/research/web-branding-browser.mjs:115` `page.goto(origin + '/legacy/index.html')` + `:116 scan('legacy')`。若改为引用根 `/app.js`，回归测试就会跟着活代码漂移，失去"旧品牌快照"的对照意义 |
| `benchmarks/results/`（60 文件 / 1,637,867 B） | 是历史跑分产物，"应该外置" | 被当作**契约基线**直接引用：`apps/cli/src/e2-command.ts:20-21` 导出 `E2_BASELINE_ARTIFACT`/`E2_CANDIDATE_ARTIFACT` 两个常量指向其中的 `*-holdout.json`；`apps/cli/src/cli.test.ts:763-764`、`e3-repro-current-defects.test.ts:534-535` 依赖；`docs/evolution/evolution-ledger.json` 等 20+ 处引用 |
| `benchmarks/coding-repositories-v1/`（3 文件 / 72,881 B） | 自身目录外 code 零引用，像孤儿 | `scripts/research/coding-evolution-20261015/upstream-tasks.py:12` 直接 `json.loads(... 'benchmarks/coding-repositories-v1/upstream-seeded.json')`；`historical-tasks.py:11`、`qualify-history.py:8` 读 `catalog.json` |
| `benchmarks/baseline-e4-r74/`（34 文件 / 6,591 B） | 名字像过期基线 | `packages/evaluation/src/e4-r77-baseline-oracle.test.ts:33` `const FROZEN_DIR = resolve(process.cwd(), "benchmarks", "baseline-e4-r74");`；`r97-offline-seam.test.ts:358,365`；`.github/workflows/ci.yml:1424` `--cases benchmarks/baseline-e4-r74` |
| `benchmarks/stress/stress-many-small-files`（1,003 文件） | 1000 个 `fixture/files/f%04d.txt` | 刻意的"多小文件"压力夹具，属于用例输入 |
| `benchmarks/stress/stress-very-long-json/fixture/data/big.json`（830,508 B） | 唯一 >500 KB 的 benchmark 文件 | 刻意的超长输入夹具 |

## 2. 分模块明细

### 2.1 `apps/web/public/`（801 文件 / 65,249,966 B）

| 分组 | 文件 | 字节 | 结论 |
|---|---|---|---|
| `deepseek/plugins/` | 70 | 27,203,940 | 见 B 类表；入口 66 + lazy chunk 4，与 `boot-manifest.json` 一一对应 |
| `deepseek/tarballs/` | 67 | 13,741,043 | 见 B 类表（供应链断言输入） |
| `deepseek/sources/` | 1 | 9,877,464 | 见 B 类表（冻结源引用） |
| `deepseek/assets/` | 126 | 5,695,257 | 4 个根文件（`vendor-CCJJTK99.js` 740,575、`index-DjTxlw_T.js` 634,085、`vendor-BNsW4eBh.css`、`index-DBK_Mahs.css`）+ 40 个 shiki 语言 js + 78 个 KaTeX 字体（22 `.woff2` / 28 `.woff` / 28 `.ttf`）+ 3 个 Montserrat woff2 + `Montserrat-OFL.txt`。**全部被 Vite 产物引用，无死资源** |
| `deepseek/harness-brand/` | 12 | 4,099,850 | 2 个 SVG + 10 个品牌衍生 bundle；见 B 类表 |
| `deepseek/licenses/` | 493 | 3,362,040 | 见下：`shell-reference` 252、`icons` 69、`upstream-source-reference` 18（含 `pnpm-lock.yaml` 1,029,241）、`bundled-notices` 11、`fonts` 4，其余按插件名各 2 个（LICENSE + NOTICE） |
| `deepseek/provenance/` | 5 | 687,833 | `default-client-roster.json` 30,318、`npm-releases.json` 43,198、`published-frontend-index.html` 825、`published-manifest.webmanifest` 255、`source-reference.json` 613,237。**均为溯源元数据，无问题**（除 AST-16 措辞位于上一级 `provenance.json`） |
| `deepseek/` 根 | 12 | 417,745 | `LICENSE`、`THIRD_PARTY_NOTICES.md` 24,538、`boot-manifest.js` 35,775、`boot-manifest.json` 45,763、`favicon{-dark,}.svg`、`harness-adaptations.css`、`index.html`（**AST-14**）、`loader-facade.js`、`manifest.webmanifest`、`provenance.json` 282,915（**AST-16**）、`transport.js` |
| `public/` 根 | 4 | 59,195 | `index.html`（真正的 `/` 入口）、`app.js`、`style.css`、`coding-workflow.js` —— 全部在 `server.ts:34-47` `STATIC_FILES` 白名单内，无问题 |
| `public/legacy/` | 3 | 53,016 | `index.html` + `app.js` + `style.css`；见 B 类表（冻结夹具） |
| `public/vendor/deepseek/` | 8 | 52,583 | `LICENSE`、6 个 CSS（`base`/`corner-shape`/`design-platform`/`focus`/`gradient-shadow-text`/`scrollbar`）、`source-manifest.json`。6 个 CSS + LICENSE + source-manifest 全在 `STATIC_FILES` 白名单；**无死资源，无问题** |

**引用链完整性（核心结论）**：66 个 boot-manifest 条目 ↔ 66 个磁盘插件目录，**一一对应，无孤儿、无缺失**；`assets/` 下 126 个文件全部由 `index-DjTxlw_T.js` / `index-DBK_Mahs.css` 的 Vite 产物链引用；`legacy/` 三件套自成闭环且被测试脚本引用。**唯一死资源是 `deepseek/index.html`（AST-14）。**

### 2.2 `docs/`（7,413 文件 / 248,897,576 B）

顶层实测表见 §1 说明 · AST-02。核心问题全部集中在 `docs/evidence/`（243.5 MB / 7,175 文件，103 个 run 目录）：

- **超大 JSON（>500 KB）**：全仓 84 个 >500 KB 文件中，`docs/` 占 **65 个**（63 个在 `docs/evidence`，2 个在 `docs/reviews`）。Top：
  | 文件 | 字节 |
  |---|---|
  | `docs/evidence/agent-next7-20261006/execution/main/campaign-result.json` | 7,742,417 |
  | `docs/evidence/pr-20261014/raw.tar.gz` | 6,404,255 |
  | `docs/evidence/gen1-final-20261008/history/ci/gen1-ci-bundle-bcea726.tar.gz` | 4,550,434 |
  | `docs/evidence/gen1-final-20261008/history/ci/gen1-ci-bundle-c5bbe61-attempt1.tar.gz` | 4,549,272 |
  | `docs/evidence/gen1-final-20261008/release/gen1-ci-bundle-c5bbe61fef101a8c9eb10edab673be8b2e0935e3.tar.gz` | 4,549,271 |
  | `docs/evidence/web-deepseek-parity-20261013/accepted-b38566d/full.json` | 3,417,954 |
  | `docs/evidence/web-deepseek-parity-20261012/final-gates/full-suite.json` | 3,415,933 |
  | `docs/evidence/agent-next-20261004/raw/frozen-*/r2-performance/result-*.json`（4 个同尺寸） | 3,406,892 ×4 |
  | `docs/reviews/source-audit-20261007/evidence/n7-main-dry/dry-run.json` | 940,504 |
  | `docs/reviews/source-audit-20261007/evidence/n7-holdout-dry/dry-run.json` | 936,313 |
- **同一主题重复的证据目录**：`source-audit-20261007`（`docs/reviews`）vs `source-audit-fixes-20261007`（`docs/evidence`）→ AST-10；`final-audit-20261014` 内 `installed/` 与 `historical-installed-7e0295a/` 的 `PORTABLE-MANIFEST.json` 各 651,211 B 且同尺寸。
- **无索引的孤儿目录**：`docs/architecture/`、`docs/evolution/`、`docs/harness-engineering/`、`docs/r72/r74/r76/r77/r78/r79/r80/r81-evidence/` 共 11 个顶层目录无 `README`/`index`（`docs/evidence`、`docs/discourse`、`docs/research`、`docs/reviews` 有）。→ AST-12 / AST-13（说明：`docs/` 根另有 145 个平铺 `.md`，本身也不构成索引）。

### 2.3 `benchmarks/`（2,236 文件）

目录实测：

| 目录 | 文件 | 字节 | case 数（`case.json`） | 结论 |
|---|---|---|---|---|
| `results/` | 60 | 1,637,867 | — | B 类：被 `e2-command.ts:20-21` 等作为契约基线引用 |
| `stress/` | 1,082 | 874,110 | 11 | 无问题（含刻意的 1,003 文件夹具与 830 KB 长 JSON） |
| `n7-evidence/` | 351 | 565,649 | 64 | 无问题（被 `n7-evidence-cases.regressions.test.ts` 绑定） |
| `n6-holdout/` | 129 | 197,058 | 24 | 无问题 |
| `n7-holdout/` | 130 | 196,729 | 24 | 无问题 |
| `n6-evidence/` | 129 | 175,552 | 24 | 无问题 |
| `coding-repositories-v1/` | 3 | 72,881 | — | **AST-01** |
| `tools/` | 1 | 38,636 | — | `generate-suite.mjs`，无问题 |
| `holdout/` | 130 | 22,006 | 32 | 无问题 |
| `regression/` | 122 | 19,621 | 30 | 无问题 |
| `README.md` | 1 | 18,384 | — | 声明的 30/32/13/11 与实测吻合 |
| `adversarial/` | 56 | 10,854 | 13 | 无问题（除 AST-17 的 `.env` 占位） |
| `baseline-e4-r74/` | 34 | 6,591 | — | B 类：`e4-r77-baseline-oracle.test.ts:33` 冻结目录 |
| `r98-fixtures/` | 8 | 2,127 | — | 无问题；但 CRLF 未钉（AST-01 附注） |

- **用例结构约定（实测样本 `benchmarks/n6-holdout/n6h-preview-01-csv-column-order/`，5 文件）**：`case.json`（元数据）+ `request.md`（任务）+ `expected.md`（判据）+ `fixture/<workspace 树>`。`fixture/` 是**被测工作区输入**，不是产物 —— 因此不存在"workspace 产物被误提交"。
- **未被任何配置/脚本引用的用例**：未发现。逐一核对 8 个 suite 的 `case.json` 计数与 `apps/cli/src/audit.ts:586/596/606/616` 的声明数（regression 30 / holdout 32 / adversarial 13 / stress 11）**完全吻合**；n6/n7 四个 suite 分别由 `packages/evaluation/src/n6-evidence-cases.regressions.test.ts`、`n7-evidence-cases.regressions.test.ts` 与 `scripts/research/agent-next{6,7}-2026*/` 生成器双向绑定。
- 唯一"提交了运行产物"的是 `benchmarks/results/`（60 文件），但它是被引用的契约基线，见 B 类表。

### 2.4 `third_party/`（12 文件 / 21,311 B）

| 文件 | 字节 | 许可/溯源记录 | 结论 |
|---|---|---|---|
| `coding-benchmark/LICENSE-hermes-agent-MIT` | 1,091 | MIT 全文 | 无问题 |
| `coding-benchmark/README.md` | 460 | 记录 HARNESS-SRC-FORK 快照 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`，并明示"aggregate snapshot identity, not an official Hermes upstream commit" | 无问题（措辞已很谨慎） |
| `coding-index/LICENSE-tree-sitter-wasm` | 1,162 | MIT | 无问题 |
| `coding-index/README.md` | 997 | 记录 Aider `aider/repomap.py` @ `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`（Apache-2.0，声明"未复制实现与提示词"）+ `@vscode/tree-sitter-wasm@0.3.1` | 无问题 |
| `coding-prompts/codex-Apache-2.0.txt` | 11,127 | Apache-2.0 全文 | 无问题 |
| `coding-prompts/codex-NOTICE.txt` | 248 | Apache NOTICE | 无问题 |
| `coding-prompts/hermes-MIT.txt` | 1,091 | MIT | 无问题 |
| `coding-prompts/opencode-MIT.txt` | 1,086 | MIT | 无问题 |
| `coding-prompts/pi-MIT.txt` | 1,089 | MIT | 无问题 |
| `deepseek-workspace-changes-MIT.txt` | 1,086 | MIT | 无问题 |
| `xtermjs-MIT.txt` | 1,261 | MIT | 无问题 |
| `xtermjs-MIT.provenance.json` | 613 | **完整溯源元数据**：`sourceUrl`/`sourceCommit` `f447274f430fd22513f6adbf9862d19524471c04`/`sha256`/`bytes`/`license`/`appliesTo`（`@xterm/headless@6.0.0`、`@xterm/addon-serialize@0.14.0`）/`reason` | 无问题，**且是本目录唯一达到理想粒度的样本** |

**结论**：12 个文件全部有明确的许可文件；9 个 MIT / 1 个 Apache-2.0（含 NOTICE）。来源记录齐全但**粒度不一**：仅 `xtermjs` 有机器可校验的 `.provenance.json`（含 commit + sha256 + bytes），其余 3 个 README 只有人读的散文。建议（不强制，故不入总表）：把 `coding-benchmark` / `coding-index` / `coding-prompts` 也补一份 `<name>.provenance.json`，字段复用 xtermjs 的 schema。

### 2.5 `research/`（20 文件，全部在 `research/mechanisms/`）

`README.md`(2,441) + `_template.yaml`(716) + `schema.json`(1,483) + 17 个机制 yaml（`auto-generated-benchmark-candidates` 1,876、`context-policy-learning` 1,535、`counterfactual-harness-evaluation` 1,605、`dynamic-tool-selection` 1,669、`formal-invariants` 2,278、`learned-prompt-rules` 2,131、`learned-tool-preference` 1,703、`learned-workflow` 1,647、`model-routing-experiment` 1,614、`multi-variant-evolution-loop` 1,601、`offline-trace-replay` 1,547、`planner-executor-separation` 1,594、`recovery-policy-learning` 1,424、`review-agent-experiment` 1,470、`scheduler-policy-learning` 1,431、`self-modification-sandbox` 1,671、`specialist-routing` 1,572）。**结构规范（模板 + schema + 17 实例），全部有索引，无死文件，无问题。**

## 3. 覆盖清单

`git ls-files` 实测：`apps/web/public` 801、`docs` 7,413、`benchmarks` 2,236、`research` 20、`third_party` 12 = **10,482**（全仓 11,937）。

### 3.1 逐文件结论（小规模目录，全部逐行/逐字节核对）

**`apps/web/public/` 根（4）**：`index.html` 无问题（入口，`STATIC_FILES`）；`app.js` 无问题（`gen1-session-sidebar.test.ts:6` 引用，且是 legacy 夹具的源）；`style.css` 无问题；`coding-workflow.js` 无问题。

**`apps/web/public/legacy/`（3）**：`index.html` 见 B 类表；`app.js` 见 B 类表；`style.css` 见 B 类表。

**`apps/web/public/vendor/deepseek/`（8）**：`LICENSE`、`base.css`、`corner-shape.css`、`design-platform.css`、`focus.css`、`gradient-shadow-text.css`、`scrollbar.css`、`source-manifest.json` —— **全部无问题**（8 个中的 7 个在 `STATIC_FILES` 白名单，`source-manifest.json` 被 `server.ts` 与 `scripts/research/gen1-20261008/verify-evidence.mjs` 引用）。

**`apps/web/public/deepseek/` 根（12）**：`LICENSE` 无问题；`THIRD_PARTY_NOTICES.md` 无问题；`boot-manifest.js` 无问题；`boot-manifest.json` 无问题（66 条目全对应）；`favicon.svg` / `favicon-dark.svg` 无问题（内容不同，双主题）；`harness-adaptations.css` 无问题（根 `index.html` 引用）；`index.html` → **AST-14**；`loader-facade.js` 无问题（`deepseek/index.html` 与 boot 链引用）；`manifest.webmanifest` 无问题；`provenance.json` → **AST-16**；`transport.js` 无问题。

**`third_party/`（12）**：逐文件见 §2.4 表 —— 12 个全部**无问题**。

**`research/mechanisms/`（20）**：`README.md`、`_template.yaml`、`schema.json` + 17 个 `*.yaml` —— **全部无问题**。

**`docs/` 根（151）**：145 `.md` + 6 `.json`。抽样核对 `docs/evolution/*.json`（被 `.gitattributes` 钉 LF，且被 `packages/evaluation/**` 测试读取）→ 无问题；其余 145 个 `.md` 平铺无索引 → **AST-12**（作为整组）。

**`docs/reviews/`（20）**：`source-audit-20261007/README.md` 无问题；`evidence/n7-main-dry/dry-run.json` 与 `n7-holdout-dry/dry-run.json` → **AST-10**；其余 17 个 `evidence/*.json` 无问题。

### 3.2 聚合规则（同构文件 ≥200，按目录聚合）

| 分组 | 文件数 | 聚合规则 | 逐行情况 | 结论 |
|---|---|---|---|---|
| `apps/web/public/deepseek/plugins/` | 70 | 66 个 `<pkg>/client.js` 各 1 文件；2 个包带 lazy chunk（`sidebar-documentpreview` 4 文件 = `client.js`+`client.excel.js`+`client.pdf.js`+`client.frontmatter-fields.js`；`sidebar-terminal` 2 文件） | **未逐行（minified 单行 bundle，均 27 KB–7.1 MB，无人工可读结构）**；替代手段：① 66 目录名与 `boot-manifest.json` 66 条目做集合相等性校验（通过，无孤儿/无缺失）；② 每个包在 `licenses/<pkg>/` 有 2 个许可文件（LICENSE+NOTICE）；③ 每个包在 `tarballs/<pkg>.tgz` 有对应供应链输入 | 见 B 类表 |
| `apps/web/public/deepseek/tarballs/` | 67 | 每个插件包 1 个 `.tgz` + `dsh-web-frontend.tgz` | **未逐行（gzip 二进制）**；替代手段：`deepseek-frontend-vendor.mjs:92-93` 对每个包断言 `bytes/sha256/integrity/shasum` 四重绑定，`:107-108` 逐文件比对解包内容 | 见 B 类表 |
| `apps/web/public/deepseek/assets/` | 126 | 按类型：4 根文件 / 40 shiki 语言 js / 78 KaTeX 字体（22 woff2+28 woff+28 ttf）/ 3 Montserrat woff2 / 1 `Montserrat-OFL.txt` | **未逐行（编译产物与字体二进制）**；替代手段：核对 Vite 产物 `index-DjTxlw_T.js` 与 `index-DBK_Mahs.css` 的引用集合（无需人工读） | 无死资源 |
| `apps/web/public/deepseek/licenses/` | 493 | 按子目录：`shell-reference` 252 / `icons` 69 / `upstream-source-reference` 18 / `bundled-notices` 11 / `fonts` 4 / 其余 66 个插件目录各 2 个 | **未逐行（493 份许可全文，逐字重复的 MIT/Apache 模板）**；替代手段：确认每个插件目录都有 LICENSE+NOTICE 两份、`upstream-source-reference` 含 `pnpm-lock.yaml`（1,029,241 B）作为依赖图证据 | 无问题 |
| `apps/web/public/deepseek/harness-brand/` | 12 | 2 SVG + 10 个 `plugins/<pkg>/client.js` | 逐字节比对 10 个衍生 vs 10 个原始（SHA256 全 DIFF，符合"品牌衍生"预期） | 见 B 类表 |
| `apps/web/public/deepseek/provenance/` | 5 | 5 个独立元数据文件 | 全部逐行读取 | 无问题 |
| `docs/evidence/` | 7,175 | 按 103 个 run 目录 → 再按 `raw/`、`execution/`、`logs/`、`browser/` 等子层 | **未逐行（7,175 个文件合计 243.5 MB，其中 698 PNG + 112 SQLite + 10 tar.gz + 85 gz 为二进制不可读）**；替代手段：① `git ls-files` 全量哈希与体积普查；② 同尺寸分组做重复检测（99 组，上界 32.7 MB）；③ 对 4 组已确认精确重复做 sha256 逐字节验证；④ 二进制类型占比统计 | 见 AST-02~11 |
| `docs/` 根 | 151 | 145 `.md` 平铺 + 6 `.json` | **未逐行（145 个 markdown 合计 2.47 MB）**；替代手段：按 `.gitattributes` 的 LF 钉清单与 `packages/evaluation/**` 的引用点反向确认哪些是"活契约" | 见 AST-12 |
| `docs/r7{2,4,6,7,8,9}-evidence` + `r80/r81` | 16 | 8 个碎片目录 | 全部读取 | 见 AST-13 |
| `benchmarks/n6-holdout`、`n7-holdout`、`n6-evidence`、`n7-evidence` | 739 | 每个 case 1 目录（`case.json`+`request.md`+`expected.md`+`fixture/**`）；24/24/24/64 个 case | **未逐行（739 个用例文件）**；替代手段：① 逐 suite 统计 `case.json` 数并与生成器/测试绑定的 suiteId 比对；② 抽样 `n6h-preview-01-csv-column-order` 完整读取用例结构 | 无问题 |
| `benchmarks/stress/` | 1,082 | 11 个 case；其中 `stress-many-small-files` 独占 1,003 文件（1000 个 `fixture/files/f%04d.txt`） | **未逐行（1,003 个代码生成的空壳 txt）**；替代手段：确认文件名序列 `f0000..f0999` 连续、符合"多小文件"压测意图 | 无问题 |
| `benchmarks/{regression,holdout,adversarial,r98-fixtures}` | 316 | 每 case 1 目录，30/32/13/4 个 case | **未逐行**；替代手段：count 与 `apps/cli/src/audit.ts` 声明数比对（完全吻合）+ 引用点 grep | 无问题 |
| `benchmarks/results/` | 60 | 每 run 1 目录（`*-summary.json`/`*.md`/`manifest.json`/`paired-eval.md`/`holdout.json`） | 部分逐行（`holdout.json` 与 `.sanitized.json` 做了 sha256 比对） | 见 B 类表 + AST-11 |

### 3.3 文件类型视角（全仓 `git ls-files` 实测）

| 扩展名 | 文件数 | 字节 | 落点 | 结论 |
|---|---|---|---|---|
| `.tar.gz` | 10 | 33,808,909 | 9 在 `docs/evidence`，1 在 `apps/web`（`sources/`） | 见 AST-08；`apps/web` 那份是 B 类 |
| `.png` | 698 | 31,793,217 | **全部在 `docs/evidence`** | AST-03 |
| `.tgz` | 67 | 13,741,043 | **全部在 `apps/web/public/deepseek/tarballs`** | B 类（供应链输入） |
| `.gz` | 87（含 10 个 `.tar.gz`） | 8,504,524 | 85 在 `docs/evidence`，1 在 `apps/web`，1 在 `docs/reviews` | 同 AST-02 归档策略 |
| `.log` | **1,122** | 6,448,295 | 全部在 `docs/evidence/**` | AST-05 |
| `.db` | **112** | 5,505,024 | **全部在 `docs/evidence`**（SQLite） | AST-04 |
| `.jsonl` | 511 | 4,101,556 | 510 在 `docs/evidence`，1 在 `scripts/benchmark`（属代码侧） | 同 AST-02 |
| `.woff2` | 22 | 441,872 | `apps/web/public/deepseek/assets`（KaTeX + Montserrat） | 无问题 |
| `.zip` | 1 | 7,225 | — | 无问题 |
| 零字节文件 | **88** | 0 | 绝大多数在 `docs/evidence/**/logs/`、`raw/*/stderr.log` | AST-06 |

## 4. 存疑/需人工确认

1. **`apps/web/public/deepseek/index.html` 是否真的可删**：它零引用，但 `provenance.json` 的 `files` 清单（785 条）与 `rootIndexSha256` 的生成逻辑在 `scripts/research/deepseek-frontend-vendor.mjs`。若该目录清单是"磁盘全量快照"，删文件必须同步重跑生成器，否则 `deepseek-frontend-vendor.test.mjs` 的比对会失败。删前需确认生成器是"扫描磁盘"还是"读清单"。
2. **`docs/evidence` 内 99 组同尺寸文件里，哪些是真重复**：我只对 4 组（AST-08/09/11）做了 sha256 逐字节确认。其余 95 组只是"字节长度相同"，可能是内容不同的同名产物（如 `result.json` 在不同 commit 下恰好同长）。**全部清理前必须逐组算 sha256**，不能按尺寸删。
3. **AST-01 的 `followup` 组哈希 `0b41285e…` 与 `final-4ee21776` 组 `db483652…` 不同**：我把原因归结为 `upstream-seeded.json` 在这些 run 之间**内容被改过**（任务表变化），而非换行。这一点未逐版本的 `git log` 验证；如果要精确定位"哪次改写引入 CRLF 敏感性"，需要 `git log -p -- benchmarks/coding-repositories-v1/upstream-seeded.json`。
4. **`apps/web/public/deepseek/plugins/dsh-client-ui-settings-account/client.js` 5,280,221 B vs `harness-brand/` 同名 2,203,624 B**（差 3.08 MB）：其余 9 个品牌衍生与原件的差都在几十～几百字节量级（如 conversation 878,120 vs 877,842 = +278 B），唯独这一个差一半以上。可能是品牌化时剔除了某个大内联资源（如内置示例数据或 PDF/Excel 渲染器），也可能是构建配置差异。**未逐行比对（7.5 MB minified 对照无有效手段）**，建议人工确认是否与 `publishedArtifactPolicy` 声称的"仅 10 个显式标记的 UI 衍生"一致。
5. **`benchmarks/adversarial/adv-credential-exfil-filenames/fixture/.env`**：内容是占位符（`qa_000000_placeholder_only`），我判定为对抗夹具而非真实泄露。但这类夹具会被任何 CI secret-scanner 反复报警，需确认仓库的 secret-scan 配置是否已把它列入白名单 —— 若没有，属于"已知会误报但未登记"的运维债。
6. **`docs/` 是否另有导航入口**：我确认 `docs/` 根无 `README.md`，但未检查仓库根 `README.md` 是否承担了 docs 导航职责（那属于其他审查员的 scope）。

---

**审查方法说明**：所有体积/计数均来自 `git ls-files` + `Get-Item.Length` 实测，未包含 `node_modules`、`.git`、`dist`、`.ci`。重复判定使用 SHA256（`Get-FileHash`）。跨平台哈希验证使用 `git cat-file -s`（blob 字节数）与工作区文件字节数对比，并将工作区内容归一化为 LF 后重新哈希。本文件仅记录，未对任何被跟踪文件做修改或删除。
