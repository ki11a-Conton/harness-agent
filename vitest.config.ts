import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    // E4-R37 (J02): a workspace UPGRADED from the pre-R34 generation can still
    // carry leftover `apps/cli/src/e4-r24-fixture-*.test.ts` throwaways from an
    // interrupted final-result-protocol run. `.gitignore` keeps them out of git,
    // but git-ignore is NOT a Vitest exclude: the root `include` above still
    // COLLECTS them, so a stale deliberately-failing fixture surfaces as a real
    // suite failure on the next full run (measured: 318 files / 1 failed before
    // this rule). Exclude them STRUCTURALLY by their generated filename pattern —
    // narrow on purpose: never a real e4-r24 protocol test, never other `apps/cli`
    // suites, never the security/coverage scopes. R34 already moved NEW fixtures
    // to `apps/cli/test-infra/observation-fixtures/` (outside `include`); this rule
    // covers the historical location that the move cannot clean up for users.
    //
    // `configDefaults.exclude` is spread explicitly because a custom `exclude`
    // REPLACES the framework defaults (`**/node_modules/**`, `**/.git/**`).
    exclude: [...configDefaults.exclude, "apps/cli/src/e4-r24-fixture-*.test.ts"],
    environment: "node",
    testTimeout: 300000,
    // E4-R24 (F04): when a suite run is NAMED (E2E_OBSERVATION_RUN_ID — set by
    // CI or explicit local audits), the final-result reporter publishes the
    // committed observation evidence for that run from the framework's own
    // final test states. Unset (normal local runs) → no reporter, no writes.
    reporters: process.env.E2E_OBSERVATION_RUN_ID
      ? ["default", "./apps/cli/test-infra/observation-vitest-reporter.ts"]
      : "default",
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