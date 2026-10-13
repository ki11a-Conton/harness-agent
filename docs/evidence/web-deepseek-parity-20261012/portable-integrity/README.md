# Portable 发布完整性开发验收

本记录针对完整 DeepSeek Web 所新增的真实 `node-pty` 依赖和归档执行位；不代替完整 UI、正式源码、安装消费或 Windows 验收。`receipt.json` 固定本次 dirty 开发源码模块 hash，未构建或发布正式产品 archive。

## 缺陷与修复

- fresh frozen `--ignore-scripts` 安装没有 Linux `pty.node`。安装继续禁止所有普通 lifecycle，只在版本、原始 npm integrity 和 install/postinstall 脚本均匹配已审查 `node-pty@1.1.0` 后递归 rebuild 该包。重建前后核对全部官方跨平台 prebuild hash，再从 fresh install 实际导入 native 模块。
- Git `100755` 在源码快照被丢弃；提取仅特判 `agent.sh`，丢失 Darwin `spawn-helper` 的执行位。现在快照保留 Git 模式、payload 统一为 `0644` 或 `0755`，恢复 pnpm store 安装时丢失的已审查 native helper 模式。Windows 构建通过显式模式记录保留不能由 NTFS 表达的 Unix 执行位。
- schema 1 仅绑定内容，未绑定模式。新 archive 用 schema 2；提取在写任何文件前核对全部声明内容、hash 和 tar 模式，POSIX 每次启动还验证已提取文件模式。Windows 的归档模式验证在提取前完成。历史 schema 1 archive 继续验证，不改写历史发布物。
- tar 数字字段原本可接受部分解析的值。现在拒绝 junk suffix、特殊权限位、可写的非标准模式、非零 UID/GID/mtime、非零填充和不支持的格式；builder 和 reader 共享 256 MiB 原始 tar 上限。
- 新外部 builder 不能给旧源码嵌入不支持 schema 2 的 verifier；执行中的两份 portable 工具须与 pinned source 相符，允许 Windows checkout 的 CRLF 归一。
- `--offline` 原生重建不能静默下载 Node headers。没有当前平台预构建时要求 `--node-headers-dir` 指向完整本地 Node SDK，实际由 `npm_config_nodedir` 传给 node-gyp。

## 实测

`baseline.log` 记录原有 portable 14 项通过。新增 5 个回归在 `mode-red.log` 中失败，覆盖 native helper 执行位、严格 tar 字段、schema 2 模式/内容和 Git 执行位。修复后的 `mode-green.log` 包含 portable 与原有 release draft 回归，全部通过。

`native-green.log` 用独立临时 fixture 从官方锁定包执行 frozen `--ignore-scripts` 安装，在 Linux 先确认 native 导入失败，再执行实际特定包重建。另设被允许安装但必须不执行的 workspace/dependency lifecycle canary；全程执行次数为 0。全部 28 个 Win/Darwin prebuild 内容保持一致，显式本地 Node SDK 的 offline 重建也无 node-gyp HTTP 下载。

实际生成、提取同一 schema 2 fixture archive 后，Node **24.19.0** 和最低支持版本 **22.19.0** 都从提取目录导入相同 native bytes、实际 spawn PTY、收到 `portable-native-ok` 和退出码 0。Node 22 发行包与官方 `SHASUMS256.txt` SHA-256 相符，收据和原始 checksum 留档。fixture archive 为 316 个文件、15,577,109 字节；其 SHA 见 `receipt.json`。此 fixture 使用测试入口，并非 Harness 产品包。

## 复验命令

```sh
node --test scripts/release/portable.test.mjs scripts/release/gen1-export-draft.test.mjs

HARNESS_PORTABLE_STORE_DIR=/tmp/harness-agent-web-pnpm-store \
HARNESS_PORTABLE_NODE_BINARIES=/tmp/harness-portable-node22-20261012/node-v22.19.0-linux-x64/bin/node \
HARNESS_PORTABLE_REQUIRE_NODE_MAJORS=22,24 \
node --test scripts/release/portable-native.test.mjs
```

正式 clean source commit 完成后才执行以下门；out 必须是新目录，SHA 必须为该工作区完整 HEAD：

```sh
node scripts/release/portable.mjs build --repo "$TASK_REPO" --out "$TASK_OUTPUT" \
  --version "$TASK_VERSION" --source-sha "$TASK_SOURCE_SHA" --store-dir "$TASK_STORE"

node scripts/release/portable.mjs verify --archive "$TASK_ARCHIVE" --out "$TASK_EMPTY_CONSUMER" \
  --version "$TASK_VERSION" --source-sha "$TASK_SOURCE_SHA"
```

正式完整包、真实 Windows 同 archive 消费和完整官方 UI 的浏览器验收尚未在本子任务中运行。模型调用 0 次，模型能力仍为 `NOT_PROVEN`。
