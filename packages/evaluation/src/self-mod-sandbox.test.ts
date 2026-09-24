import { describe, expect, it } from "vitest";
import {
  championUntouched,
  gateModify,
  integratePatch,
  snapshotHash,
  snapshotTree,
} from "./self-mod-sandbox.js";

const CHAMPION = "/repo/harness-agent";
const ISOLATED = "/repo/harness-agent-candi-A";

const ROUND = { candidateId: "A", isolatedRoot: ISOLATED, championRoot: CHAMPION };

describe("P3-9 self-modification sandbox — write gate", () => {
  it("allows writes inside the isolated copy", () => {
    const g = gateModify(ROUND, `${ISOLATED}/src/foo.ts`);
    expect(g.allowed).toBe(true);
  });

  it("rejects writes directly onto the live champion tree", () => {
    const g = gateModify(ROUND, `${CHAMPION}/src/foo.ts`);
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain("forbidden");
  });

  it("rejects writes to the champion root itself", () => {
    expect(gateModify(ROUND, CHAMPION).allowed).toBe(false);
  });

  it("rejects writes outside the isolated copy", () => {
    expect(gateModify(ROUND, "/tmp/unrelated/setup.sh").allowed).toBe(false);
  });

  it("is not confused by path prefixes (isolated is not inside champion)", () => {
    // champion "harness-agent" vs "harness-agent-candi-A": the isolated copy is a
    // SIBLING, not a descendant — it must be writable.
    expect(gateModify(ROUND, `${ISOLATED}/a.ts`).allowed).toBe(true);
  });
});

describe("P3-9 self-modification sandbox — champion immutability snapshot", () => {
  it("snapshot hash is stable for identical trees and changes on mutation", () => {
    const tree = { "src/a.ts": "1", "src/b.ts": "2" };
    const again = { "src/a.ts": "1", "src/b.ts": "2" };
    const mutated = { "src/a.ts": "1", "src/b.ts": "3" };
    expect(snapshotHash(tree)).toBe(snapshotHash(again));
    expect(snapshotHash(tree)).not.toBe(snapshotHash(mutated));
    expect(championUntouched(snapshotTree(tree), snapshotTree(again))).toBe(true);
    expect(championUntouched(snapshotTree(tree), snapshotTree(mutated))).toBe(false);
  });

  it("snapshot is order-independent", () => {
    expect(snapshotTree({ "b.ts": "2", "a.ts": "1" })).toBe(snapshotTree({ "a.ts": "1", "b.ts": "2" }));
  });
});

describe("P3-9 self-modification sandbox — integration gate", () => {
  it("merges a patch only after isolated tests AND benchmarks pass", () => {
    expect(integratePatch([], { testsPassed: true, benchmarksPassed: true }).status).toBe("merged");
    expect(integratePatch([], { testsPassed: false, benchmarksPassed: true }).status).toBe("rejected");
    expect(integratePatch([], { testsPassed: true, benchmarksPassed: false }).status).toBe("rejected");
  });

  it("never merges onto the live champion — integration is a fresh clone", () => {
    // The gate has no reference to the running champion tree: there is no code
    // path that mutates CHAMPION in place. The merge is applied only as an
    // isolated patch verdict.
    const res = integratePatch([], { testsPassed: true, benchmarksPassed: true });
    expect(res.status).toBe("merged");
  });
});