import { execFileSync } from 'node:child_process';
const baseline = execFileSync('git',['show','f2eb7f87f09558ce172c83086112ddccaf0b4059:packages/core/src/runtime/session-actor.ts'],{encoding:'utf8'});
import { defineConfig } from 'vitest/config';
export default defineConfig({ plugins: [{ name: 'exact-baseline-actor', enforce: 'pre', transform(_code,id) {
  if(id.endsWith('/session-actor.ts'))return baseline;
} }], test: { include: ['packages/core/src/runtime/session-close-drain.regressions.test.ts'], testTimeout: 5000 } });
