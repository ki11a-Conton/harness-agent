/**
 * E4-R46 — the DEDICATED config for the diagnostic cross-process fixture.
 *
 * The uniqueness regression spawns REAL `vitest run` subprocesses over a
 * generated fixture so two INDEPENDENT processes (same diagnostic root, same
 * `E2E_OBSERVATION_RUN_ID`, same label) must produce two DISTINCT bundles. The
 * fixture must NOT live inside the root config's `include` scope
 * (`apps/*\/src/**\/*.test.ts`): a leftover fixture must never be collected by
 * the next full-repo run (same H04 principle as `observation-vitest.config.ts`).
 *
 * Fixtures live in `apps/cli/test-infra/diagnostic-fixtures/`:
 *   - outside the root vitest `include` (no `src` segment), and
 *   - outside `apps/cli/tsconfig.json`'s `include: ["src"]`.
 *
 * This config selects EXACTLY the fixture directory; it is not a mock helper.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: REPO_ROOT,
  test: {
    include: ["apps/cli/test-infra/diagnostic-fixtures/**/*.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    reporters: "default",
  },
});