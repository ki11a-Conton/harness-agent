import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../vitest.config.js';
export default mergeConfig(base, defineConfig({
  plugins: [{ name: 'controlled-windows-ci-timing-reproducer', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/tool-call-efficiency-tool-budget.test.ts')) return code.replace('    const startedAt = Date.now();', '    const originalReserve = budget.reserve.bind(budget);\n    budget.reserve = async (...args) => { const reserved = await originalReserve(...args); await new Promise(done => setTimeout(done, 500)); return reserved; };\n    const startedAt = Date.now();');
    if (id.endsWith('/composition.integration.test.ts')) return code.replace('    const delta = toolReply ?', '    if (!toolReply) await new Promise(done => setTimeout(done, 5000));\n    const delta = toolReply ?');
  } }],
  test: { include: ['packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts','apps/web/src/deepseek/composition.integration.test.ts'] }
}));
