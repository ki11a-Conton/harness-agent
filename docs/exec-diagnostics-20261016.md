# Coding 命令诊断反馈优化

基线main `bddf6f64` 已包含审查后修正的PR #8，GitHub确认为merged。此轮不改
Core策略或权限，优化真实命令失败后给agent的反馈。

## 问题与实现

进程捕获器按预算保留UTF-8前缀。Core虽已有head/tail预览和脱敏artifact，拿到
的也是这个前缀，无法恢复被丢掉的编译/测试末尾错误。保持原stdout/stderr、
退出码、状态和进程策略不变，在exec原有完整流回调上收集每路最多768字节的
尾部（不大于该路原捕获策略预算），仅对被截断的流附加diagnostics，明确标记
incomplete。两个尾部连同JSON字段可放入现有2000字节context尾部预览；零预算
不新增输出通道，未截断结果不增加字段。

没有直接写临时原始日志，输出仍由现有脱敏、注入检查和artifact owner处理。
原live回调得到同样的完整解码文本；回调失败不会丢掉已保留尾部。取消仍遵守
原契约省略output。工具元数据版本升至1.1.0，输入和执行权限不变。

UTF-8边界算法适配自pi的OutputAccumulator.trimTail，固定收集仓库
`1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`。完整MIT许可和Mario Zechner
版权已写入实现文件，并核对tsc输出JS保留全文；未复制pi的直接tmp落盘部分。
Codex的中间裁剪理念与本项目已有Core预览一致，此轮无需修改Core。

## 配对验收

真实TypeScript编译、Node语法检查、Node测试三种命令，在输出噪声超过两路
捕获预算后各自产生实际错误。子进程回执先确认确实因预期诊断失败，再检查
实际Runtime/Orchestrator链路中下一次provider请求的tool消息。只统计tool
消息，不从用户指令、工具参数或system文本寻找诊断。

| 指标 | 固定bdd exec基线 | 新实现 |
| --- | --- | --- |
| 实际失败命令数 | 3 | 3 |
| 下一次请求能看到最终诊断 | 0/3 | 3/3 |
| 每例provider请求数 | 2 | 2 |
| 每例回放tool消息字节数 | 4356 | 4356 |
| Vitest最终状态 | 3失败（预期反例） | 3通过 |

每路原捕获预算40KiB，噪声每路约100KiB，实际64KiB context阈值与head/tail
artifact路径均被触发。原始命令退出非0，未把turn结束说成编译/测试通过。
该受控provider验证诊断传递，不证明付费模型质量、真实仓库任务成功率或缓存
收益。真实编译诊断、最终框架状态、源码/许可哈希见[证据](evidence/exec-diagnostics-20261016/validation.json)。

相关工具/上下文/输出安全1062通过、12跳过；安全2146通过，类型检查通过。
完整clean源码验收与最终Windows/UbuntuCI在固定提交后执行并另记，不冒充通过。

## 验收期间追加的Windows夹具修复

原bdd安装UI工作流38875780426的Windows job116890674268失败。只读诊断
38877077457从原artifact12035232969提取RPC与DOM，确认session/create因子
owner兼容锁端口49684被占而返回HARNESS_DATA_DIR_IN_USE；不是日志前缀校验
异常。原失败保留，没有重新执行原CI。

安装夹具现在在打开浏览器前，通过真实session/create准备空白owner并持有
实际租约。仅新的验收目录明确IN_USE时，在关闭旧进程后选择另一个临时目录，
最多16次；不改产品端口、不绕过旧宿主检查、不重试任何UI/模型/任务断言。
一旦选定就保存目录记录，重启必须用原目录；损坏记录失败关闭，旧fixture的
已有历史也不会因为新模式被丢弃。产品遇到占用端口仍按原策略拒绝。

真实租约/TCP关闭次序与错误保留回归4项通过。工作树夹具+启动时编译应用字节
的三视口完整UI30场景75断言通过，预备owner模式的中英文实际断线/重启/读文件
10项通过，并核对两次launch.cwd一致。这些是本地fixture验收；最终安装归档
及真实Windows结果必须绑定新的实际源码，仍待远端验收。没有付费调用或release。

同一次bdd主CI的Ubuntu后续门禁内全量，另报gen1预算接管测试held-a屏障未到。
测试把B第一次删除（可能是正常解锁）都暂停，父进程却要先等A拿锁，产生测试
自身死锁。强制B先获得锁时，旧钩子确定复现同型失败并记录B实际活锁token；
仅暂停dead-owner回收后，两种调度都通过。另将“B被阻塞”的标记限定为读到
其他活owner，避免复用最初对dead-owner的旧EEXIST标记而过早释放A。
实际产品预算锁未改，6秒持有、10秒屏障、30秒锁和60秒用例上限均保留。
原钩子对照仍超时失败；在隔离测试子进程中故意使独占guard失效，会被实际
overlap=true断言抓住。该负对照不修改或输出弱化的生产模块。

复放：

```sh
# 预期退出1，3项失败：固定读取bdd的原exec实现。
pnpm exec vitest run --config scripts/research/exec-diagnostics-20261016/baseline.config.ts
# 预期退出0，3项通过：实际编译/语法/测试反馈进入provider请求。
pnpm exec vitest run packages/harness/src/exec-diagnostics.integration.test.ts
```
