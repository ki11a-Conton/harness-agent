import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['apps/web/test-infra/pr8-review-20261016/acceptance.test.ts'], testTimeout: 10000 } });
