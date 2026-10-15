# C1–C7 固定源码工程验收

产品源码：`4ee217767c35b3a3fd5a44b1a59ce04581ef25d9`，Git tree：`1fdb0b45ebf3cb6015e5adaa0d176a588f6418e0`。产品基线为 `2a141309f01acae3707060faf1fab8aa247ed31d`。本目录随后以文档归档提交入库，不能将归档提交 SHA 冒充已跑全量的源码 SHA。

实施范围、环境变量、SDK API 和兼容性见 [实施说明](../../../coding-evolution-20261015.md)，做什么/怎么做/怎么验收及最终状态见 [plan](../../../../plan(20261015-114843).md)。本轮付费模型调用 **0**；新策略的真实模型质量、真实提供商缓存收益均为 **NOT_PROVEN**。没有发布 release、tag，也没有推广 coding-v2 为默认。

## 最终结果

| 验收 | 实际结果 | 原件 |
| --- | --- | --- |
| 干净源码全量 | 579 文件通过、2 文件跳过；9794 项通过、15 项平台跳过、零失败，985.69 秒 | `coding-evolution-final-4ee21776-tests.log` |
| 类型检查 / 安全 | typecheck 退出 0；安全 2146 项通过 | `coding-evolution-typecheck-4ee21776.log`、`coding-evolution-security-4ee21776.log` |
| 文档 / 能力审计 | 固定源码文档及严格能力审计通过 | `coding-evolution-docs-4ee21776.log`、`coding-evolution-audit-4ee21776.log` |
| 可移植包构建 | 实际独立源码快照构建，3112 文件；消费者运行无 workspace link | `PORTABLE-MANIFEST.json`、`BUILD-RECEIPT.json`、`SHA256SUMS` |
| 安装后 CLI / Web | 50 项实际 coding 断言、19 个 loopback HTTP 请求；实际入口拒绝被改动的包 | `installed-cli/result.json` 及请求、事件、工具、验收原件 |
| coding-v2 真实宿主 | 8 项策略断言 + 50 项原 coding 断言；19 个实际 CLI/Web HTTP 请求 | `coding-v2-hosts/result.json`，三角色实际 prompt 及请求 |
| 安装后普通 UI | 3 个视口、30 场景、75 断言；2 个连接场景、10 断言 | `installed-ui/result.json`、浏览器详细记录和截图 |
| 安装后编码面板 | 12 项实际浏览器检查；审批写磁盘、真实 diff、取消续接、断网不确定态、同 requestId 重试 | `installed-panel/browser.json`、桌面/窄屏截图 |
| 安装后 AST / URI | 真正运行包内 Runtime、WASM 和 repo_map；字面 `%20`/空格/`#` 文件名可往返编码 | `coding-evolution-installed-tools-4ee21776.json`，重跑工具 `installed-tools.mjs` |
| 检索测量 | 30 gold 查询，TS/Python/Rust+Go 各 10；定义/调用方全部命中，相关结果 recall@5 均为 1 | `retrieval/measurement.json` |
| 双平台主 CI | [主 CI 第 2 次完整尝试](https://github.com/ki11a-Conton/harness-agent/actions/runs/38703968309/attempts/2) 的 10 个任务全部成功；Windows/Ubuntu 正式离线、coverage、同 SHA/同 attempt 双平台 join 通过 | `ci/` |
| 真实 Windows 专项 | 同源码工作流通过 | [38703968399](https://github.com/ki11a-Conton/harness-agent/actions/runs/38703968399) |
| 两类安装包 CI | 同源码普通安装验收、官方来源 UI 安装验收均通过 | [38703968246](https://github.com/ki11a-Conton/harness-agent/actions/runs/38703968246)、[38703968289](https://github.com/ki11a-Conton/harness-agent/actions/runs/38703968289) |

测试包沿用构建参数版本 `1.10.0`，不是新发布。实际 tar.gz SHA-256：`b6503ce5fec34d08cdcfb77806695acd9bd440cbb26b43696aee708212652181`；未将二进制包塞入 Git。Linux 本地 Node `v24.19.0`，pnpm `11.21.0`；Windows/Ubuntu Actions 以各自 run 的机器记录为准。

`portable-smoke.mjs` 固定测试 coding-v1；其 50 项结果不能冒充 v2 结果。v2 由单独的 `coding-v2-hosts`、安装后 SDK/WASM 和安装后编码面板请求证明。所有 loopback/ScriptedModelProvider 路径均用于工程契约验证，不能证明真实模型会选择同样的操作。

安装后编码面板宿主 `installed-live/launch.json` 的 sourceSha、编译字节 digest 与面板 receipt 对应；宿主已正常退出，`host-exit.json` 为 code 0。日志中的取消清理降级来自取消测试；夹具位于非 Git 临时项目，Git scope 探测会报告降级。`[cache-diagnostics]` 的公共前缀和 toolsUnchanged 是实际序列化请求的观测，不是提供商 KV cache 命中。

## 任务基线及检索的限度

C2 主集的 24 项历史任务、48 次两侧执行见相邻 `historical` 归档：19 项旧侧断言 RED→GREEN、5 项经人工审查的缺失新增接口编译 RED→GREEN，修复侧全部 GREEN。任务21初版测试在两侧都绿，原件保留；换为实际新增关闭竞态反例后已重新执行两侧。历史主集仍是单项目回放，不是未见任务的真实模型成功率；这些历史任务未完成 Windows 资格测试。

第二仓库的 Python 补充集见 `python-upstream`：Hermes 固定快照、2 项明确标注的种子缺陷，修复侧 14/11 测试通过，缺陷侧 5/3 个真实断言失败；tracked/untracked 用户改动和固定验收文件 hash 在前后检查。该工具于 `6dadb047` 执行，原件保留真实 hostSourceSha；其脚本、目录和任务在最终源码未变。Python 3.12.14，完整冻结包版本见 `coding-evolution-upstream-python-frozen.txt`，使用上游 `scripts/run_tests.sh` 且关闭文件级重试。Python 环境路径需要指向 venv 的可执行链接，不能 realpath 成系统 Python。

独立 judge 应由宿主管理并固定测试工具链、配置/conftest、预期测试数量与变更审查。当前 oracle 文件 hash 防护不能保证任意可变测试基础设施免受规避，也不替代宿主对完整测试环境的信任边界。

检索测量只有 60 文件、4200 字节，运行在共享云主机上。原始 `coldMs.syntax` 是含 WASM 初始化的首次 AST 调用；`coldMs.relevantMap` 是 **共享 AST 已预热后的首次图调用**，不能当成独立冷启动图耗时。保留原始字段，不把微型集耗时当大型仓库 SLO，也不把 recall@5 当模型修复率。AST 关系报告 `semantic:false`，未实现 LSP 或代码 embedding 服务。

原有插件管理仍不完整，受限宿主没有强隔离时 PTY 会拒绝；本轮没有降低隔离要求。普通安装 UI 的 30 项和新增面板 12 项不是所有上游 UI 功能完全对齐的证据。VS Code URI 是浏览器手势打开文件的入口，未宣称已安装 IDE 插件或服务器成功启动了本地编辑器。

## 失败记录与修复

`prior-failures` 保留最终收尾期间的原始失败及反例，不用复验成功覆盖首次失败：

- Windows 后台摘要 IO 未等待关闭导致 ENOTEMPTY：已补取消/等待 drain（较早原件在相邻 `followup`）。
- 包依赖 `LICENSE-MIT` 漏识别：已修复识别，保留许可而非跳过许可门禁。
- 索引总字节预算、缓存来源/累计 footer 冲突：补真实边界回归，最终全量已覆盖。
- 字面 `%20` 编辑器文件名解码错误：先红后绿，43 项相关 Web/Runtime 回归通过。
- 完整 coverage 在 600 秒被门禁终止：完整 test/coverage 和相应产物收集改为有界 45 分钟，其他门禁仍 10 分钟、覆盖率阈值不变，82 项相关回归通过。`77c7c155` 的失败不是覆盖率低于阈值。
- 较早 Windows lease 端口占用、窄屏主题切换等待失败：原件及同源码复验保留，未通过更改 lease 或放宽权限掩盖。
- 最终 `4ee21776` 主 CI 第一次的 Windows 正式链路失败：原子替换文件持续 `EPERM`，已有约 5 秒/16 次重试达到上限，旧文件保留；原始文件哈希、完整错误和失败命令见 `coding-evolution-formal-windows-4ee21776-forensics-decoded.json`。[诊断分支工作流](https://github.com/ki11a-Conton/harness-agent/actions/runs/38707080798) 仅从 Actions 读取原始 artifact，观察者提交与产品源码不同；没有改产品代码、删除目标文件或吞掉错误。同一源码第 2 次完整尝试已通过，双平台产物来自同一 attempt。复验不证明系统持锁不会再次发生，既有有界失败与保留旧文件的行为保持可见，首次失败未改判。

## 重跑

以下命令须在干净的 **上述源码 SHA**、正常依赖/编译环境执行。不要在附加证据后的文档提交上宣称重现了同一源码。新建独立 worktree 可保留已有用户工作区。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:security
pnpm docs:verify
pnpm capability:audit
node scripts/research/coding-prompts-20261008/acceptance.mjs /tmp/replay-coding-v2 coding-v2
node scripts/research/coding-evolution-20261015/retrieval-measurement.mjs /tmp/replay-retrieval
python scripts/research/coding-evolution-20261015/historical-tasks.py validate
```

真实历史任务两侧重跑使用 `qualify-history.py --output <新目录>`，需要完整历史 Git 对象、pnpm 和项目依赖；会实际安装/构建，不是模型评测。第二仓库使用 `upstream-tasks.py prepare/verify --task ... --source-repo <包含固定快照的 HARNESS-SRC-FORK> --workspace <新目录> --receipt <宿主管理的外部路径> --revision seeded|fixed --python <venv/bin/python>`，具体任务及 bootstrap 固定在 `benchmarks/coding-repositories-v1/upstream-seeded.json`。

包验收使用 `scripts/release/portable.mjs build --repo <干净源码目录> --source-sha <上述SHA> --version 1.10.0 --out <新目录>`；随后运行 `portable-smoke.mjs` 和 `deepseek-installed.mjs`，参数见脚本的 usage/parseArgs。安装后工具重放：在源码根目录运行 `node <本目录>/installed-tools.mjs <已解压包根目录> <新receipt.json> <上述SHA>`。面板浏览器重放使用实际 `deepseek-live-host.mjs --root <新目录> --portable-root <已解压包>`，开启实施文档中的 opt-in 变量，再运行 `browser-acceptance.mjs --url <实际监听地址> --output <新目录> --fixture-root <夹具目录> --playwright-module <模块文件>`；需要 Playwright 和 Chromium。原始截图、编译字节表和请求均已归档。

`python <本目录>/verify-evidence.py` 只核对文件清单、字节 hash、源码关联和结果 receipt；它不重跑测试，也不代替真实模型配对评测。`inventory.json` 覆盖本目录除自身外的全部文件，包含验证脚本和本说明。
