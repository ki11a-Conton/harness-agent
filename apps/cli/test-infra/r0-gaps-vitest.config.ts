/**
 * R0 — the DEDICATED config for the R0 (plan(20260928-105425).md §R0) RED
 * counterexamples for F5 (`PREREG_PRICING_JSON`) and F6 (`ci-readiness.mjs`).
 *
 * Same H04/B0/N0 principle as `red-next-gaps-vitest.config.ts` /
 * `n0-gaps-vitest.config.ts`: these two suites are DELIBERATELY failing on the
 * audited HEAD `a85db6dc…`. Like the N0 pair they live under `apps/cli/src/`
 * (so `tsc -b` still typechecks them) but the ROOT config EXCLUDES exactly
 * these two filenames, and this config selects ONLY them. A deliberately-failing
 * file collected by `pnpm test` would make the green regression red for the
 * wrong reason; a file renamed away from `*.test.ts` could not be run at all.
 *
 * They are RED now on purpose: R4 owns the F5 fix and R7 owns the F6 fix. Once
 * those land, R7 moves these files (or their assertions) into the formal
 * dual-platform gate and the label flips RED → GREEN.
 *
 * The matrix command is:
 *
 *   pnpm exec vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts
 *
 * Every test here is offline: no provider, no key, no external network, no
 * paid request. The F6 suite spawns the local readiness script, whose three
 * nested gate subprocesses are neutralised with a PATH `pnpm` shim because the
 * assertion targets the CLASSIFICATION logic, not the gates (a real,
 * unshimmed run is recorded separately in the matrix; it takes ~45 s).
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: REPO_ROOT,
  test: {
    include: [
      "apps/cli/src/r0-f5-pricing-declaration-gaps.test.ts",
      "apps/cli/src/r0-f6-ci-readiness-classification.test.ts",
    ],
    environment: "node",
    testTimeout: 120_000,
    reporters: "default",
  },
});
