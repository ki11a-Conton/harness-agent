// E4-R92 regression — the workflow file must never contain a paid-authorization
// literal, and this test is the LOCAL mirror of the R82 cold-start CI guard.
//
// The R82 guard ("Verify the workflow itself cannot authorize a paid run") runs
// only inside the `offline cold-start (ubuntu)` job, which `pnpm test` does not
// cover. So a change that trips it is invisible locally and surfaces only as a
// red CI run — which is exactly what happened: E4-R89 added a negative control
// containing the literal `RUN_PAID_BENCHMARKS = "1"` inside a PowerShell regex,
// and the guard's raw-text scan matched that control string. CI went red on
// `567ca03` while every local gate stayed green.
//
// This test reproduces the guard's scan locally so the defect is caught by
// `pnpm test`. It deliberately uses the SAME pattern as the CI step; if that
// pattern is ever changed, both must change together.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");

/** The exact pattern the R82 cold-start CI guard greps with:
 *  `grep -nE 'RUN_PAID_BENCHMARKS\s*[:=]\s*["'"'"']?1' .github/workflows/ci.yml`
 *  Written here with the single quote in a character class so this file can
 *  carry it without the literal `= "1"` sequence. */
const PAID_AUTH_PATTERN = /RUN_PAID_BENCHMARKS\s*[:=]\s*["']?1/;

describe("E4-R92: the workflow cannot authorize a paid run (local mirror of the R82 CI guard)", () => {
  it("the scan is not vacuous: it still detects the original defect shape", () => {
    // The guard exists to catch a workflow that SETS the paid switch. If the
    // pattern stopped matching that, this test would pass for the wrong reason.
    expect(`RUN_PAID_BENCHMARKS${" "}=${" "}"1"`.match(PAID_AUTH_PATTERN)).not.toBeNull();
    expect(`RUN_PAID_BENCHMARKS: "1"`.match(PAID_AUTH_PATTERN)).not.toBeNull();
    expect(`RUN_PAID_BENCHMARKS: 1`.match(PAID_AUTH_PATTERN)).not.toBeNull();
  });

  it("ci.yml carries no paid-authorization literal anywhere", () => {
    const lines = readFileSync(WORKFLOW, "utf8").split("\n");
    const hits: string[] = [];
    lines.forEach((line, i) => {
      if (PAID_AUTH_PATTERN.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
    });
    // A negative control is test DATA, not an authorization, so it must be
    // written so the literal never appears contiguously in the file.
    expect(hits, `ci.yml contains a paid-authorization literal:\n${hits.join("\n")}`).toEqual([]);
  });
});
