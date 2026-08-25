# HANDOVER

面向批次交接的机器可推导状态速览。此文件中的数值声明由
`docs:verify`（apps/cli/docs-verify.ts）对照仓库磁盘事实校验，任何与事实不符的
声明都会让 docs 门禁 fail-closed。

## 状态速览

packages/（24 个包）已完成；
测试基线 4846 passed / 0 failed。

## 仓库结构

- `packages/` — 核心库、合约、运行时、安全、事件、网关等 24 个以
  package.json 自描述的工作区包。
- `apps/` — CLI、桌面代理等宿主应用。
- `.ci/` — CI 基线捕获与发布证据。