/**
 * E4-R34 (H04) — the DEDICATED config for the e4-r24 observation fixtures.
 *
 * The final-result protocol test spawns a REAL `vitest run` over a generated,
 * DELIBERATELY-failing fixture. That fixture must NOT live inside the root
 * config's `include` scope (`apps/*\/src/**\/*.test.ts`): if the parent's cleanup
 * is ever interrupted, a leftover `*.test.ts` would be collected by the NEXT
 * full run and surface as a real failure (H04 — observed in practice).
 *
 * Fixtures therefore live in `apps/cli/test-infra/observation-fixtures/`:
 *   - outside the root vitest `include` (the path has no `src` segment), and
 *   - outside `apps/cli/tsconfig.json`'s `include: ["src"]` (a leftover fixture
 *     can never break `tsc -b`).
 *
 * This config is what the subprocess uses. It selects EXACTLY the fixture
 * directory (never the parent suite) and wires the PRODUCTION reporter, so the
 * subprocess still exercises the real final-result commit path — it is not a
 * mock-reporter helper.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: REPO_ROOT,
  test: {
    include: ["apps/cli/test-infra/observation-fixtures/**/*.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    // The production reporter wiring, always on for this fixture run.
    reporters: ["default", "./apps/cli/test-infra/observation-vitest-reporter.ts"],
  },
});
