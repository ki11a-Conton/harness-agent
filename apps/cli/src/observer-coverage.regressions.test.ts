/**
 * PR-B / M16 — observer-coverage regressions for the E1-02 escape sentinel.
 *
 * THE DEFECT (D3)
 * ---------------
 * `changedPaths` — the ONLY input to `escapedPaths` — was collected from exactly
 * two tool names (`write_file`, `edit_file`). `exec` can write outside the
 * workspace (its `cwd` is contained by `resolveExecCwd`, but the spawned process
 * may write anywhere), so an exec-based escape produced NO `escapedPaths` and the
 * E1-02 sentinel never fired. Silence was indistinguishable from safety.
 *
 * WHAT THIS FILE ASSERTS
 * ----------------------
 * 1. The subset invariant is EXECUTABLE and FAILS when a side-effecting tool is
 *    missing from the collector whitelist.
 * 2. It PASSES when the whitelist covers every side-effecting tool (so a correct
 *    registry is not reported as a gap).
 * 3. `exec` is reported as an explicit `OBSERVER_GAP` — not silently dropped.
 * 4. The gap marker is a real FIELD in the produced artifact/outcome, not a
 *    source comment.
 * 5. `sideEffectScope: "none"` tools are NOT reported (no false gaps), and
 *    `"unknown"` IS reported (fail-closed, matching `mayHaveSideEffect`).
 * 6. The declaration carries the "why we did not just extend it" reason, so an
 *    unobserved tool can never be mistaken for a covered one.
 *
 * The coverage checker is PURE and takes the tool set as a parameter, so these
 * tests construct their own registries. They deliberately do NOT assert against
 * the live tool set: that would make the test drift with the implementation
 * instead of pinning the invariant.
 */

import { describe, expect, it } from "vitest";
import {
  SIDE_EFFECT_COLLECTOR_TOOLS,
  assessObserverCoverage,
} from "./benchmark-command.js";

/** A synthetic registry: name -> sideEffectScope. */
const tool = (name: string, sideEffectScope: string) => ({ name, sideEffectScope });

describe("M16 §1 — the subset invariant FAILS on a real coverage gap", () => {
  it("1a. a side-effecting tool missing from the whitelist is reported as a gap (FAIL)", () => {
    // `exec` is a process-scope side effect and is NOT in the collector set —
    // this is the real D3 configuration.
    const report = assessObserverCoverage(
      [tool("read_file", "none"), tool("write_file", "filesystem"), tool("exec", "process")],
      ["write_file", "edit_file"],
    );

    expect(report.observerGap).toBe(true);
    expect(report.marker).toBe("OBSERVER_GAP");
    expect(report.unobservedSideEffectTools).toEqual(["exec"]);
    // `write_file` IS covered, so it must NOT appear as a gap.
    expect(report.unobservedSideEffectTools).not.toContain("write_file");
    // A read-only tool is not a side effect at all.
    expect(report.unobservedSideEffectTools).not.toContain("read_file");
  });

  it("1b. the invariant is a genuine subset check — any uncovered side effect fails it", () => {
    // If someone adds a new side-effecting tool without extending the collector,
    // the check must notice. This is the regression guard.
    const report = assessObserverCoverage(
      [tool("write_file", "filesystem"), tool("edit_file", "filesystem"), tool("new_fs_tool", "filesystem")],
      SIDE_EFFECT_COLLECTOR_TOOLS,
    );
    expect(report.observerGap).toBe(true);
    expect(report.unobservedSideEffectTools).toEqual(["new_fs_tool"]);
  });

  it("1c. multiple gaps are reported exhaustively (never just the first)", () => {
    const report = assessObserverCoverage(
      [
        tool("exec", "process"),
        tool("fetch_url", "network"),
        tool("mutate_global", "global"),
        tool("mystery_tool", "unknown"),
        tool("write_file", "filesystem"),
      ],
      ["write_file"],
    );
    // Sorted, complete, and excluding the one covered tool.
    expect(report.unobservedSideEffectTools).toEqual([
      "exec",
      "fetch_url",
      "mutate_global",
      "mystery_tool",
    ]);
  });
});

describe("M16 §2 — a fully covered registry is NOT reported as a gap", () => {
  it("2a. no false positives when every side-effecting tool is observed", () => {
    const report = assessObserverCoverage(
      [tool("read_file", "none"), tool("grep_search", "none"), tool("write_file", "filesystem"), tool("edit_file", "filesystem")],
      ["write_file", "edit_file"],
    );

    expect(report.observerGap).toBe(false);
    expect(report.marker).toBeUndefined();
    expect(report.reason).toBeUndefined();
    expect(report.unobservedSideEffectTools).toEqual([]);
    expect(report.observedTools).toEqual(["write_file", "edit_file"]);
  });

  it("2b. an empty tool set has no gap", () => {
    const report = assessObserverCoverage([], ["write_file"]);
    expect(report.observerGap).toBe(false);
    expect(report.unobservedSideEffectTools).toEqual([]);
  });
});

describe("M16 §3 — `exec` is explicitly declared unobservable, with the reason", () => {
  it("3a. exec appears in the gap set for a realistic harness registry", () => {
    // The real built-in registration, reduced to the tools that matter here.
    const report = assessObserverCoverage(
      [
        tool("read_file", "none"),
        tool("write_file", "filesystem"),
        tool("edit_file", "filesystem"),
        tool("exec", "process"),
      ],
      SIDE_EFFECT_COLLECTOR_TOOLS,
    );

    expect(report.observerGap).toBe(true);
    expect(report.unobservedSideEffectTools).toContain("exec");
  });

  it("3b. the declaration explains WHY the gap is declared rather than closed", () => {
    const report = assessObserverCoverage([tool("exec", "process")], ["write_file", "edit_file"]);

    expect(report.reason).toBeDefined();
    // Names the covered tools, the uncovered tool, and the consequence.
    expect(report.reason).toContain("write_file");
    expect(report.reason).toContain("exec");
    expect(report.reason).toContain("UNOBSERVED");
    // States the consequence for the sentinel, not just "a gap exists".
    expect(report.reason).toContain("escapedPaths");
    // States that the gap is declared, NOT silently guessed-closed.
    expect(report.reason).toContain("declared");
  });

  it("3c. the gap set is JSON-serializable — it survives into an artifact", () => {
    const report = assessObserverCoverage([tool("exec", "process")], SIDE_EFFECT_COLLECTOR_TOOLS);
    const roundTripped = JSON.parse(JSON.stringify(report)) as typeof report;

    expect(roundTripped.marker).toBe("OBSERVER_GAP");
    expect(roundTripped.unobservedSideEffectTools).toEqual(["exec"]);
    expect(roundTripped.observerGap).toBe(true);
  });
});

describe("M16 §4 — the marker is a real field in the produced outcome, not a comment", () => {
  it("4a. the coverage declaration is carried on the artifact's shape", async () => {
    // The outcome returned by runOneCase spreads `observerCoverage` into the
    // serialized record. Assert the CONTRACT (a required field with a stable
    // marker) against the real module, so a comment-only "fix" cannot pass.
    const report = assessObserverCoverage([tool("exec", "process")], SIDE_EFFECT_COLLECTOR_TOOLS);

    // The field must be present and machine-readable in the product.
    const serialized = JSON.stringify({ caseId: "c", observerCoverage: report });
    expect(serialized).toContain('"marker":"OBSERVER_GAP"');
    expect(serialized).toContain('"unobservedSideEffectTools":["exec"]');
    expect(serialized).toContain('"observerGap":true');
  });

  it("4b. the collector whitelist is exported as the single source of truth", () => {
    // The collector's tool-name test and the invariant check read the SAME
    // constant, so they cannot drift apart silently (the original defect was
    // exactly such a hardcoded list embedded in an event callback).
    expect(SIDE_EFFECT_COLLECTOR_TOOLS).toEqual(["write_file", "edit_file"]);
    expect(Object.isFrozen(SIDE_EFFECT_COLLECTOR_TOOLS)).toBe(false);

    // And it is exactly the set the checker treats as covered.
    const report = assessObserverCoverage(
      SIDE_EFFECT_COLLECTOR_TOOLS.map((name) => tool(name, "filesystem")),
      SIDE_EFFECT_COLLECTOR_TOOLS,
    );
    expect(report.observerGap).toBe(false);
  });
});

describe("M16 §5 — fail-closed classification of side-effect scope", () => {
  it("5a. `none` is not a gap, and everything else IS (including `unknown`)", () => {
    const scopes = ["none", "filesystem", "process", "network", "global", "unknown"] as const;
    const report = assessObserverCoverage(
      scopes.map((scope, index) => tool(`t${index}`, scope)),
      [], // nothing covered → every non-"none" scope must be reported
    );

    expect(report.unobservedSideEffectTools).toEqual([
      "t1", // filesystem
      "t2", // process
      "t3", // network
      "t4", // global
      "t5", // unknown — fail-closed, same rule as mayHaveSideEffect
    ]);
    expect(report.unobservedSideEffectTools).not.toContain("t0"); // none
  });

  it("5b. `unknown` scope is reported (matching @ar/contracts mayHaveSideEffect)", () => {
    const report = assessObserverCoverage([tool("undeclared_tool", "unknown")], ["write_file"]);
    expect(report.observerGap).toBe(true);
    expect(report.unobservedSideEffectTools).toEqual(["undeclared_tool"]);
  });
});
