import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
const baseline = execFileSync('git', ['show', 'bddf6f64efe6dbfe7ca02ad352a20735f6e7170b:packages/tools/src/tools/exec.ts'], { encoding: 'utf8' });
export default defineConfig({ plugins: [{ name: 'fixed-exec-prefix-baseline', enforce: 'pre', transform(_code, id) {
  if (id.endsWith('/packages/tools/src/tools/exec.ts')) return baseline;
} }], test: { include: ['packages/harness/src/exec-diagnostics.integration.test.ts'] } });
