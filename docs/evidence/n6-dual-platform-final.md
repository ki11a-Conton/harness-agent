# N6 — 双平台最终验收

## CURRENT — 2026-10-01，DONE

验收实现提交 `ad66f62004ed5e59a71b32839f8a4dab05124818`，
[workflow 36797936842 / attempt 1](https://github.com/ki11a-Conton/harness-agent/actions/runs/36797936842) **completed/success**。
全部十项作业 success，包括双平台 verify、双平台 real formal、双平台 fixture loop、coverage、
cold-start、release attestation、同 SHA 双平台汇总。没有借用旧 SHA 的结果。

| 验收项 | Windows | Ubuntu |
| --- | --- | --- |
| 全仓测试（显式启用 N2 E2E） | 417 files；7673 passed / 2 skipped | 417 files；7664 passed / 11 skipped |
| producer 八个实际命令 | 全部 exit 0 | 全部 exit 0 |
| formal 原始证据 / 内容成功 | 24/24 verified；12 content successes | 24/24 verified；12 content successes |
| MEASURED 预算 / tools | 60 calls；1080 tokens；12 dispatch；24 coverage | 60 calls；1080 tokens；12 dispatch；24 coverage |
| 内容四变体与六项身份反例 | 全部符合预期；反例 0 calls | 全部符合预期；反例 0 calls |
| 三个 offline readiness levels | PASS / PASS / PASS | PASS / PASS / PASS |

下载两平台 artifact 后，在新的本地路径运行两个 formal --verify 及现有 dual-platform
--strict 重验，全部 exit 0；strictGatePassed=true，unmetRequiredLevels=[]。
所有 ZIP SHA-256 均与 GitHub 公布 digest 相同：

- Windows artifact [11134872725](https://github.com/ki11a-Conton/harness-agent/actions/runs/36797936842/artifacts/11134872725)
- Ubuntu artifact [11135355694](https://github.com/ki11a-Conton/harness-agent/actions/runs/36797936842/artifacts/11135355694)
- dual artifact [11135895474](https://github.com/ki11a-Conton/harness-agent/actions/runs/36797936842/artifacts/11135895474)

完整 digest、作业 ID、身份与实测数字见 [n6-final-ci-attestation.json](n6-final-ci-attestation.json)。
paidExperimentRun/championPromotion 仍 NOT_RUN，因此原始全五层 overall=NOT_PROVEN；
N6 要求的三个离线层均 BOTH_PASS，strict gate 已通过。实验统计 decision 仍 REJECT，不能 promotion。
Windows 规范长路径修复后实际成功构建、加载两臂；历史失败及其 raw artifacts 保留在下文。

本报告固化上述实现 SHA 的验收，不把后续文档提交伪装成该 SHA。
后续分支最新提交的 CI 可从[分支运行列表](https://github.com/ki11a-Conton/harness-agent/actions?query=branch%3Acodex%2Fcomplete-handover-n5-n6)读取。

## Historical — 接线与首次验收过程

**接线完成；最终同 SHA GitHub Actions 结论待收。** 不声明 Windows/Ubuntu 已完成。
本轮基线为 42ae7c2；它的旧 [workflow](https://github.com/ki11a-Conton/harness-agent/actions/runs/36731649499)
已 completed/failure。Unit tests 的两个失败原因是历史 candidate 在浅克隆中缺失，以及
N3 temp-cleanup 的 empty catch；本轮已修复。旧 workflow 的 fixture join 成功只能证明
当时 fixtureProtocolReady，不能代替新增真实层要求。

## 实现

- 新增 real-formal-offline matrix，两平台 node 22、完整 git 历史、frozen-lockfile 安装。
- n6-real-formal-ci.mjs 执行并记录实际 typecheck/test/build 退出码；pnpm test 显式启用 N2
  release CLI E2E，四个原始 frozen verifier verdict 必须成功。
- fixture 与真实 formal 各保留独立 raw bundle；真实 bundle 先通过 N5 strict gate，再转换
  identity/schedule schema。每个 manifest/verifier/security/activation 和两个 journal 字节保留，
  调用现有 A6/readiness verifier 重算所有原始数据；没有从报告字符串导出 readiness。
- runId/attempt/platform 来自本次 workflow；SHA 来自本次干净 checkout，额外与 GITHUB_SHA
  比较。根路径存为 repo-relative，下载后 artifact-relative 解析，不记录不可迁移绝对路径。
- 双平台 join 要求三个 offline levels，同 SHA/run/attempt 且两个平台各自匹配；最终 failure
  step 同时检查 verify、coverage、旧 fixture loop、real-formal matrix 的真实 job 结果。
- paidExperimentRun / championPromotion 始终 NOT_RUN；producer 不创建付费授权。

## 已完成的本地证据

| 项 | 已测结果 |
| --- | --- |
| N5 real formal，driver a13ad35 | strict gate + 独立 --verify exit 0；24/24 raw records，12 实际内容成功 |
| 内容矩阵 | 两个用例 × 两臂；correct passed，empty/wrong/skipped failed |
| 预算 | 60 MEASURED 请求、1080 tokens、12 tool dispatch、24 coverage；delta 0 |
| release CLI E2E | 四次内容 verifier 成功；真实 write_file settlement |
| N6 adapter regressions | 两项通过；raw manifest bytes 不变，A6 重验2/2，旧 SHA 与内容篡改拒绝 |
| N5/provider/pair/gate + N6 定向套件 | 44 passed，1 historical comparison skipped |
| 全仓验收，driver 6a9b7ef | **417 files passed；7663 tests passed / 11 skipped**；pnpm test 显式启用 N2 E2E；375.93 s；exit 0 |
| typecheck / build，driver 6a9b7ef | **exit 0 / exit 0** |
| docs:verify / docs smoke | **全部 PASS / 4 passed** |
| N6 producer，driver 6a9b7ef | typecheck/test/build/fixture/pair/arms/formal/readiness **八个命令 exit 0** |
| 本地 readiness | fixtureProtocolReady / realBuildOfflineReady / budgetEvidenceReady **分别 PASS**；paid/promotion NOT_RUN |

原工作区第一次 full pnpm test 得 7659 passed / 1 failed / 12 skipped。
唯一失败是 R55 owned cleanup 留下空目录；同一个原始测试在隔离 worktree 全套 65/65 通过，
原工作区只选真实 chain 用例也通过。没有删测试或放宽 cleanup 断言。
最终全仓检查使用干净隔离 worktree，已 completed/exit 0。原工作区第一次失败保留为历史，不改写为通过。
本地 raw bundle 和命令日志保存在 `.ci/n6-local-acceptance/`；runId 为 local-n6-20261001，
仅是本地验收身份，不是 GitHub workflow run。

## 同 SHA 收证入口

```bash
node scripts/e4/n6-real-formal-ci.mjs --platform ubuntu --run-id <actual-run-id> --attempt <actual-attempt> --out .ci/n6-real-formal
node scripts/e4/dual-platform-acceptance.mjs --windows <windows-artifact>/ci-readiness.json --ubuntu <ubuntu-artifact>/ci-readiness.json --run-id <actual-run-id> --attempt <actual-attempt> --expect-sha <actual-driver-sha> --require fixtureProtocolReady,realBuildOfflineReady,budgetEvidenceReady --strict --out .ci/dual/verdict.json
```

本地 run id 必须明确标为 local；不能伪造 GitHub run。
最终 CI URL / run / attempt / artifact：**尚未收回**。

## 发布授权

首次推送因缺少明确授权被自动审批拦截；用户随后已明确授权继续推送。
最终 GitHub 双平台结果仍待实际 workflow 完成后收证。

用户授权后的首次发布尝试曾受连接配置阻塞：命令行 git 缺少 HTTPS 登录凭据，
GitHub 接口 create-tree 返回 403。用户随后提供本次推送凭据，分支已成功发布。
首次触发的 workflow 为 [36795341364](https://github.com/ki11a-Conton/harness-agent/actions/runs/36795341364)，
SHA 为 112a6170737767454378366c856d6695cb79b362。该运行仅作发布证据，不能提前记作验收通过。
后续最终提交的 workflow 须从[分支 CI 列表](https://github.com/ki11a-Conton/harness-agent/actions?query=branch%3Acodex%2Fcomplete-handover-n5-n6)
获取，并按当前提交 SHA 完整收证。当前状态为 CI_PENDING，已无发布权限阻塞。

## 首次新增 formal CI 失败与修复

run 36795418445 / bfe404e 的 Ubuntu 与 Windows formal 作业均在 formal 步骤失败；
全仓测试、typecheck、build、fixture、pair、arms 步骤已实际通过。
Ubuntu artifact 11132914340 保留原始日志：observer 生成随机 r97-arms-* 目录，
formal 却读取 r97-arms-r5pair，因而报告两臂不存在。本地既存固定目录曾掩盖此依赖。
修复为导出并共享 R5_ARM_ROOT，observer 显式 --root，与 formal 读取路径一致。
原始失败不改写为通过；修复后的最终同 SHA 双平台结果仍须新 workflow 收证。

## Windows 不完整 build 的后续防护

run 36796373370 / ee73bd1 的 Windows artifact 11133728976 显示：固定目录中的两臂
存在且干净，但 pnpm build exit 0 后缺少 packages/evaluation/dist/index.js，加载失败。
observer 现在执行 pnpm build --force --verbose，保留项目编译诊断，并逐项检查声明的
R97_ARM_BUILD_ENTRIES；缺少任意入口即 ARM_BUILD_INCOMPLETE，不再凭 CLI 存在宣称 ready。
producer 在全仓测试前准备两臂，尽早报告 setup failure。最终 CI 结论仍待新运行实测。

run 36797374328 / a2fe383 的 Windows setup 提前拒绝：artifact 11133779901 证明编译器
列出了所有项目并强制重建，但 evaluation/dist/index.js 仍未出现。当前进一步将 TEMP
的 RUNNER~1 短路径规范化，避免编译输入与 workspace junction 的别名混用，并保留
Windows --listEmittedFiles 和缺失文件的目录诊断。此修复的有效性须由后续 CI 验证。
