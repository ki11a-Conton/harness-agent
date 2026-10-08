# Harness Agent：第一代当前执行计划入口

当前任务：[第一代实现与验收规格](plan(20261008-024527).md)，任务合同：[GEN1-20261008.md](tasks/GEN1-20261008.md)。做什么、怎么做、怎么验收见规格 G1–G11。原执行入口完整保留在 [plan(20261008-before-gen1).md](plan(20261008-before-gen1).md)。

当前状态：六路源码比较与修复已收尾，产品源码固定为 `c5bbe61fef101a8c9eb10edab673be8b2e0935e3`。本地全量9284 PASS / 0 FAIL / 14 pending，CLI/Web、浏览器、原生Windows和同一独立包安装已通过；完整CI10jobs、安装CI4jobs、原生WindowsCI1job均已completed SUCCESS。[最终验收与原件](docs/gen1-final-acceptance.md)。G1–G11及公开发布已完成，main已推送；[v1.9.0 正式发布](https://github.com/ki11a-Conton/harness-agent/releases/tag/v1.9.0)的tag/资产绑定上述验收源码，公开无认证下载校验通过。真实模型质量仍为 NOT_PROVEN；历史 N7/冠军实验不改写。
