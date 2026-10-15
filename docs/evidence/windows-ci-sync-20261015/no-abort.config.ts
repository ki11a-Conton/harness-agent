import { defineConfig } from 'vitest/config';
export default defineConfig({ plugins: [{ name: 'deadline-abort-mutation', enforce: 'pre', transform(code,id) {
  if (id.endsWith('/tool-call-efficiency-formal-run.ts')) return code.replace('deadlineAborted = true;\n                midStreamAbort.abort();', 'deadlineAborted = true; // mutation: abort removed');
} }], test: { include: ['packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts'], testTimeout: 60_000 } });
