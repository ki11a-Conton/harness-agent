# Transport 与官方前端独立审查

这是 2026-10-11 的局部工作树证据，源文件由 `manifest.json` 的 SHA-256 绑定。它证明真实本地 HTTP carrier/host transport 和冻结官方发布物的行为；**不证明生产 Harness 已接好所有默认 UI 控件，也不是 clean-source release 门。**

Host transport 新增 10 项检查，补修前 4 PASS / 6 FAIL，补修后 10 PASS。RED 原件保留。修复取消 request/stream 种类混用、已断连请求仍被 admit、取消错误标作 internal、Node Buffer 编码错形，以及循环/BigInt 诊断详情使错误报告自身失败；同时保证 stop 幂等且同一个 service 只 close 一次。

第二轮另增 2 项真实 RED：unary 结果含 BigInt 时，原实现已提交 HTTP headers，随后序列化失败却未结束 response，客户端一直等待；诊断对象的 `toJSON` 返回 scalar 时破坏严格 Remote error shape。现在先完整编码再提交 headers，非法结果可正常报告；诊断输出最终仍必须是对象。第二轮原件为 10 PASS / 2 FAIL，最终 12 PASS。`manifest.json` 的当前源 hash 绑定到第二轮最终 GREEN；早期未提交草稿的完整源码快照未单独归档，因此早期 RED/GREEN 报告保留观察结果，不能声称在当前修复源码上严格复算当时的 RED。

Browser carrier 有 8 项真实 HTTP 检查，包括 args/binary、拆分 UTF-8 的 NDJSON、错误帧、截断拒绝、uplink 顺序、取消及错误 HTTP 不得声称成功。它们使用隔离的 transport fixture，没有将 fixture 描述为生产后端。

官方发布物验证覆盖 67 个 npm tar、334 个逐字原发布文件、771 个冻结目录文件；默认 66 个动态 client。3,181 份单独的源码参考与固定上游 Git blob 全部核对通过。npm 无 gitHead，因此不声称发布物等于该源码提交。HTML/PWA 的适配明确记录，原始输入完整保留。

Vendor 有 7 项检查：完整离线重建，以及改官方 bundle、改 tar、改源码 archive、增加未登记文件、添加 symlink、改本地根 HTML 的拒绝。维护 seal 仍先核验全部原发布资产，不能把修改过的官方 bundle 冻结成原文件。

新增平台 HTTP 有 4 项真实 Harness stores + WebServer 检查：`/plugins/events` SSE 的首 graph 等于实际本地 boot manifest，66 个 bundle URL 均能实际读取；headless `/open-in-app/apps` 返回实际空 native-launcher catalog；两个 route 的 Host、Origin、cross-site 请求均拒绝；两个独立 SSE 在 host stop 后均有界结束。Host 攻击通过 `node:http.request` 发送，避免 Node fetch 规范化 Host 造成假探测。transport/platform 最终联合 16 PASS。

复算入口：

- `corepack pnpm exec vitest run apps/web/src/deepseek/transport.test.ts`
- `corepack pnpm exec vitest run apps/web/src/deepseek/platform-http.test.ts`
- `node --test scripts/research/deepseek-transport.test.mjs`
- `node scripts/research/deepseek-frontend-vendor.mjs --verify`
- `node --test scripts/research/deepseek-frontend-vendor.test.mjs`

完整 UI parity、生产 Harness 编程闭环、三视口、权限边界及 Windows/portable 仍需后续单独验收。付费模型调用 0；本记录没有模型质量结论。
