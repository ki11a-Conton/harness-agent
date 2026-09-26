/**
 * B0 — the DEDICATED config for the NEXT-round RED counterexamples.
 *
 * Same H04 principle as `r55-vitest.config.ts` / `diagnostic-vitest.config.ts`:
 * these suites are DELIBERATELY failing on the audited HEAD (§B0), so they must
 * live OUTSIDE the root config's `include` (`packages/*\/src` / `apps/*\/src`).
 * A deliberately-failing file collected by `pnpm test` would make the green
 * regression red; a file renamed away from `*.test.ts` could not be run at all.
 *
 * The root config therefore EXCLUDES exactly these two files, and this config
 * selects ONLY them. The matrix command is:
 *
 *   npx vitest run --config apps/cli/test-infra/red-next-gaps-vitest.config.ts
 *
 * Every test here is offline: no provider, no key, no network, no child process.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: REPO_ROOT,
  test: {
    include: [
      "packages/evaluation/src/prereg-next-gaps.test.ts",
      "apps/cli/src/prereg-next-gaps.test.ts",
    ],
    environment: "node",
    testTimeout: 300_000,
    reporters: "default",
  },
});