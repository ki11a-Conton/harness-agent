/**
 * E4-R55 — the DEDICATED config for the real-production failure-wiring child.
 *
 * Same H04 principle as `observation-vitest.config.ts` and
 * `diagnostic-vitest.config.ts`: the child is a DELIBERATELY-failing fixture, so
 * it must live OUTSIDE the root config's `include`
 * (`apps/*\/src/**\/*.test.ts`). A leftover from an interrupted cleanup must
 * never be collected by the next full-repo run, and it must not be picked up by
 * `apps/cli/tsconfig.json` (`include: ["src"]`).
 *
 * Fixtures live in `apps/cli/test-infra/e4-r55-fixtures/` for exactly that
 * reason. This config selects ONLY that directory; the parent verifier spawns
 * `vitest run --config <this file>`.
 *
 * E4-R59 (G59) — the chain module is supplied by the PARENT through
 * `E4_R55_CHAIN_MODULE` and bound to this run by an alias. There is no default
 * value and no "newest file" scan: the child either loads exactly the module the
 * parent selected for this run, or the run fails before any test executes. The
 * parent points this at the real module for the control run and at its own
 * per-run mutation copy for the mutated run.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const chainModule = process.env.E4_R55_CHAIN_MODULE;
if (chainModule === undefined || chainModule.trim() === "") {
  throw new Error(
    "E4-R55 child config: E4_R55_CHAIN_MODULE must be set to the chain module this run must load (the parent verifier sets it per run).",
  );
}

export default defineConfig({
  root: REPO_ROOT,
  resolve: {
    alias: {
      // Bound to THIS run's module — never a default, never a directory scan.
      "@r55-chain": chainModule,
    },
  },
  test: {
    include: ["apps/cli/test-infra/e4-r55-fixtures/**/*.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    reporters: "default",
  },
});
