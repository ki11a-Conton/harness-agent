import { defineConfig } from 'vitest/config';
// Fault injection in two isolated temporary-directory test children only.
// Simulate an exclusive guard backend letting both claimants enter; never
// modify or ship a weakened production lock implementation or compiled file.
export default defineConfig({ plugins: [{ name: 'unsafe-guard-counterexample', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/packages/evaluation/src/gen1-budget-takeover.regressions.test.ts')) return;
  const marker = 'fs.open = async function(path, ...args) {';
  if (code.split(marker).length !== 2) throw new Error('Takeover fixture open hook changed');
  return code.replace(marker, marker + '\nif (String(path).endsWith(".reclaim")) return { writeFile: async () => {}, close: async () => {} };');
} }], test: { include: ['packages/evaluation/src/gen1-budget-takeover.regressions.test.ts'] } });
