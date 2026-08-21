import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 300000,
    coverage: {
      provider: "v8",
      enabled: false,
      reporter: ["text", "html", "json-summary"],
      // Critical packages per plan.md Q-14. Test files are measured for the
      // assert they instrument, but only non-test sources count toward the
      // gate; fixtures and bench-parser glue are excluded as not-user-code.
      include: [
        "packages/core/src/**/*.ts",
        "packages/security/src/**/*.ts",
        "packages/tools/src/**/*.ts",
        "packages/agents/src/**/*.ts",
        "packages/memory/src/**/*.ts",
        "packages/evaluation/src/**/*.ts",
        "packages/context/src/**/*.ts",
        "packages/learning/src/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/dist/**", "**/node_modules/**"],
      // Per-package gates for the critical packages (plan.md Q-14). Thresholds
      // are set BELOW the currently measured coverage on purpose: they are
      // regression guards, not vanity ceilings, so a small, honest dip is still
      // flagged and a major drop fails CI. Run `pnpm test:coverage` to enforce.
      thresholds: {
        "./packages/core": { lines: 85, branches: 70 },
        "./packages/security": { lines: 90, branches: 80 },
        "./packages/tools": { lines: 85, branches: 68 },
        "./packages/agents": { lines: 90, branches: 75 },
        "./packages/memory": { lines: 85, branches: 78 },
        "./packages/evaluation": { lines: 85, branches: 70 },
        "./packages/context": { lines: 95, branches: 85 },
        "./packages/learning": { lines: 95, branches: 82 },
      },
    },
  },
});