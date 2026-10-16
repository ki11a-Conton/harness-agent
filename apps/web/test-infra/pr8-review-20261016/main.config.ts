import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
const replacements = new Map(['session.ts', 'projections.ts'].map(name => [name, execFileSync('git', ['show', '95a27dfdc17d14986537ca181fa371bad37e815e:apps/web/src/deepseek/' + name], { encoding: 'utf8' })]));
export default defineConfig({ plugins: [{ name: 'exact-main-source', enforce: 'pre', transform(_code, id) {
  for (const [name, code] of replacements) if (id.endsWith('/apps/web/src/deepseek/' + name)) return code;
} }], test: { include: ['apps/web/test-infra/pr8-review-20261016/acceptance.test.ts'], testTimeout: 10000 } });
