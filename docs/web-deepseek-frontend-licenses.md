# DeepSeek Web 前端许可证与来源审查（2026-10-08）

本次迁移采用 npm 官方发布的 `@deepseek-ai/dsh-web-frontend@0.2.1-alpha.1` 原始产物，以及 66 个客户端工厂包，共 67 个压缩包。67 包均声明 MIT 并附 `LICENSE`；原始 tar 的 SHA-1、SHA-256 和 npm SHA-512 integrity 已独立重算通过。公开资产中的 126 个 frontend 文件与该 npm 包 `dist/assets` 逐字节一致。

源码审查固定于 `deepseek-ai/deepseek-harness` 的 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。**67 个 npm 发布记录和包内清单均没有 `gitHead`；不能宣称这些发布物来自该提交，也不能将该提交的锁文件当作发布物原始编译闭包。** 版本号相同和文件局部匹配不能填补这一证据缺口。

## 已保存的审查材料

所有随附材料位于 [public/deepseek/licenses](../apps/web/public/deepseek/licenses/)。原始压缩包由迁移主体保存在 `public/deepseek/tarballs/`。

| 材料 | 文件与作用 |
| --- | --- |
| 67 包身份、版本、tar integrity、MIT 原文 hash | [published-packages.json](../apps/web/public/deepseek/licenses/published-packages.json)、各包目录的 `package.json` 和 `LICENSE` |
| 原始 registry 字段 | [published-package-registry-metadata.json](../apps/web/public/deepseek/licenses/published-package-registry-metadata.json)；含补入的 `dsh-client-ui-directory-picker-browse` |
| 正式 frontend 资产 | [frontend-asset-hashes.json](../apps/web/public/deepseek/licenses/frontend-asset-hashes.json)，126 文件 hash |
| 固定源码审查参考 | [upstream-source-reference/index.json](../apps/web/public/deepseek/licenses/upstream-source-reference/index.json)；17 文件全部与上述 Git 对象吻合，含 `pnpm-lock.yaml`、Vite/客户端 tsdown 配置、包清单、图标清单、第三方通知生成器 |
| 正式发布物中保留的嵌入通知 | [bundled-notices/index.json](../apps/web/public/deepseek/licenses/bundled-notices/index.json)，PDF/表格模块开头的完整原始注释；另存 7 份资产中的 32 条许可/版权注释 |
| 隔离重建参考 | [shell-reference/packages.json](../apps/web/public/deepseek/licenses/shell-reference/packages.json)、`package-lock.json`；331 个锁定依赖、252 个本机安装包、249 份 root notice 文件。此处包含构建工具和平台可选项，**不代表正式 npm frontend 的原始构建闭包** |

源码参考归档另见 `public/deepseek/sources/upstream-client-reference.tar.gz` 和 `provenance/source-reference.json`。保存 source notice、配置和归档用于追溯；不会把这些源码材料冒认为 npm 原始发布证明。

## 字体

[font-inventory.json](../apps/web/public/deepseek/licenses/fonts/font-inventory.json) 记录全部实际字体 hash 和直接解码的 name 表。正式目录有 62 个独立文件：20 TTF、20 WOFF、22 WOFF2，其中 59 个 KaTeX 和 3 个 Montserrat。第 60 个 KaTeX 字体 `KaTeX_Size3-Regular.woff2` 以 3624 字节内嵌在 `vendor-BNsW4eBh.css`，与隔离安装的 KaTeX 字体完全一致，SHA-256 为 `73d591271b1604960cb10bb90fee021670af7297017e0e98480b332d11f51995`。

| 字体或软件 | 许可与证据 |
| --- | --- |
| Montserrat Light / Regular / Medium，version 9.000 | SIL OFL 1.1；[Montserrat-OFL.txt](../apps/web/public/deepseek/licenses/fonts/Montserrat-OFL.txt) 与 npm dist 及上游原文一致。实际字体 copyright 为 2011 Montserrat Project Authors，随包 OFL 头为 2024 Montserrat.Git Project Authors；两者均保留 |
| KaTeX 字体 | SIL OFL 1.1；实际 TTF/WOFF/WOFF2 nameID 13 含 Design Science 2009–2010、Khan Academy 2014–2018 的版权及对应 Reserved Font Name。见 [KaTeX-fonts-OFL-1.1.txt](../apps/web/public/deepseek/licenses/fonts/KaTeX-fonts-OFL-1.1.txt) |
| KaTeX 软件 | MIT；[KaTeX-software-MIT.txt](../apps/web/public/deepseek/licenses/fonts/KaTeX-software-MIT.txt)。该软件许可不能替代字体 OFL |

KaTeX 字体通知逐字保留实际 TTF 元数据中的 12 个 RFN：`KaTeX_AMS`、`KaTeX_Caligraphic`、`KaTeX_Fraktur`、`KaTeX_Main`、`KaTeX_Math`、`KaTeX_SansSerif`、`KaTeX_Script`、`KaTeX_Size1`、`KaTeX_Size2`、`KaTeX_Size3`、`KaTeX_Size4`、`KaTeX_Typewriter`。完整标准 OFL 1.1 正文从随附 Montserrat 文件复用；文件明确注明此方式，没有把 Montserrat 版权头用于 KaTeX。字体几何和名称没有修改。

## 品牌图标

[icon-inventory.json](../apps/web/public/deepseek/licenses/icons/icon-inventory.json) 记录实际 bundle 中的匹配路径、Simple Icons 16.31.0 元数据、来源 URL、逐项许可、变化说明以及独立 SVG hash。[icons/README.md](../apps/web/public/deepseek/licenses/icons/README.md) 提供全部 56 项的可读归属表。33 个 `SiteGlyph` 图标和 23 个 code-file 图标的路径均与该版本 Simple Icons 完全相同，并且全部存在于正式 npm/public JS。

Simple Icons 包级代码/数据声明 CC0-1.0，但其 [DISCLAIMER.md](../apps/web/public/deepseek/licenses/icons/simple-icons-DISCLAIMER.md) 明确指出这**不使所有品牌图标成为 CC0**。以下个别条款已保存完整标准文本，GNU Bash 保存了元数据指定提交的原始 MIT 原文与版权头：

| Code-file 图标 | 个别条款 |
| --- | --- |
| Angular、Solidity | CC-BY-4.0 |
| Git | CC-BY-3.0 |
| PHP、R、Rust、Zig | CC-BY-SA-4.0 |
| Ruby | CC-BY-SA-2.5 |
| GNU Bash | MIT |

上游 `SiteGlyph` 使用 `currentColor` 替代品牌 fill；code-file 图标保留匹配路径并增加背景、缩放及部分颜色变化。清单保留这些变化说明、来源及原始匹配 SVG。对应许可文本的下载 URL、固定 SPDX 数据版本和 hash 见 [license-text-sources.json](../apps/web/public/deepseek/licenses/icons/license-text-sources.json)。

## 第三方软件通知与剩余证据缺口

正式目录保留上游完整 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和所有发布物内已有通知。该上游第三方文件只声明 **direct** 依赖，并包含整仓库的可选 CLI/SDK/原生软件，不是本次浏览器的精确依赖闭包。其 hash 为 `a8879c4c694423f0837acc8234150b286643ad3112a792448a1448ce21a12d64`，已核对来自固定源码。

`client.pdf.js` 内的完整 943 行通知涵盖 PDF.js Apache-2.0 以及随嵌 CMap、standard font、wasm 的各自条款；`client.excel.js` 完整 311 行通知保留 FortuneSheet、ExcelJS、XML/CSV/ZIP/XLS 等声明。另存 bundle 中 DOMPurify 等实际许可注释。MIT 一方许可证不会替代这些第三方条款。

本审查已补保存已识别的许可与来源，以下事项仍未得到充分证据，不能据此宣称“完整发布闭包许可已全部核验”：

1. npm 缺少 `gitHead` 和原始构建清单/锁文件。固定源码锁文件、Vite/tsdown 输入配置与 npm 包清单是参考证据；隔离 shell 重建的 lock 也不能证明正式发布物的原始 transitive 闭包。
2. 33 个 SiteGlyph 和 14 个匹配 code-file 品牌图标，共 47 项，Simple Icons 元数据未提供个别许可或版权字段。已保存其来源 URL 与 SVG，但不能从缺字段推定为 CC0。9 项有个别许可的匹配图标，元数据也没有作者/版权字段；GNU Bash 原始许可已补充其实际版权头，其他项仍需品牌原始来源补足作者归属证据。
3. 剩余 25 个 code-file 图形没有本次精确 Simple Icons 路径匹配。已保留上游 artwork 与 manifest；`internal-design-export` 标签不足以独立确认全部图形的来源。名单见 `icon-inventory.json`。
4. 隔离 shell 锁文件有 79 个本机未安装的平台可选依赖，5 个本机 native 构建包未附 root license 文件；清单明确标识，未把这些参考输入误报为正式浏览器已分发软件或已核验完整原文。

验证仅涉及来源、字节和许可通知；不会凭这些结果宣称完整 UI parity、后端接线、模型效果或发布验收通过。

## 2026-10-11 独立字节复核与冻结

新的 `public/deepseek/provenance.json` 冻结 771 份目录文件。67 个原 npm tar 的 SHA-1、SHA-256、SHA-512 integrity、包身份和 MIT 原文再次独立验证；334 份原发布文件共 33,142,095 字节与 tar 逐字一致，包括全部正式 JS/CSS、字体、图像、动态 client 及包内身份/许可证。

本地 HTML 和 PWA manifest 适配了入口路径与产品标题，因此不称其逐字未变。原 npm 输入另存 `provenance/published-frontend-index.html` 和 `provenance/published-manifest.webmanifest`，同样逐字验证。`loader-facade.js`、boot manifest、browser carrier 和补充通知是明确的 Harness 适配文件。

默认运行清单是 66 个动态 client。源码参考的 67 个目录还包含 `ui-primitives` 纯 React 原子库；它没有独立 client registration 或 `lib/client.js`，实际编入官方 frontend。原审查清单的空 `client: {}` 已改为明确的 `client: null` 和原子库说明，避免 JavaScript truthy 判断误计动态工厂。

归档的 3,181 份源码文件再次逐项与 `5badb15009ae1756c3afe0ae0cef1faafc290ccc` 的原始 Git blob 核对，大小和 SHA-256 全部一致。这个检查仍只证明单独的源码参考，没有补出 npm 缺失的 `gitHead` 或原始 transitive 构建清单。

离线重建及六类篡改拒绝检查通过。维护者可用 `node scripts/research/deepseek-frontend-vendor.mjs --seal` 在审查本地适配后重新冻结；该命令仍先检查原 tar 和全部官方浏览器资产，不能将修改过的上游 bundle 重新签成原发布物。正式消费使用 `--verify`，不自动 reseal。上述字体、品牌图标及精确 transitive 证据缺口仍保留。
