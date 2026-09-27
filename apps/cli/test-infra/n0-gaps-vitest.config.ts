/**
 * N0 — the DEDICATED config for the NEXT-round (N1–N6) RED counterexamples.
 *
 * Same H04 principle as `red-next-gaps-vitest.config.ts` / `r55-vitest.config.ts`
 * / `diagnostic-vitest.config.ts`: these suites are DELIBERATELY failing on the
 * audited HEAD (plan(20260926-175819).md §N0), so they must live OUTSIDE the
 * root config's `include` (`packages/*\/src` / `apps/*\/src`). A
 * deliberately-failing file collected by `pnpm test` would make the green
 * regression red; a file renamed away from `*.test.ts` could not be run at all.
 *
 * The root config therefore EXCLUDES exactly these two files, and this config
 * selects ONLY them. The matrix command is:
 *
 *   pnpm exec vitest run --config apps/cli/test-infra/n0-gaps-vitest.config.ts
 *
 * Every test here is offline: no provider, no key, no external network. The
 * only sockets any test may open are LOOPBACK sockets it created itself, and
 * only to prove that the arm worker's "delete 4 env keys" policy is not a
 * network sandbox (the request never leaves the machine).
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: REPO_ROOT,
  test: {
    include: [
      "packages/evaluation/src/prereg-n0-gaps.test.ts",
      "apps/cli/src/prereg-n0-gaps.test.ts",
    ],
    environment: "node",
    testTimeout: 300_000,
    reporters: "default",
  },
});