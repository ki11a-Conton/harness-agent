# 第一代独立分发与发布审查

本轮基线为 `22d97d860cfa1001df578b1193b3bc4c8ee1bce1`。第一代发布版本为 `v1.9.0`；版本写入独立资产的 manifest，不把 27 个历史 workspace package 的 `0.1.0` 改成新版本，也不改冻结实验输入。

## 与工作区参考源码的差异

| 实际读取的参考文件 | 参考实现的有用做法 | 基线 Harness 缺口 | 本轮实现 |
| --- | --- | --- | --- |
| pi `packages/coding-agent/package.json`、`scripts/local-release.mjs`、`scripts/release-packages.mjs`，MIT | 明确 `dist`/types/bin/files/资产清单；在仓库外安装真实 tarball，用普通 Node/Bun 执行；Windows shim 单独处理 | `@ar/cli` 指向 dist，但依赖为 `workspace:*`；没有可独立使用的打包资产；编译产物仍含测试文件 | Git 固定源码快照重新安装冻结依赖、重新构建；打包普通 JS、声明及完整运行依赖，排除测试/调试 map；跨平台 Node 启动器 |
| DeepSeek Harness `scripts/release/pack.ts`、`verify-packed-install.ts`、`installed-product-isolation.ts`，MIT | pack 是固定源码到固定字节的发布边界；仓库外验证 payload 与依赖闭包；去除宿主 `NODE_PATH`/`NODE_OPTIONS` | Web 默认从 dist 相邻 public 读取资产，单独拷贝 dist 会丢失 UI；旧 workspace 链接可掩盖缺少依赖 | 包内保留 `@ar/web/public` 和所有第三方许可；验证每个文件 hash；在临时目录解包并驱动真实 CLI/Web/HTTP/工具/验证流程 |
| pi `scripts/local-release.mjs` 的可选独立二进制、DeepSeek 的 npm package families | 发布集和安装目标可以有多种形式，但先验证实际消费路径 | 无 native/Bun 单文件二进制基础设施；没有自有 npm 包发布要求 | 第一代使用通用 `tar.gz`：依赖 Node >=22.19.0，启动不需要 pnpm、npm、Git 或仓库。项目自身的 Git/构建/测试依赖仍需用户安装 |

这里复用了成熟的发布边界与独立消费验收方法，未把参考项目整套 npm/二进制/桌面发布系统引入 Runtime。新脚本只使用 Node 内建模块。既有移植代码的许可证随资产分发。

## 已复现并修复的发布完整性缺陷

在基线 `apps/cli/src/release-artifacts.ts` 的真实 collector 上，用依赖注入让四个失败条件分别发生，得到四个错误的 `produced=true`：

1. 覆盖率命令失败，但读取到旧 `coverage-summary.json`，把旧数据当本次成功结果。修复在本次运行前删除旧 summary，检查运行失败，并验证新 summary 的四类覆盖率结构。
2. adversarial 命令失败，但失败消息含 `adversarial`，布尔表达式仍判成功。修复以失败标记优先拒绝，不用 suite 名字证明命令成功。
3. stress 命令失败且错误含 `stress`，同样误判。采用相同修复。
4. 仅保存 `.github/workflows/ci.yml` 就标为 `ci-results` 已产出，实际上未执行双平台 CI。现在文件只作为流程定义归档，明确 `produced=false`；正式验收继续使用既有、绑定源码 SHA 与实际运行结果的 release gate evidence。

对应回归在 `apps/cli/src/release-artifacts.test.ts`。没有降低 `release verify` 的原门槛，未把 portable smoke 冒充双平台全套证明，也不把空 champion manifest 冒充模型质量晋升。

### 同一持久化目录的产品 host 所有权

另外用两个实际 Harness host 同时打开一个 `HARNESS_DATA_DIR` 复现持久化审批丢失：两个进程各自加载空 snapshot、各自写入审批，后者覆盖前者，最终只剩 `approval-b`。SQLite 单表事务无法保护另一个 JSON snapshot store 的跨进程语义。

产品入口现在需要先取得 `apps/cli/src/data-dir-lease.ts` 的目录所有权，再加载任何 stores。先 `mkdir`/`realpath` 规范路径（Windows 保守折叠大小写），以规范目录 SHA256 选择固定高端口，在 localhost 建立排他 listener。占用、哈希碰撞或已有其他服务均明确 fail closed，不试随机端口绕过。CLI 正在执行时 `ref()`，Web HTTP listener 启动后独立持活；finally/shutdown 释放，进程崩溃由 OS 自动回收，不留需要猜测 PID/时钟的陈旧 lock file。

此约束适用于同机、同 network namespace 的 CLI/Web 产品入口，保护本地单写 snapshot stores。SDK contract 不改；跨机器/NFS 或网络 namespace 不共享的写入不受该机制保护，应使用独立数据目录。多个 CLI/Web 同时运行也使用不同目录。测试用真实两个 Node 子进程证明 contender 在写入前被拒绝、已有文件未改变、正常释放/SIGKILL 后可恢复，以及 symlink/Windows case alias 和已有服务占用行为。

### A：真实 Web follow-up 的异步 admission 丢失唤醒

真实浏览器验收记录了 `05:31:33.700` 前一任务完成，`05:31:33.817` 后续输入持久化完成，但该输入没有运行；直到 `05:31:48.923` 一个新任务先执行，`05:31:49.090` 旧后续输入才被唤醒。持久化 `admit()` 等待期间，actor 已经 settle，post-turn drain 观察到空队列。原 `enqueueFollowup()` 返回后没有通知 idle actor，输入因此停留到下一任务来临。

`packages/core/src/runtime/session-actor.ts` 现在在 admission 完成且 actor 仍开放后通知 drain；正在结束的 drain 保留一位由新 admission/成功 terminal ACK 触发的 wake。`startTurn(onConflict=queue)` 先注册未来 outcome，再触发 wake，返回值仍保留文档约定的原运行 turnId；实际 outcome 属于新 follow-up turn。成功 durable ACK 清除 reservation 后再唤醒剩余输入，避免连续队列也停在旧 reservation。

同一故障窗口还证明持久写入先可见、admit Promise 后返回时，首次 hydration 会提前捞出同一 prompt，造成重复入队和 deferred 尚未注册的竞态。队列以同一个 promptId 跟踪未确认的 admission，hydration 排除这些身份；只在 admission 成功、local entry 发布之后解除排除。write-then-error 不在当前 actor 执行，保留给重启的持久状态恢复。close/unload 跨过 await 后拒绝原 caller，关闭 actor 不执行新 follow-up。

这属于确定性的 Runtime 正确性修复，不重写 single-owner、promotion/bind/consume、权限或恢复预算。`gen1-followup-wakeup.regressions.test.ts` 使用真实 Runtime 与 gated inbox/reserve 明确控制顺序：旧代码首批 7 项为 1 通过/6 失败，另一个 write-then-error guard 单独复现失败；修复后新增 8 项覆盖 idle/flight wake、正确 future outcome、唯一 prompt→turn、close、失败 admission、三条 FIFO 与 `maxActive=1`。既有 crash/recovery/race 断言保留；20 个只为后续手动故障注入而预填 idle 队列的 fixture 改用 raw `inputQueue.enqueueFollowup()`，不再误用会自动推进的产品 API。没有添加调用方 sleep 或依赖下一条用户消息。

## 交付资产与完整性

`scripts/release/portable.mjs build` 要求明确完整 HEAD SHA、明确版本和清洁源码 commit。从不可变 Git blobs 在仓库外生成源码，忽略调用者 checkout 内的旧 dist、忽略的源码和 node_modules，然后执行冻结 lockfile 安装及全量 `tsc -b --force`。没有“沿用旧 build”的选项。

资产包含：

- `harness-agent-1.9.0-portable.tar.gz`：`agent.mjs`、POSIX/CMD/PowerShell 启动器、所有 `@ar` 运行包、zod/zod-to-json-schema 运行闭包和 Web 静态资产。
- `PORTABLE-MANIFEST.json`：发布版本、source SHA、Git tree、构建版本、历史 package 版本、外部依赖版本和每个文件的 SHA256/长度。
- `SHA256SUMS` 与 `BUILD-RECEIPT.json`：实际 archive 字节和来源的摘要。
- prompt、文件工具、Web vendor 及外部依赖的许可。根项目当前没有声明整体许可证；`PROJECT-LICENSE-NOTICE.txt` 如实说明，未擅自替项目授予许可。

普通 startup 在导入产品代码前校验 manifest。解包器只接受 ustar 普通文件，检查 checksum、终止块、重复大小写路径、Windows 保留名称和目录穿越；拒绝 symlink/hardlink 等 entry，只能写入空的真实目录。整个 archive 先校验，再写文件。SHA256SUMS 的来源仍需要来自可信发布页面，它不是签名。

## 命令与验收

固定源码 commit 后，在仓库根执行；`<SHA>` 必须是当前完整 `git rev-parse HEAD`，输出目录应当不存在：

```text
node --test scripts/release/portable.test.mjs
pnpm exec vitest run apps/cli/src/release-artifacts.test.ts
node scripts/release/portable.mjs build --out /tmp/harness-gen1-assets --version 1.9.0 --source-sha <SHA>
node scripts/release/portable.mjs verify --archive /tmp/harness-gen1-assets/harness-agent-1.9.0-portable.tar.gz --out /tmp/harness-gen1-unpacked --version 1.9.0 --source-sha <SHA>
node scripts/release/portable-smoke.mjs --archive /tmp/harness-gen1-assets/harness-agent-1.9.0-portable.tar.gz --out .ci/gen1-installed --version 1.9.0 --source-sha <SHA>
```

`build` 可加 `--offline --store-dir <已有 pnpm store>`，不改变固定源码/依赖/重建要求。Windows 输出目录使用相应绝对路径；参数经 Node argv 传递，不交给 shell 拼接。

`portable.test.mjs` 验证二进制字节 round-trip、确定性 archive、路径穿越/重复/坏 checksum/链接/截断拒绝、目录不覆盖、manifest 文件篡改/额外文件/错误来源拒绝，以及固定 Git blob 排除旧 dist/忽略源码、拒绝 dirty 或错误 HEAD。

`portable-smoke.mjs` 校验实际 archive 与发布 checksum，在仓库外解包，去掉 Node 注入环境，验证 `--version` 和 doctor，再用解包后的实际应用驱动既有本地 HTTP 编码验收：CLI/Web、审批、文件修改、命令、失败验证后的修复、历史/事件、重启与后续任务。最后实际篡改 Web 文件确认拒绝，再恢复并重新校验。receipt 包含实际 source SHA、archive hash、平台、断言、零付费调用和 `realModelQuality=NOT_PROVEN`。

上述独立安装 gate 加入 `gen1-acceptance.yml` 的真实 Ubuntu/Windows matrix。两个构建腿通过后，额外的原生 Windows 消费腿下载 Ubuntu 构建的同一个 tar.gz，不安装 pnpm、不重建，直接执行独立编码/doctor/篡改反例并记录实际 archive hash。正式发布选择该 Ubuntu archive，避免把不同平台各自构建的字节当作同一资产已验收。它是第一代分发验收；全量/安全/协议/coverage/既有 release attestation 和真实模型质量分别报告，不相互替代。
