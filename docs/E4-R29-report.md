# E4-R29 Report — 以原始字节计算源码身份（G03）

- 被测 SHA：工作树基于 `964ecc94`（R27 `f2f1b0b` / R28 `fb33ba9` 之后），R29 改动为**未提交工作树**（见第 4 节）。
- 审查基线：`bcf34b7179152ac2fc24931f268fada8a67f82d9`；本轮 reviewedSourceSha `493866f03d942e85870cc658eb721cfbf2389ec2`。
- 状态：PASS（0x80/0x81 指纹分离 + tracked/untracked 双覆盖 + 不可读→UNKNOWN + 身份→journal 链路 + 全回归）
- 真实模型调用：0（全部离线；临时 git 仓库 fixture）
- 变更文件：
  - `apps/cli/src/benchmark-command.ts`（`probeSourceSnapshot` 重写）
  - `apps/cli/src/benchmark-command.test.ts`（+4 例，共 66 例）

## 1. 复现（修复前）

G03：`probeSourceSnapshot` 对每个文件 `readFileSync(path, "utf8")` 后再 `sha256(str, "utf8")`。
无效 UTF-8 字节统一解码为替换字符 U+FFFD，两个不同的原始字节变成**同一个字符串** →
同一指纹。离线临时 git 仓库、未跟踪 `binary.bin`：

```json
{"id":"BINARY_SOURCE_COLLISION","equal":true}
```

修复前后直接以 Node `crypto` 复算（内容 = 单字节）：

| 输入 | UTF-8 解码 | BEFORE `hash(decoded, "utf8")` | AFTER `hash(rawBytes)` |
|---|---|---|---|
| `Buffer([0x80])` | `"\uFFFD"` | `83d544cc…783fb097` | `76be8b52…8995ac71` |
| `Buffer([0x81])` | `"\uFFFD"` | `83d544cc…783fb097` | `591b7cc9…f14c440a6` |
| 相等？ | — | **true（碰撞）** | **false（已分离）** |

该问题主要影响 dirty/offline 身份、确认与 journal 归属；强隔离晋升路径当前还要求干净源码，
因此**不**把这个碰撞描述为已绕过干净树限制。

## 2. 修复（`apps/cli/src/benchmark-command.ts` → `probeSourceSnapshot`）

### 2.1 原始字节身份

- `hashBytes(buf: Buffer) = sha256(buf)`：文件内容一律以真实字节哈希，**禁止** UTF-8 重解码后再代表文件字节。
- 文本/元数据走独立的 `hashText`（`utf8`），二者不混用。

### 2.2 无歧义的结构编码

每个偏差项编为一条 `JSON.stringify` 记录（消除 path 与元数据之间的空格分隔歧义），按路径确定性排序：

| 类型 | 记录 |
|---|---|
| tracked 文件 | `["T", mode, indexBlob, "bytes:<sha256>", path]` |
| untracked 文件 | `["U", "bytes:<sha256>", path]` |
| 软链 | `symlink:<readlink 目标>`（链接自身身份，**不是**目标内容） |
| submodule / gitlink | `gitlink:<index commit>`（index 提交即身份） |
| 工作树删除 | `deleted`（仅 `ENOENT`） |
| 目录 | `dir` |

指纹 = `sha256(records.join("\n") + "\n---\n" + porcelain.trim())`；porcelain 仍只作
mode/rename/type 的补充信号，**不是**内容身份。

### 2.3 「不可读」与「已删除」严格分开

- `isAbsent(e)` 只认 `ENOENT` → `deleted`。
- 其他 I/O 错误、或「常规 tracked 文件被目录替换」（`EISDIR`）→ 记入 `unreadable`，
  整个 probe 返回 `{ treeFingerprint: null, clean: false, error: "source snapshot unknown, unreadable entry: …" }`。
- 不可读输入**不会**被编码成正常 `missing` 行后宣称内容已验证（fail-closed）。

### 2.4 保留的既有行为

- 干净 checkout 快速路径不变：`git status --porcelain` 为空 → 直接 `{ treeFingerprint: null, clean: true }`，不遍历工作树。
- 排除规则不变：untracked 走 `git ls-files --others --exclude-standard`，ignored 产物（node_modules/dist/coverage/.ci）继续被排除。
- 路径确定性排序、index/worktree 区分、mode 信息均保留。

## 3. 验收对照

| 计划验收项 | 结果 | 证据（测试名） |
|---|---|---|
| 0x80 与 0x81 得到不同指纹，tracked/untracked 都覆盖 | ✅ | `R29 (G03): untracked binary bytes 0x80 vs 0x81 …`；`R29 (G03): TRACKED binary bytes 0x80 vs 0x81 …`（后者断言 porcelain 文本相同仍指纹不同） |
| 完全相同字节在重复 probe 中稳定 | ✅ | 上述 untracked 用例内：重写相同字节 → 指纹 `toBe` 相等 |
| A→B 文本、删除、staged/unstaged 变化仍被识别 | ✅ | 既有 `F05: A→B edit …` / `F05: deleted tracked file …` / `F05: identical content → STABLE …`（staging 改变指纹）仍全绿 |
| 读取错误明确返回未知/失败，不与删除混为正常验证 | ✅ | `R29: a tracked file present but unreadable (replaced by a directory) yields UNKNOWN …`：`treeFingerprint === null` 且 `error` 匹配 `/unreadable/i` |
| 无关 ignored 输出目录保持既有排除规则 | ✅ | 既有 `F05: identical content → STABLE …`（`ignored-out/` 出现/删除指纹不变） |
| 指纹变化通过实际 execution identity 影响 journal 归属 | ✅ | `R29: a treeFingerprint change flows into the REAL execution identity → a different journal bucket`：真实 `buildExecutionIdentityV1`/`computeExecutionIdentityDigestV1`，不同指纹 → 不同 digest（journal 目录 `join(outDir, ".paired-journal", digest)`） |
| 报告明确 symlink/submodule/ignored 的覆盖边界 | ✅ | 见第 5 节 |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run apps/cli/src/benchmark-command.test.ts` | **66/66 PASS**（Test Files 1 passed，exit 0） |
| `./node_modules/.bin/vitest run apps/cli/src/benchmark-command.test.ts -t "R29"` | **4 passed \| 62 skipped**（exit 0） |
| `./node_modules/.bin/tsc -b`（`pnpm typecheck`） | exit 0 |

- 本轮 R29 改动为本地工作树改动，**未提交、未推送**；推送与新 CI run 按计划 R31 #4 处理
  （testedSourceSha 与 documentationCommitSha 严格区分）。

## 5. 覆盖边界与残余限制（诚实声明）

- **覆盖**：tracked 工作树真实字节 + index（mode/blob）+ 工作树删除（`ENOENT`）+ 非 ignored untracked 字节
  + symlink 链接身份 + gitlink 提交 + porcelain 的 mode/rename/type 补充信号。
- **不含** ignored 产物（node_modules/dist/coverage/.ci 等）——它们不是被确认的源码输入，理由与 R23 一致。
- **submodule**：只绑定 index 中的 gitlink commit，**不**读取、也**不**声称覆盖 submodule 工作树内部的脏内容。
- **symlink**：绑定链接目标字符串本身；链接目标文件的内容变化**不**体现在该记录里（如需目标内容身份需另行展开，本任务未做）。
- **不证明**：本指纹只证明「源码字节与确认时一致/变化可感知」，不证明内容正确、不证明模型质量，
  也不对持有 git 写权限的攻击者构成防篡改防线（与 F02/R23 立场一致：拒绝协议上自相矛盾或自身漂移的产物）。
- **性能**：干净树在 `status` 处提前返回；仅脏树做全量字节哈希，低频 benchmark 路径毫秒级，可接受。
- **协议升级兼容**：指纹编码从「空格分隔行」变为「JSON 记录」，dirty 树的指纹值因此改变——
  这正是修复目的（旧 journal 不会误复用新身份）；干净树 `treeFingerprint: null` 快速路径不变，
  不产生无谓的身份抖动。
