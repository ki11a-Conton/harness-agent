/**
 * E4-R92 — the offline rehearsal and its anomaly matrix.
 *
 * Plan §R92 怎么做 requires injecting identity drift, expired authorization,
 * budget exhaustion, 429/5xx, disconnect, persistence failure and a mid-run
 * stop, to prove the runner stops as agreed. Plan §R92 怎么验收 requires that
 * matrix to pass with ZERO external requests.
 *
 * "Zero external requests" is asserted structurally, not promised: the rehearsal
 * accepts no provider at all — it constructs every provider it uses in-process —
 * so it has no way to reach a network. The assertion below that the running
 * scenarios DID reach their fake provider is what keeps "0 provider requests" in
 * the refusal scenarios from passing vacuously.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  R92_REHEARSAL_SCHEMA,
  R92_REHEARSAL_SCENARIOS,
  runR92Rehearsal,
} from "./r92-rehearsal.js";

async function freshDir(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `e4-r92-${label}-`));
}

describe("E4-R92 rehearsal drives the whole matrix with zero external requests", () => {
  it("declares every scenario the plan requires, with no duplicate ids", () => {
    const ids = R92_REHEARSAL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of [
      "authorized-happy-path",
      "identity-drift",
      "expired-authorization",
      "wrong-digest",
      "budget-exhaustion",
      "provider-429",
      "provider-5xx",
      "disconnect",
      "persistence-failure",
      "mid-run-stop",
      "unauthorized",
    ] as const) {
      expect(ids, `scenario ${required} must be declared`).toContain(required);
    }
  });

  it("runs every scenario offline and reports zero external requests", async () => {
    const dir = await freshDir("matrix");
    try {
      const report = await runR92Rehearsal({ workDir: dir });
      expect(report.schemaVersion).toBe(R92_REHEARSAL_SCHEMA);
      expect(report.externalRequests).toBe(0);
      expect(report.providerRequests).toBeGreaterThan(0);
      expect(report.scenarios.length).toBe(R92_REHEARSAL_SCENARIOS.length);
      // Every declared scenario actually produced a result — no silent skips.
      expect(report.scenarios.map((s) => s.id).sort()).toEqual(
        R92_REHEARSAL_SCENARIOS.map((s) => s.id).sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops the run at the declared model-call cap instead of overspending", async () => {
    const dir = await freshDir("budget");
    try {
      const report = await runR92Rehearsal({ workDir: dir });
      const s = report.scenarios.find((x) => x.id === "budget-exhaustion")!;
      expect(s.stoppedAsAgreed).toBe(true);
      expect(s.observed.stopReason).toBe("model-call-cap");
      // The cap is a ceiling: the run must never exceed it.
      expect(s.observed.modelCallAttempts).toBeLessThanOrEqual(s.observed.maxModelCalls);
      expect(s.observed.hitCap).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses before the first provider request when unauthorized or drifted", async () => {
    const dir = await freshDir("refusals");
    try {
      const report = await runR92Rehearsal({ workDir: dir });
      for (const id of ["unauthorized", "identity-drift", "expired-authorization", "wrong-digest", "blocked-cap"] as const) {
        const s = report.scenarios.find((x) => x.id === id)!;
        expect(s.authorizedToExecute, `${id} must not be authorized`).toBe(false);
        expect(s.providerRequests, `${id} must make no provider request`).toBe(0);
        expect(s.runStatus).toBe("NOT_RUN");
        expect(s.code).toBeTruthy();
      }
      // The running scenarios DID reach the fake provider, so "0 requests" above
      // is a real refusal rather than a rehearsal that never ran anything.
      expect(report.providerRequests).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces transport anomalies as invalid arms, never as pass or fail", async () => {
    const dir = await freshDir("anomalies");
    try {
      const report = await runR92Rehearsal({ workDir: dir });
      for (const id of ["provider-429", "provider-5xx", "disconnect"] as const) {
        const s = report.scenarios.find((x) => x.id === id)!;
        expect(s.stoppedAsAgreed, `${id} must stop as agreed`).toBe(true);
        // An infrastructure anomaly must never be scored as a task outcome.
        expect(s.observed.invalidArms, `${id} must produce invalid arms`).toBeGreaterThan(0);
        expect(s.observed.scoredPairs, `${id} must not score an anomaly`).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a persistence failure instead of swallowing it", async () => {
    const dir = await freshDir("persistence");
    try {
      const report = await runR92Rehearsal({ workDir: dir });
      const s = report.scenarios.find((x) => x.id === "persistence-failure")!;
      // The journal write fails before any arm can be trusted, so the failure
      // must surface and NOTHING may be scored as a result.
      expect(s.stoppedAsAgreed).toBe(true);
      expect(s.observed.persistenceFailureSurfaced).toBe(true);
      expect(s.observed.scoredPairs).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes a mid-run stop without duplicating or losing an arm", async () => {
    const dir = await freshDir("resume");
    try {
      const report = await runR92Rehearsal({ workDir: dir });
      const s = report.scenarios.find((x) => x.id === "mid-run-stop")!;
      expect(s.stoppedAsAgreed).toBe(true);
      expect(s.observed.resumed).toBe(true);
      // After resume every finalized pair holds exactly one baseline + one candidate.
      expect(s.observed.duplicateArmRuns).toBe(0);
      expect(s.observed.missingArmRuns).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a blocked cap as a refusal rather than running an unbounded campaign", async () => {
    const dir = await freshDir("blocked");
    try {
      const report = await runR92Rehearsal({ workDir: dir });
      const s = report.scenarios.find((x) => x.id === "blocked-cap")!;
      expect(s.authorizedToExecute).toBe(false);
      expect(s.code).toBe("CAP_NOT_ENFORCEABLE");
      expect(s.providerRequests).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic: the same rehearsal twice yields the same scenario verdicts", async () => {
    const a = await freshDir("det-a");
    const b = await freshDir("det-b");
    try {
      const r1 = await runR92Rehearsal({ workDir: a });
      const r2 = await runR92Rehearsal({ workDir: b });
      const norm = (r: typeof r1) =>
        r.scenarios.map((s) => ({ id: s.id, code: s.code ?? null, stopped: s.stoppedAsAgreed }));
      expect(norm(r1)).toEqual(norm(r2));
      // Identical work, not merely identical verdicts.
      expect(r2.providerRequests).toBe(r1.providerRequests);
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it("is RE-RUNNABLE in the same workDir: a stale journal never silently skips a run", async () => {
    // Regression: the executor reads an existing journal as a resume request and
    // rejects it when the identity differs. Without a clean start the second
    // rehearsal ran nothing (0 provider calls) yet reported every scenario as
    // "stopped as agreed" — a rehearsal that cannot be re-run is not evidence.
    const dir = await freshDir("rerun");
    try {
      const first = await runR92Rehearsal({ workDir: dir });
      const second = await runR92Rehearsal({ workDir: dir });
      expect(first.providerRequests).toBeGreaterThan(0);
      expect(second.providerRequests).toBe(first.providerRequests);
      for (const s of second.scenarios) {
        expect(s.stoppedAsAgreed, `${s.id} must stop as agreed on a re-run`).toBe(true);
      }
      // The running scenarios must really reach the provider on the re-run.
      const happy = second.scenarios.find((x) => x.id === "authorized-happy-path")!;
      expect(happy.providerRequests).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never records a scenario's results as a real score or a pass-rate claim", async () => {
    const dir = await freshDir("no-claims");
    try {
      const report = await runR92Rehearsal({ workDir: dir });
      expect(report.realScores).toBe(false);
      expect(report.passRateClaim).toBe(false);
      expect(report.billingClass).toBe("offline-rehearsal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
