/**
 * E4-R24 (F04) — the FINAL-RESULT observation reporter.
 *
 * Loaded by vitest.config.ts ONLY when E2E_OBSERVATION_RUN_ID names the run
 * (CI and explicit local audits). Test bodies record CANDIDATE observations
 * via createObservationRun().observe(...); THIS reporter publishes the
 * committed `runStatus: "passed"` rows AFTER the framework has determined each
 * test's FINAL result:
 *
 *   - a test's own result must be "passed" (assertions AND afterEach included);
 *   - no error may sit on any SUITE/MODULE ancestor (afterAll at any level,
 *     collection errors) — hook failures invalidate the tests they clean up;
 *   - rows for every other outcome are dropped (diagnostic only).
 *
 * It reads the same evidence dir + runId env as the collectors, so multiple
 * workers append candidates into ONE run while this single commit (temp file +
 * atomic rename, see commitObservationRun) runs in the main process at run
 * end. When the env var is unset it does nothing — normal local runs are
 * unchanged.
 */

import { relative } from "node:path";
import type { Reporter, TestCase, TestModule } from "vitest/node";
import { commitObservationRun, type ObservationFinalOutcome } from "../src/observation-evidence.js";

const toRel = (moduleId: string): string => relative(process.cwd(), moduleId).replace(/\\/g, "/");

/** The test's own state passed AND no hook/collection error on any ancestor
 * (suite or module) — covers afterEach (test-level) and afterAll (any level). */
function finallyPassed(test: TestCase): boolean {
  if (test.result().state !== "passed") return false;
  let node = test.parent;
  for (;;) {
    if (node.errors().length > 0) return false;
    if (node.type === "module") return true;
    node = node.parent;
  }
}

export default class ObservationVitestReporter implements Reporter {
  async onTestRunEnd(testModules: ReadonlyArray<TestModule>): Promise<void> {
    const runId = process.env.E2E_OBSERVATION_RUN_ID;
    if (runId === undefined || runId === "") return; // no run configured — nothing to commit
    try {
      const finals: ObservationFinalOutcome[] = [];
      for (const mod of testModules) {
        const testFile = toRel(mod.moduleId);
        for (const test of mod.children.allTests()) {
          // Status is EXACTLY "passed" only when finallyPassed — never the raw
          // test state, which stays "passed" even when an afterAll/collection
          // error invalidated the test (empirically probed on vitest 4.1:
          // a hook-failed test reports state="passed" + suite errors).
          // Register BOTH naming conventions (plain title and full "a > b"
          // title) so tests may declare either as their observation identity.
          const status = finallyPassed(test) ? "passed" : "failed";
          finals.push({ testFile, testName: test.name, status });
          finals.push({ testFile, testName: test.fullName, status });
        }
      }
      const res = commitObservationRun(runId, finals);
      process.stderr.write(
        `[observation] run ${runId}: committed ${res.committedRows} row(s), dropped ${res.droppedCandidates} candidate(s)\n`,
      );
    } catch (err) {
      // The reporter must never break the test run itself — degrade loudly.
      process.stderr.write(`[degraded] observation reporter: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
