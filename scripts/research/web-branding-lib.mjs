/** Reviewed, deterministic presentation-only derivatives; upstream bytes remain frozen. */
import { createHash } from 'node:crypto';

export const brandedModules = Object.freeze([
  'dsh-client-ui-brand-official', 'dsh-client-ui-layout', 'dsh-client-ui-plugin-manager',
  'dsh-client-ui-settings-models', 'dsh-client-ui-settings-account', 'dsh-client-ui-sidebar-documentpreview',
]);
export const brandRoot = 'harness-brand';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const markPath = 'M6 5h5v8h10V5h5v22h-5v-9H11v9H6z';
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Harness Agent</title><rect width="32" height="32" rx="8" fill="#2563eb"/><path d="${markPath}" fill="white"/></svg>\n`;
const welcomeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="440" viewBox="0 0 800 440"><title>Harness Agent</title><rect width="800" height="440" rx="24" fill="#102033"/><g transform="translate(340 95) scale(4)"><rect width="32" height="32" rx="8" fill="#2563eb"/><path d="${markPath}" fill="white"/></g><text x="400" y="295" text-anchor="middle" fill="#f8fafc" font-family="system-ui,sans-serif" font-size="36" font-weight="600">Harness Agent</text><text x="400" y="340" text-anchor="middle" fill="#cbd5e1" font-family="system-ui,sans-serif" font-size="18">Your coding workspace</text></svg>\n`;
const brandModule = `// Harness Agent local brand slot occupants. See retained upstream notices.
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-brand-official",
  factory: (require) => {
    const { jsx } = require("react/jsx-runtime");
    function Mark({ size = 24, className } = {}) {
      return jsx("svg", { width: size, height: size, viewBox: "0 0 32 32", className,
        role: "img", "aria-label": "Harness Agent", "data-harness-brand": "mark",
        children: jsx("path", { d: ${JSON.stringify(markPath)}, fill: "currentColor" }) });
    }
    function Name() {
      return jsx("span", { "data-harness-brand": "name", style: { fontFamily: "system-ui,sans-serif", fontSize: 17, fontWeight: 650, whiteSpace: "nowrap" }, children: "Harness Agent" });
    }
    return { inject: ["slots"], apply(ctx) {
      ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({ name: "sidebar.brand.mark" }, Mark));
      ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name" }, Name));
      ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, Mark));
    } };
  }
});
`;
const welcome = {
  en: 'Welcome to Harness Agent. Choose a local workspace and configure a model provider to start coding. Review tool approvals before allowing file changes or commands. This version is a preview; available features depend on the connected Harness backend.',
  zh: '欢迎使用 Harness Agent。选择本地工作区并配置模型服务后即可开始编程。允许修改文件或执行命令前，请检查工具审批。当前版本仍为预览版，可用功能以已接入的 Harness 后端为准。',
};

export function deriveBrandModule(stem, original) {
  if (!brandedModules.includes(stem)) throw new Error('Unreviewed branding module: ' + stem);
  if (stem === 'dsh-client-ui-brand-official') return Buffer.from(brandModule);
  let source = original.toString('utf8');
  if (!source.includes('DeepSeek Harness')) throw new Error('Branding source changed: ' + stem);
  source = source.replaceAll('DeepSeek Harness', 'Harness Agent');
  if (stem === 'dsh-client-ui-settings-models') {
    let replaced = 0;
    source = source.replace(/welcomeBody: "(?:[^"\\]|\\.)*"/g, () => {
      const text = replaced++ === 0 ? welcome.en : welcome.zh;
      return 'welcomeBody: ' + JSON.stringify(text);
    });
    if (replaced !== 2) throw new Error('Expected exactly two welcome dictionaries');
  }
  if (stem === 'dsh-client-ui-settings-account') {
    let replaced = 0;
    source = source.replace(/(var onboarding_welcome(?:_dark|_zh|_zh_dark)?_default = )"data:image\/png;base64,[^"]+"/g,
      (_, declaration) => { replaced++; return declaration + JSON.stringify('/deepseek/harness-brand/welcome.svg'); });
    if (replaced !== 4) throw new Error('Expected exactly four account onboarding illustrations');
  }
  // Derived files have their own provenance, rather than claiming an original source map.
  source = source.replace(/\n\/\/# sourceMappingURL=[^\n]+/g, '');
  return Buffer.from('// Harness Agent presentation derivative; original retained under plugins/.\n' + source);
}

export function expectedBrandFiles(published) {
  const files = new Map([
    [`${brandRoot}/favicon.svg`, Buffer.from(markSvg)],
    [`${brandRoot}/welcome.svg`, Buffer.from(welcomeSvg)],
  ]);
  for (const stem of brandedModules) {
    const original = published.get(`plugins/${stem}/client.js`);
    if (!original) throw new Error('Missing original branding input: ' + stem);
    files.set(`${brandRoot}/plugins/${stem}/client.js`, deriveBrandModule(stem, original));
  }
  return files;
}

export function applyBrandGraph(graph, published, branded) {
  for (const row of graph.entries) {
    const stem = row.id.slice('@deepseek-ai/'.length);
    const overridden = brandedModules.includes(stem);
    const bytes = overridden ? branded.get(`${brandRoot}/plugins/${stem}/client.js`) : published.get(`plugins/${stem}/client.js`);
    if (!bytes) throw new Error('Missing boot module: ' + row.id);
    if (overridden) row.brandOverride = true; else delete row.brandOverride;
    row.rev = hash(bytes).slice(0, 12);
    row.url = `/deepseek/plugins/??${row.id}/client.js&rev=${row.rev}`;
  }
  const rows = new Map(graph.entries.map(row => [row.id, row]));
  for (const batch of graph.batches) {
    if (batch.entries.length !== 1) throw new Error('Brand graph requires single-resource batches');
    const row = rows.get(batch.entries[0]);
    if (!row) throw new Error('Unknown brand batch');
    batch.url = row.url; batch.rev = row.rev;
  }
  graph.rev = hash(Buffer.from(JSON.stringify({ entries: graph.entries, batches: graph.batches }))).slice(0, 12);
  return graph;
}
