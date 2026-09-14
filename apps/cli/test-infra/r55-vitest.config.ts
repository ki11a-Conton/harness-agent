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
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: REPO_ROOT,
  test: {
    include: ["apps/cli/test-infra/e4-r55-fixtures/**/*.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    reporters: "default",
  },
});
