import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
const baseline = execFileSync('git',['show','00a6219d9dade6e78692123b4a2378b6b2c56cac:apps/web/src/deepseek/composition.integration.test.ts'],{encoding:'utf8'});
export default defineConfig({ plugins: [{ name: 'controlled-fixed-port-conflict', enforce: 'pre', transform(code,id) {
  if(id.endsWith('/composition.integration.test.ts') && process.env.WINDOWS_FIXTURE_BASELINE_SOURCE==='1') return baseline;
  if(id.endsWith('/data-dir-lease.ts')) {
    const guard='  if (dataDir === undefined || dataDir.length === 0) return undefined;';
    if(code.split(guard).length!==2)throw new Error('Original memory/lease boundary changed');
    return code.replace(guard,guard+'\n  throw Object.assign(new Error("controlled occupied fixed lease port"), { code: "HARNESS_DATA_DIR_IN_USE" });');
  }
} }], test: { include: ['apps/web/src/deepseek/composition.integration.test.ts'], testTimeout: 30_000 } });
