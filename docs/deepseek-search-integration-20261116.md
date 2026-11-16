# 多语言搜索实际接线

本轮从官方 DeepSeek Harness `39163dd30f703a79079e2d2446545cff3c453738` 移植 `util/text-search`，保留原始 MIT 源码与 fuzzysort 4.0.2 源文件/许可于 `third_party/deepseek-text-search/`。PROVENANCE.json 固定源码及 npm integrity。没有增加运行时网络或安装依赖。

`generate-text-search.mjs` 用现有 TypeScript 编译器去除类型并包装两个模块，生成独立、无开发运行时依赖的浏览器工厂。`web-search-ui.mjs` 在既有可重建 UI 派生流程中接线；原 npm 发布 bundle 不修改。每个客户端模块分别持有自己的查询状态，未引入全局可变 catalog。来源哈希和许可证也随安装包公开资源交付，Windows checkout 保留来源原字节。

- 模型菜单：按 provider 保持分组；模型 name/id 模糊匹配、描述仅连续子串。组数据改变时重建索引，query 改变复用已有索引；键盘确认提交准确 model ID。
- 命令菜单：命令名称及本地化 label 用模糊匹配、描述用连续子串；选择弹窗保持原 substring/fuzzy-label 策略和分组/当前值，不把普通 substring 选项扩大为任意 fuzzy。
- 工作区搜索：名称和可读项目标签支持多词/中文匹配，路径是连续子串；索引跟随不可变列表与工作区快照更新。空白/归档可见性、最近使用顺序、内容结果合并和去重仍由原逻辑决定。

原已移除的插件/预设页面继续不注册。本轮没有改变 coding 策略的默认值；`HARNESS_AGENT_PROMPT` 未配置时仍是 legacy，显式 coding-v1/v2 继续遵循原配置指纹与会话冻结，相关真实接线回归已运行。

重建与验证：

```sh
node scripts/research/generate-text-search.mjs --check
node scripts/research/web-branding.mjs
node scripts/research/deepseek-frontend-vendor.mjs --seal
node scripts/research/deepseek-frontend-vendor.mjs --verify
```

新增模块/实际过滤函数回归进入全量测试及真实 Windows 专项；安装版 `deepseek-installed.mjs` 强制执行新增 12 项浏览器搜索验收，绑定从已校验安装包取到的三个资源哈希。检查设置真实提交、目录增删改、键盘选择后的模型 HTTP、全角计划指令回执、中文多词会话导航、中英文亮暗及窄屏和错误/外部请求。未通过时该安装验收失败，不能用单独模块成绩替代。

开发证据与完整验收索引见 [证据](evidence/deepseek-search-20261116/README.md)。
