# Windows 编码验收证据与临时目录清理

继续执行 [大仓库优化计划的 2026-10-28 跟进](../plan(20261027-large-repository-harness).md)：保留真实 managed command 的原始 5 秒 job / 10 秒 turn / 15 calls 预算和全部业务断言，补充执行结果、投影一致前缀与失败日志；修复 context wiring 测试自建临时目录的短暂 Windows `EBUSY`，关闭该配置测试无需执行的版本探测。生产执行、权限、沙箱、验证与投影逻辑不变，不将缺失原 outcome 的历史失败声称为根因已证实。
