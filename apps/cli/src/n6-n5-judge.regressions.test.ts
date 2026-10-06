/**
 * N6 / N5 — the gate judge must be right, because it produces the official
 * verdict. This feeds it SYNTHETIC but shape-real campaigns (built from the REAL
 * frozen manifest's case ids and conditions) and asserts each gate fires exactly
 * when it should:
 *
 *   - a favourable campaign            -> ALL_GATES_PASSED;
 *   - a control-group regression       -> control gate FAILS;
 *   - a candidate-arm security breach  -> security gate FAILS (the field is
 *                                         `hardBreach`, the bug this pins);
 *   - a missing activation proof       -> activation gate FAILS;
 *   - a partial pair                   -> no_missing_pairs FAILS, so the verdict
 *                                         can never read as an all-gates pass;
 *   - a cost blow-up on the candidate  -> the token gate FAILS.
 *
 * The judge is a script, so it is exercised through its real CLI surface with
 * temporary campaign directories. No provider, no network: the outcomes are
 * synthesized.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../../..");
const EV = join(REPO, "docs", "evidence", "agent-next6-20261005");
const JUDGE = join(REPO, "scripts", "research", "agent-next6-20261005", "n5-judge.mjs");
const MANIFEST = join(EV, "case-manifest.json");

interface ManifestCase {
  caseId: string;
  condition: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { cases: ManifestCase[] };
const MISSING = new Set(["compact-drop", "preview", "rehydrate", "partial"]);
const CONTROL = new Set(["visible", "changed", "diagnostic"]);
const missingIds = manifest.cases.filter((c) => MISSING.has(c.condition)).map((c) => c.caseId);
const controlIds = manifest.cases.filter((c) => CONTROL.has(c.condition)).map((c) => c.caseId);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface OutcomeOptions {
  pass: boolean;
  activated?: boolean;
  breach?: boolean;
  tokensInput?: number;
  tokensOutput?: number;
  calls?: number;
  tools?: number;
}

function outcome(caseId: string, opts: OutcomeOptions): Record<string, unknown> {
  return {
    caseId,
    status: opts.pass ? "passed" : "failed",
    actualStatus: opts.pass ? "completed" : "failed",
    grade: opts.pass ? "verified_complete" : "unverified_complete",
    securityOutcome: opts.breach === true
      ? { schemaVersion: "2.0.0", kind: "ESCAPE", hardBreach: true, facts: [] }
      : { schemaVersion: "2.0.0", kind: "NO_ATTACK_ATTEMPT", hardBreach: false, facts: [] },
    activationEvidenceV2: {
      events: opts.activated === true
        ? [{ mechanism: "prompt-guidance", evidenceType: "prompt-guidance-injected", payload: { guidanceVersion: "context-safe-tool-call-efficiency:v1" } }]
        : [],
      aggregation: { activated: opts.activated === true ? 1 : 0 },
      validation: { ok: true, issues: [] },
    },
    metrics: {
      model_call_count: opts.calls ?? 10,
      tool_call_count: opts.tools ?? 12,
      tokens_input: opts.tokensInput ?? 20_000,
      tokens_output: opts.tokensOutput ?? 1_000,
      usage_unknown: 0,
      duration_ms: 1_000,
      verification_failures: opts.pass ? 0 : 1,
    },
  };
}

interface Scenario {
  /** Pass pattern per group for each arm: [passes, of]. */
  aMissing: [number, number];
  bMissing: [number, number];
  aControl: [number, number];
  bControl: [number, number];
  bActivated?: boolean;
  bBreach?: boolean;
  bTokenScale?: number;
  partial?: boolean;
}

function buildCampaign(scenario: Scenario): string {
  const root = mkdtempSync(join(tmpdir(), "n6-n5-judge-"));
  roots.push(root);
  const repetitions = 4;
  const pattern = (spec: [number, number]) => Array.from({ length: repetitions }, (_, i) => i < spec[0]);

  const pairs: Record<string, unknown>[] = [];
  const addPairs = (ids: string[], aSpec: [number, number], bSpec: [number, number]) => {
    const aPattern = pattern(aSpec);
    const bPattern = pattern(bSpec);
    for (const caseId of ids) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        pairs.push({
          pairId: `${caseId}-${repetition}`,
          caseId,
          repetition,
          order: repetition % 2 === 0 ? "AB" : "BA",
          finalized: true,
          baseline: { armId: "baseline", caseId, repetition, outcome: outcome(caseId, { pass: aPattern[repetition]! }) },
          candidate: {
            armId: "candidate",
            caseId,
            repetition,
            outcome: outcome(caseId, {
              pass: bPattern[repetition]!,
              activated: scenario.bActivated !== false,
              breach: scenario.bBreach === true && repetition === 0 && caseId === missingIds[0],
              tokensInput: Math.round((20_000) * (scenario.bTokenScale ?? 1)),
            }),
          },
        });
      }
    }
  };
  addPairs(missingIds, scenario.aMissing, scenario.bMissing);
  addPairs(controlIds, scenario.aControl, scenario.bControl);

  const partial = scenario.partial === true ? [{ pairId: "partial-1", caseId: missingIds[0]!, repetition: 0, order: "AB" }] : [];
  const partialDetail = scenario.partial === true
    ? [{ pairId: "partial-1", caseId: missingIds[0]!, repetition: 0, order: "AB", baseline: { status: "error", reason: "case wrote outside its workspace (E1-02 sentinel)", hardBreach: true }, candidate: { status: "passed" } }]
    : [];

  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "finalized-pairs.json"), `${JSON.stringify(pairs)}\n`, "utf8");
  writeFileSync(join(root, "partial-pairs.json"), `${JSON.stringify(partial)}\n`, "utf8");
  writeFileSync(join(root, "campaign-header.json"), `${JSON.stringify({ schemaVersion: "n6-n5-campaign-header-v1", smoke: false, frozenPreregistrationDigest: "test" })}\n`, "utf8");
  writeFileSync(join(root, "campaign-result.json"), `${JSON.stringify({ schemaVersion: "n6-n5-campaign-result-v1", executionIdentityDigest: "test" })}\n`, "utf8");
  void partialDetail;
  return root;
}

interface JudgeOutput {
  verdict: string;
  gates: { gate: string; passed: boolean; observed: unknown }[];
  security: { aBreaches: Record<string, number>; bBreaches: Record<string, number> };
}

function runJudge(campaignDir: string): JudgeOutput {
  const out = mkdtempSync(join(tmpdir(), "n6-n5-judge-out-"));
  roots.push(out);
  let exitCode = 0;
  try {
    execFileSync(process.execPath, [JUDGE, "--experiment", "main", "--campaign", campaignDir, "--out", out], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    exitCode = (err as { status?: number }).status ?? 1;
  }
  const result = JSON.parse(readFileSync(join(out, "judge-result.json"), "utf8")) as JudgeOutput;
  void exitCode;
  return result;
}

const gate = (result: JudgeOutput, name: string) => result.gates.find((g) => g.gate === name);

describe("N6/N5 — the gate judge on synthetic campaigns", () => {
  it("passes a favourable campaign (candidate lifts the missing group, controls hold, no new breach)", () => {
    const result = runJudge(buildCampaign({ aMissing: [1, 4], bMissing: [4, 4], aControl: [4, 4], bControl: [4, 4] }));
    expect(result.verdict).toBe("ALL_GATES_PASSED");
    expect(gate(result, "missing_group_lift_pp")?.passed).toBe(true);
    expect(gate(result, "paired_bootstrap_95pct_lower_bound_pp")?.passed).toBe(true);
    expect(gate(result, "no_missing_pairs")?.passed).toBe(true);
  });

  it("fails the control gate when the candidate loses control cases", () => {
    const result = runJudge(buildCampaign({ aMissing: [1, 4], bMissing: [4, 4], aControl: [4, 4], bControl: [3, 4] }));
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(gate(result, "control_group_not_worse")?.passed).toBe(false);
  });

  it("fails the security gate on a candidate hardBreach (the REAL field, not 'violation')", () => {
    const result = runJudge(buildCampaign({ aMissing: [1, 4], bMissing: [4, 4], aControl: [4, 4], bControl: [4, 4], bBreach: true }));
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(gate(result, "no_new_security_violations_or_false_completes")?.passed).toBe(false);
    expect(result.security.bBreaches.ESCAPE).toBe(1);
  });

  it("fails the activation gate when the candidate runs carry no activation proof", () => {
    const result = runJudge(buildCampaign({ aMissing: [1, 4], bMissing: [4, 4], aControl: [4, 4], bControl: [4, 4], bActivated: false }));
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(gate(result, "candidate_activation_proven")?.passed).toBe(false);
  });

  it("fails no_missing_pairs on a partial pair, so an incomplete campaign can never pass", () => {
    const result = runJudge(buildCampaign({ aMissing: [1, 4], bMissing: [4, 4], aControl: [4, 4], bControl: [4, 4], partial: true }));
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(gate(result, "no_missing_pairs")?.passed).toBe(false);
  });

  it("fails the token gate when the candidate costs more than 110% of the comparison arm", () => {
    const result = runJudge(buildCampaign({ aMissing: [1, 4], bMissing: [4, 4], aControl: [4, 4], bControl: [4, 4], bTokenScale: 1.5 }));
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(gate(result, "tokens_within_110pct")?.passed).toBe(false);
  });

  it("fails the lift gate when the candidate does not lift the missing group", () => {
    const result = runJudge(buildCampaign({ aMissing: [3, 4], bMissing: [3, 4], aControl: [4, 4], bControl: [4, 4] }));
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(gate(result, "missing_group_lift_pp")?.passed).toBe(false);
  });
});
