import { defineConfig } from "vitest/config";
export default defineConfig({test:{include:[".ci/agent-next2-20261005/audit-provider/baseline-regressions.test.ts"],testTimeout:5000}});
