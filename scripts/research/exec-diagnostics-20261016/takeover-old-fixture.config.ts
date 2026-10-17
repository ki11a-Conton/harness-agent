import { defineConfig } from 'vitest/config';
export default defineConfig({ plugins: [{ name: 'original-first-removal-fixture', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/packages/evaluation/src/gen1-budget-takeover.regressions.test.ts')) return;
  const marker = 'if (holder.token === "dead-owner") {';
  if (code.split(marker).length !== 2) throw new Error('Takeover fixture gate changed');
  return code.replace(marker, 'if (true) {');
} }], test: { include: ['packages/evaluation/src/gen1-budget-takeover.regressions.test.ts'] } });
