import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
const replacements = new Map(['session.ts', 'projections.ts', 'owners.ts'].map(name => [name, execFileSync('git', ['show', 'fe3adf069736bdeef7c845581065283ce6ccf17c:apps/web/src/deepseek/' + name], { encoding: 'utf8' })]));
export default defineConfig({ plugins: [{ name: 'original-reviewed-pr8', enforce: 'pre', transform(_code, id) {
  for (const [name, code] of replacements) if (id.endsWith('/apps/web/src/deepseek/' + name)) return code;
} }], test: { include: ['apps/web/test-infra/pr8-review-20261016/acceptance.test.ts'], testTimeout: 10000 } });
