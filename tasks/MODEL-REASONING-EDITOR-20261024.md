# 模型规格编辑器修复

用户提供 Harness 当前页面与 DeepSeek Harness 的两张参考图，要求复用上游模型编辑器，修复 JSON 文本框和字段排版，并让推理等级开关、档位及 API 参数值实际生效。

按 [计划](../plan(20261024-model-reasoning-editor).md) 执行。最新 main 基线 `37a16e3d0ac60da12caff5e28c77a20c8a017e2e`；独立工作树实施。上游新组件来自 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，保留 MIT 许可与来源。

范围为模型表单、衍生资产、Web 模型配置/请求适配和验收。Runtime 冻结；副作用继续经过原 ToolOrchestrator、PermissionEngine、SandboxManager、Verification。旧发行标签、资产、工程档案及其它工作树保持。只用原生 Git/HTTP，不用 GitHub 连接器，不触发付费模型，不创建子 agent。本任务修复源码，不改写 v1.12.0 发行包。

完成需要实际浏览器红绿、保存与重开、取消/校验、两种 off 语义和 max→xhigh 的真实请求、响应式/明暗主题检查、相关测试/类型/安全与干净源码验收。不能仅按控件存在或截图判定后端生效。
