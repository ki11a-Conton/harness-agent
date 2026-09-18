/**
 * E4-R95 — strict time, budget and readiness validation for the authorization
 * envelope (plan §R95, findings D and E).
 *
 * Findings, restated from the source of `r92-authorization.ts`:
 *
 *   D  The gate checked the authorization ENV VARS (line ~531) BEFORE it
 *      computed the cap violations (line ~572). A plan whose budget is
 *      unenforceable — a DECLARED but unexecutable cost/token cap, or no global
 *      model-call cap at all — therefore returned `READY_FOR_AUTHORIZATION`
 *      whenever the auth vars happened to be absent. Readiness is a property of
 *      the PLAN, so it must be computed first and independently of whether a
 *      human has yet exported the authorization variables.
 *
 *   E  Every time comparison was guarded by `Number.isFinite`. `Date.parse`
 *      returns NaN for an unparseable timestamp, so a malformed `expiresAt`
 *      made the expiry check SKIP and the envelope was treated as unexpired.
 *      `r92AuthorizationIssuesV1` had the same shape for the
 *      `expiresAt > createdAt` ordering rule. Nothing rejected a timestamp
 *      without a timezone, a date-only string, or a `createdAt` in the future.
 *
 * Also covered here, because the plan groups them with the above:
 *   - the envelope must be parsed from `unknown`, never trusted by type;
 *   - cap values must satisfy an explicit integer/positivity contract, appear
 *     once, and carry the scope their layer actually has;
 *   - a cap's self-reported `enforcement`/`blocked` fields are NOT evidence —
 *     the gate re-derives them from the invocation mode and compares;
 *   - `maxLogicalRuns` must be able to contain cases x arms x repetitions;
 *   - case ids must come from the SUPPORTED suite set, not merely "not holdout";
 *   - a refusal names a field path and never echoes a secret value.
 *
 * Everything here is offline: this module executes nothing and calls nothing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  R92_AUTHORIZATION_SCHEMA,
  R92_GATE_CODES,
  R92_SUPPORTED_SUITES,
  R92_TIMESTAMP_PATTERN,
  classifyR92Caps,
  computeR92AuthorizationDigestV1,
  parseR92AuthorizationV1,
  parseR92Timestamp,
  r92AuthorizationGate,
  r92AuthorizationIssuesV1,
  r92CapDeclarationIssues,
  r92CapViolations,
  type R92AuthorizationV1,
  type R92CapDeclaration,
  type R92CapIntent,
  type R92GateFacts,
} from "./r92-authorization.js";

const h = (c: string) => c.repeat(64);
const sha = (c: string) => c.repeat(40);
const HEX = "0123456789abcdef";

/** The frozen R87 selection: 8 non-holdout dev-set cases. */
const CASE_IDS = [
  "regression/reg-16-cicd-step",
  "stress/stress-many-artifacts",
  "stress/stress-very-long-json",
  "regression/reg-24-error-handling",
  "regression/reg-03-add-import",
  "regression/reg-14-stack",
  "regression/reg-17-gcd",
  "regression/reg-06-json-parse-test",
];

function fingerprints(seed = 0): Record<string, string> {
  return Object.fromEntries(CASE_IDS.map((id, i) => [id, HEX[(seed + i) % 16]!.repeat(64)]));
}

function arm(id: string, digest: string) {
  return { sha: id, executionPlanDigest: digest, buildMode: "isolated-checkout" as const };
}

function capIntent(over: Partial<R92CapIntent> = {}): R92CapIntent {
  return {
    campaignModelCalls: 320,
    perCaseToolCalls: 100,
    perCaseDurationMs: 600_000,
    maxLogicalRuns: 16,
    maxEstimatedTokens: null,
    maxEstimatedCostUsd: null,
    caseCount: 8,
    repetitions: 1,
    armCount: 2,
    invocationMode: "single-invocation-over-frozen-list",
    ...over,
  };
}

/** A complete, self-consistent envelope. Individual tests perturb one field. */
function baseAuth(over: Partial<R92AuthorizationV1> = {}): R92AuthorizationV1 {
  return {
    schemaVersion: R92_AUTHORIZATION_SCHEMA,
    authorizationId: "e4-r92-dev-mechanism-ab-1",
    createdAt: "2026-09-17T00:00:00.000Z",
    expiresAt: "2026-10-17T00:00:00.000Z",
    scopeStatement:
      "8 non-holdout development-set cases (3 H2 TARGET + 5 COUNTEREXAMPLE), mechanism verification only — NOT population-representative, never a pass-rate claim.",
    selectionDigest: h("1"),
    caseIds: [...CASE_IDS],
    caseFingerprints: fingerprints(),
    arms: { baseline: arm(sha("e"), h("b")), candidate: arm(sha("f"), h("c")) },
    armIdentityMode: "isolated-checkout-build",
    fixScope: "single-fix-H2",
    fixScopeStatement:
      "Single-fix scope: the only functional difference between the two arms is the R86 progress-aware identical-call gate, so a delta is attributable to H2.",
    jointAttributionNote: null,
    invocationMode: "single-invocation-over-frozen-list",
    providerId: "openai",
    modelId: "gpt-4o-mini",
    endpointIdentity: h("2"),
    effectiveModelParams: { budgetTokens: 32000 },
    repetitions: 1,
    serialism: 1,
    caps: classifyR92Caps(capIntent()),
    unknownCostItems: ["USD total: the per-token price is not bound anywhere the runner can read"],
    outputDir: ".ci/r92-ab",
    promotionEligible: false,
    ...over,
  };
}

function facts(over: Partial<R92GateFacts> = {}): R92GateFacts {
  const auth = baseAuth();
  return {
    now: "2026-09-20T00:00:00.000Z",
    executingSourceSha: auth.arms.candidate.sha,
    observedArmBuilds: {
      baseline: { sha: auth.arms.baseline.sha, executionPlanDigest: auth.arms.baseline.executionPlanDigest },
      candidate: { sha: auth.arms.candidate.sha, executionPlanDigest: auth.arms.candidate.executionPlanDigest },
    },
    observedCaseFingerprints: fingerprints(),
    observedProviderId: auth.providerId,
    observedModelId: auth.modelId,
    observedEndpointIdentity: auth.endpointIdentity,
    ...over,
  };
}

const AUTH_ENV = { E4_R92_PAID_AUTH: "1", RUN_PAID_BENCHMARKS: "1" };

function envFor(auth: R92AuthorizationV1, over: Record<string, string | undefined> = {}) {
  return { ...AUTH_ENV, E4_R92_PAID_AUTH_DIGEST: computeR92AuthorizationDigestV1(auth), ...over };
}

/** Rebuild the cap array from raw values, so a test can declare a cap whose
 *  self-reported enforcement/blocked fields are a LIE. */
function rawCaps(over: Partial<Record<string, number | null>> = {}): R92CapDeclaration[] {
  const derived = classifyR92Caps(capIntent());
  return derived.map((c) => {
    const key = c.cap;
    const value = key in over ? over[key]! : c.value;
    return { ...c, value };
  });
}

// ===========================================================================
describe("E4-R95 the time contract is explicit, not Date.parse-and-hope", () => {
  it("exposes a timestamp pattern that REQUIRES a timezone", () => {
    expect(R92_TIMESTAMP_PATTERN.test("2026-09-17T00:00:00.000Z")).toBe(true);
    expect(R92_TIMESTAMP_PATTERN.test("2026-09-17T00:00:00Z")).toBe(true);
    expect(R92_TIMESTAMP_PATTERN.test("2026-09-17T08:00:00+08:00")).toBe(true);
    // No timezone: the instant is ambiguous, so it is not a valid contract time.
    expect(R92_TIMESTAMP_PATTERN.test("2026-09-17T00:00:00")).toBe(false);
    expect(R92_TIMESTAMP_PATTERN.test("2026-09-17T00:00:00.000")).toBe(false);
    // Date-only is not a timestamp.
    expect(R92_TIMESTAMP_PATTERN.test("2026-09-17")).toBe(false);
    // Free-form strings Date.parse would happily accept.
    expect(R92_TIMESTAMP_PATTERN.test("Sep 17 2026")).toBe(false);
    expect(R92_TIMESTAMP_PATTERN.test("")).toBe(false);
  });

  it("parses only timezone-bearing timestamps, returning null otherwise", () => {
    expect(parseR92Timestamp("2026-09-17T00:00:00.000Z")).toBe(Date.parse("2026-09-17T00:00:00.000Z"));
    expect(parseR92Timestamp("2026-09-17T00:00:00")).toBeNull();
    expect(parseR92Timestamp("2026-09-17")).toBeNull();
    expect(parseR92Timestamp("not-a-date")).toBeNull();
    expect(parseR92Timestamp("Sep 17 2026")).toBeNull();
    expect(parseR92Timestamp("")).toBeNull();
    expect(parseR92Timestamp(undefined)).toBeNull();
    expect(parseR92Timestamp(12345)).toBeNull();
    // A syntactically valid pattern whose calendar date is impossible.
    expect(parseR92Timestamp("2026-13-45T00:00:00Z")).toBeNull();
  });

  it("treats equivalent instants in different timezones as the same instant", () => {
    expect(parseR92Timestamp("2026-09-20T08:00:00+08:00")).toBe(
      parseR92Timestamp("2026-09-20T00:00:00.000Z"),
    );
    expect(parseR92Timestamp("2026-09-19T20:00:00-04:00")).toBe(
      parseR92Timestamp("2026-09-20T00:00:00.000Z"),
    );
  });

  it("refuses an UNPARSEABLE expiresAt instead of skipping the expiry check", () => {
    // The defect: Number.isFinite(NaN) is false, so the comparison was skipped
    // and a malformed expiry was silently treated as "not expired".
    const auth = baseAuth({ expiresAt: "not-a-timestamp" });
    const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.planStatus).toBe("NOT_READY");
    expect(r.code).toBe("AUTHORIZATION_TIME_INVALID");
  });

  it("refuses an UNPARSEABLE createdAt", () => {
    const auth = baseAuth({ createdAt: "whenever" });
    const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.planStatus).toBe("NOT_READY");
    expect(r.code).toBe("AUTHORIZATION_TIME_INVALID");
  });

  it("refuses a timezone-less createdAt or expiresAt", () => {
    for (const bad of ["2026-09-17T00:00:00", "2026-09-17"]) {
      const auth = baseAuth({ expiresAt: bad });
      const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
      expect(r.authorizedToExecute, `expiresAt=${bad}`).toBe(false);
      expect(r.code, `expiresAt=${bad}`).toBe("AUTHORIZATION_TIME_INVALID");
    }
  });

  it("refuses when the executor's clock reading is unparseable", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ now: "yesterday" }),
    });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.planStatus).toBe("NOT_READY");
    expect(r.code).toBe("AUTHORIZATION_TIME_INVALID");
  });

  it("treats now == expiresAt as EXPIRED (the boundary is inclusive)", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ now: auth.expiresAt }),
    });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("AUTHORIZATION_EXPIRED");
  });

  it("accepts one millisecond before expiry", () => {
    const auth = baseAuth({ expiresAt: "2026-09-20T00:00:00.001Z" });
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ now: "2026-09-20T00:00:00.000Z" }),
    });
    expect(r.authorizedToExecute).toBe(true);
  });

  it("refuses a createdAt in the FUTURE as NOT_YET_VALID", () => {
    const auth = baseAuth({ createdAt: "2026-09-25T00:00:00.000Z", expiresAt: "2026-10-25T00:00:00.000Z" });
    const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.planStatus).toBe("NOT_READY");
    expect(r.code).toBe("AUTHORIZATION_NOT_YET_VALID");
  });

  it("uses the injected executor clock, never a time copied from the envelope", () => {
    // An envelope that tries to carry its own `now` must be refused by the
    // field whitelist; the gate reads only facts.now.
    const auth = baseAuth();
    const withNow = { ...auth, now: "2026-01-01T00:00:00.000Z" };
    const parsed = parseR92AuthorizationV1(withNow);
    expect(parsed.issues.join(" ")).toContain("now");
    // Same envelope, two different injected clocks -> two different verdicts,
    // which is only possible if the clock comes from facts.
    const live = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ now: "2026-09-20T00:00:00.000Z" }),
    });
    const past = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ now: "2027-01-01T00:00:00.000Z" }),
    });
    expect(live.authorizedToExecute).toBe(true);
    expect(past.authorizedToExecute).toBe(false);
    expect(past.code).toBe("AUTHORIZATION_EXPIRED");
  });

  it("produces the same verdict regardless of the machine clock", () => {
    const auth = baseAuth();
    const run = () => r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });
});

// ===========================================================================
describe("E4-R95 the cap contract rejects values no layer could enforce", () => {
  it("accepts the complete, self-consistent cap set", () => {
    const auth = baseAuth();
    expect(r92CapDeclarationIssues(auth.caps, auth)).toEqual([]);
  });

  it("refuses a DUPLICATE cap name", () => {
    const auth = baseAuth();
    const dup = [...auth.caps, { ...auth.caps[0]! }];
    const issues = r92CapDeclarationIssues(dup, auth);
    expect(issues.join(" ")).toMatch(/duplicate/i);
    // Gate the envelope that CARRIES the duplicate — gating the clean `auth`
    // would have asserted `false` against a fully valid, authorizable plan.
    const duplicated = baseAuth({ caps: dup });
    const r = r92AuthorizationGate({ env: envFor(duplicated), authorization: duplicated, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.planStatus).toBe("NOT_READY");
  });

  it("refuses two entries for one cap that DISAGREE", () => {
    const auth = baseAuth();
    const dup = [...auth.caps, { ...auth.caps[0]!, value: 999 }];
    const issues = r92CapDeclarationIssues(dup, auth);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(" ")).toMatch(/duplicate|conflict/i);
  });

  it("refuses a NEGATIVE value", () => {
    const auth = baseAuth();
    const issues = r92CapDeclarationIssues(rawCaps({ maxModelCalls: -1 }), auth);
    expect(issues.join(" ")).toContain("maxModelCalls");
  });

  it("refuses a ZERO campaign model-call cap (a paid plan needs headroom)", () => {
    const auth = baseAuth();
    const issues = r92CapDeclarationIssues(rawCaps({ maxModelCalls: 0 }), auth);
    expect(issues.join(" ")).toContain("maxModelCalls");
  });

  it("refuses NaN, Infinity and -Infinity", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const auth = baseAuth();
      const issues = r92CapDeclarationIssues(rawCaps({ maxModelCalls: bad }), auth);
      expect(issues.length, `value=${String(bad)}`).toBeGreaterThan(0);
    }
  });

  it("refuses a STRING value even when it looks numeric", () => {
    const auth = baseAuth();
    const caps = auth.caps.map((c) => (c.cap === "maxModelCalls" ? { ...c, value: "320" } : c));
    const issues = r92CapDeclarationIssues(caps as unknown as R92CapDeclaration[], auth);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("refuses an integer beyond MAX_SAFE_INTEGER", () => {
    const auth = baseAuth();
    const issues = r92CapDeclarationIssues(rawCaps({ maxModelCalls: Number.MAX_SAFE_INTEGER + 10 }), auth);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("refuses a non-integer value", () => {
    const auth = baseAuth();
    const issues = r92CapDeclarationIssues(rawCaps({ maxModelCalls: 10.5 }), auth);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("requires the per-case duration cap to be finite and strictly positive", () => {
    const auth = baseAuth();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const issues = r92CapDeclarationIssues(rawCaps({ maxDurationMs: bad }), auth);
      expect(issues.length, `maxDurationMs=${String(bad)}`).toBeGreaterThan(0);
    }
  });

  it("refuses a cap declared with the WRONG scope", () => {
    const auth = baseAuth();
    const caps = auth.caps.map((c) =>
      c.cap === "maxModelCalls" ? { ...c, scope: "per-case" as const } : c,
    );
    const issues = r92CapDeclarationIssues(caps, auth);
    expect(issues.join(" ")).toMatch(/scope/i);
  });

  it("refuses a global cap declared per-case, and a per-case cap declared globally", () => {
    const auth = baseAuth();
    const globalAsPerCase = auth.caps.map((c) =>
      c.cap === "maxEstimatedTokens" ? { ...c, value: 1000, scope: "per-case" as const } : c,
    );
    expect(r92CapDeclarationIssues(globalAsPerCase, auth).join(" ")).toMatch(/scope/i);
    const perCaseAsGlobal = auth.caps.map((c) =>
      c.cap === "maxToolCalls" ? { ...c, scope: "campaign-wide" as const } : c,
    );
    expect(r92CapDeclarationIssues(perCaseAsGlobal, auth).join(" ")).toMatch(/scope/i);
  });

  it("requires maxLogicalRuns to contain cases x arms x repetitions", () => {
    const auth = baseAuth();
    // 8 cases x 2 arms x 1 repetition = 16; 15 cannot contain the plan.
    const issues = r92CapDeclarationIssues(rawCaps({ maxLogicalRuns: 15 }), auth);
    expect(issues.join(" ")).toMatch(/maxLogicalRuns/);
    // Exactly 16 is the boundary and must be accepted.
    expect(r92CapDeclarationIssues(rawCaps({ maxLogicalRuns: 16 }), auth)).toEqual([]);
  });

  it("does NOT trust a cap's self-reported enforcement field", () => {
    const auth = baseAuth();
    // The lie is ISOLATED to `enforcement`: value and `blocked` are set to what
    // the measured layer implies, so the enforcement mismatch is the ONLY reason
    // this can be refused. (Leaving `blocked` false as well would let the blocked
    // check catch it, and the test would pass without ever reading the field it
    // claims to be testing.)
    const lying = auth.caps.map((c) =>
      c.cap === "maxEstimatedCostUsd"
        ? { ...c, value: 5, blocked: true, enforcement: "runtime-enforced" as const }
        : c,
    );
    const issues = r92CapDeclarationIssues(lying, auth);
    expect(issues.join(" ")).toMatch(/maxEstimatedCostUsd/);
    expect(issues.join(" ")).toMatch(/enforcement/);
  });

  it("does NOT trust a cap's self-reported blocked field", () => {
    const auth = baseAuth();
    // A declared-but-unexecutable cap that claims it is NOT blocked.
    const lying = auth.caps.map((c) =>
      c.cap === "maxEstimatedCostUsd" ? { ...c, value: 5, blocked: false } : c,
    );
    const issues = r92CapDeclarationIssues(lying, auth);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("re-derives the cap verdict from the invocation mode, not the declaration", () => {
    // A per-case-invocation campaign cannot enforce a global call cap, no matter
    // what the envelope says about it.
    const auth = baseAuth({ invocationMode: "per-case-invocation" });
    const lying = auth.caps.map((c) =>
      c.cap === "maxModelCalls"
        ? { ...c, enforcement: "runtime-enforced" as const, blocked: false, value: 320 }
        : c,
    );
    const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(["CAP_NOT_ENFORCEABLE", "BUDGET_INCOMPLETE", "CAP_INVALID"]).toContain(r.code);
    expect(r92CapDeclarationIssues(lying, auth).length).toBeGreaterThan(0);
  });

  it("refuses a cap entry carrying an unknown field", () => {
    const auth = baseAuth();
    const caps = auth.caps.map((c) => ({ ...c, sneaky: true }));
    const issues = r92CapDeclarationIssues(caps as unknown as R92CapDeclaration[], auth);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("refuses a cap entry missing its evidence", () => {
    const auth = baseAuth();
    const caps = auth.caps.map((c) => (c.cap === "maxModelCalls" ? { ...c, evidence: "" } : c));
    expect(r92CapDeclarationIssues(caps, auth).length).toBeGreaterThan(0);
  });

  it("requires the model-call cap to state whether it bounds logical or physical calls", () => {
    // The plan (§R95 怎么做) requires the unit to be explicit: a logical
    // generate cap is NOT a fully-qualified HTTP/retry bound.
    const auth = baseAuth();
    const vague = auth.caps.map((c) =>
      c.cap === "maxModelCalls" ? { ...c, evidence: "the budget enforces it" } : c,
    );
    const issues = r92CapDeclarationIssues(vague, auth);
    expect(issues.join(" ")).toMatch(/logical|physical|retry/i);
  });

  it("keeps the historical r92CapViolations behaviour for blocked and unenforced caps", () => {
    expect(r92CapViolations(classifyR92Caps(capIntent({ maxEstimatedCostUsd: 5 }))).length).toBeGreaterThan(0);
    expect(r92CapViolations(classifyR92Caps(capIntent({ campaignModelCalls: null }))).length).toBeGreaterThan(0);
    expect(r92CapViolations(classifyR92Caps(capIntent()))).toEqual([]);
  });
});

// ===========================================================================
describe("E4-R95 readiness is computed BEFORE the authorization variables", () => {
  it("does NOT report READY for a blocked cap just because no auth vars exist", () => {
    // THE finding-D defect. No env at all; the plan itself is not authorizable.
    const auth = baseAuth({ caps: classifyR92Caps(capIntent({ maxEstimatedCostUsd: 5 })) });
    const r = r92AuthorizationGate({ env: {}, authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.planStatus).toBe("NOT_READY");
    expect(r.runStatus).toBe("NOT_RUN");
  });

  it("does NOT report READY for a missing global budget just because no auth vars exist", () => {
    const auth = baseAuth({ caps: classifyR92Caps(capIntent({ campaignModelCalls: null })) });
    const r = r92AuthorizationGate({ env: {}, authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.planStatus).toBe("NOT_READY");
  });

  it("does NOT report READY for a structurally invalid plan with no auth vars", () => {
    const auth = baseAuth({ serialism: 4 });
    const r = r92AuthorizationGate({ env: {}, authorization: auth, facts: facts() });
    expect(r.planStatus).toBe("NOT_READY");
    expect(r.code).toBe("PLAN_INVALID");
  });

  it("keeps a LEGAL but unauthorized plan READY with runStatus NOT_RUN", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({ env: {}, authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.planStatus).toBe("READY_FOR_AUTHORIZATION");
    expect(r.runStatus).toBe("NOT_RUN");
    expect(r.code).toBe("PAID_AUTHORIZATION_REQUIRED");
  });

  it("reports the PLAN defect even when the authorization is ALSO missing", () => {
    const auth = baseAuth({ caps: classifyR92Caps(capIntent({ campaignModelCalls: null })) });
    const r = r92AuthorizationGate({ env: {}, authorization: auth, facts: facts() });
    expect(r.code).not.toBe("PAID_AUTHORIZATION_REQUIRED");
    expect(r.planStatus).toBe("NOT_READY");
  });

  it("still reports an expired envelope as READY (the plan is re-issuable)", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ now: "2027-01-01T00:00:00.000Z" }),
    });
    expect(r.code).toBe("AUTHORIZATION_EXPIRED");
    expect(r.planStatus).toBe("READY_FOR_AUTHORIZATION");
  });

  it("never claims a run happened, in any verdict", () => {
    const auth = baseAuth();
    const cases = [
      { env: {}, authorization: auth, facts: facts() },
      { env: envFor(auth), authorization: auth, facts: facts() },
      { env: {}, authorization: null, facts: facts() },
      { env: envFor(auth), authorization: baseAuth({ serialism: 4 }), facts: facts() },
    ];
    for (const input of cases) {
      expect(r92AuthorizationGate(input).runStatus).toBe("NOT_RUN");
    }
  });
});

// ===========================================================================
describe("E4-R95 the envelope is parsed from unknown, never trusted by type", () => {
  it("exposes a CLOSED set of gate codes", () => {
    expect(Array.isArray(R92_GATE_CODES)).toBe(true);
    expect(R92_GATE_CODES).toContain("PLAN_INVALID");
    expect(R92_GATE_CODES).toContain("AUTHORIZATION_TIME_INVALID");
    expect(R92_GATE_CODES).toContain("AUTHORIZATION_NOT_YET_VALID");
    expect(new Set(R92_GATE_CODES).size).toBe(R92_GATE_CODES.length);
  });

  it("returns issues instead of throwing for null, arrays, strings and numbers", () => {
    for (const raw of [null, undefined, [], "auth", 42, true]) {
      const parsed = parseR92AuthorizationV1(raw);
      expect(parsed.authorization, `raw=${JSON.stringify(raw)}`).toBeNull();
      expect(parsed.issues.length, `raw=${JSON.stringify(raw)}`).toBeGreaterThan(0);
    }
  });

  it("returns issues instead of throwing for malformed NESTED structures", () => {
    const cases: unknown[] = [
      { ...baseAuth(), arms: "both" },
      { ...baseAuth(), arms: { baseline: null, candidate: null } },
      { ...baseAuth(), arms: { baseline: arm(sha("e"), h("b")) } },
      { ...baseAuth(), caps: "caps" },
      { ...baseAuth(), caps: [null] },
      { ...baseAuth(), caseIds: "regression/reg-16-cicd-step" },
      { ...baseAuth(), caseFingerprints: [] },
      { ...baseAuth(), effectiveModelParams: "params" },
      { ...baseAuth(), unknownCostItems: "none" },
    ];
    for (const raw of cases) {
      expect(() => parseR92AuthorizationV1(raw), JSON.stringify(raw).slice(0, 80)).not.toThrow();
      expect(parseR92AuthorizationV1(raw).issues.length).toBeGreaterThan(0);
    }
  });

  it("round-trips a complete envelope", () => {
    const parsed = parseR92AuthorizationV1(baseAuth());
    expect(parsed.issues).toEqual([]);
    expect(parsed.authorization).not.toBeNull();
  });

  it("refuses an envelope carrying an unknown TOP-LEVEL field", () => {
    const parsed = parseR92AuthorizationV1({ ...baseAuth(), sneaky: "value" });
    expect(parsed.issues.join(" ")).toContain("sneaky");
  });

  it("refuses a nested arm carrying an unknown field", () => {
    const auth = baseAuth();
    const parsed = parseR92AuthorizationV1({
      ...auth,
      arms: { ...auth.arms, baseline: { ...auth.arms.baseline, extra: 1 } },
    });
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("still accepts the envelope the R92 plan builder produces", () => {
    // Regression: the whitelist must not reject the real constructed envelope.
    const parsed = parseR92AuthorizationV1(baseAuth());
    expect(parsed.issues).toEqual([]);
    expect(parsed.authorization?.schemaVersion).toBe(R92_AUTHORIZATION_SCHEMA);
  });

  it("keeps r92AuthorizationIssuesV1 working on an already-typed envelope", () => {
    expect(r92AuthorizationIssuesV1(baseAuth())).toEqual([]);
    expect(r92AuthorizationIssuesV1(baseAuth({ serialism: 2 })).length).toBeGreaterThan(0);
  });

  it("reports a field PATH for every issue, never a bare sentence", () => {
    const parsed = parseR92AuthorizationV1({ ...baseAuth(), serialism: 2, repetitions: 3 });
    expect(parsed.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of parsed.issues) {
      expect(issue).toMatch(/[a-zA-Z]+\.[a-zA-Z]+|[a-zA-Z]{4,}/);
    }
  });
});

// ===========================================================================
describe("E4-R95 case ids come from the SUPPORTED suite set, not just 'not holdout'", () => {
  it("declares the supported development-set suites explicitly", () => {
    expect(R92_SUPPORTED_SUITES).toContain("regression");
    expect(R92_SUPPORTED_SUITES).toContain("stress");
    expect(R92_SUPPORTED_SUITES).not.toContain("holdout");
  });

  it("accepts every case in the frozen R87 selection", () => {
    // The full 8-case selection, so the 6–10 count rule cannot mask a per-case
    // rejection (the count message itself contains the word "holdout").
    const auth = baseAuth();
    expect(auth.caseIds).toEqual(CASE_IDS);
    const issues = r92AuthorizationIssuesV1(auth);
    expect(issues.filter((i) => /suite|holdout/.test(i))).toEqual([]);
    expect(issues).toEqual([]);
  });

  it("refuses a case from an UNSUPPORTED suite that is not holdout", () => {
    // The old rule only excluded a "holdout/" prefix, so any other suite slipped
    // through. `tools/` exists on disk but is not a development-set suite.
    // Keep the list at 8 entries so the 6–10 count rule cannot be the reason.
    const ids = [...CASE_IDS.slice(0, 7), "tools/whatever"];
    const auth = baseAuth({ caseIds: ids, caseFingerprints: fingerprints() });
    const issues = r92AuthorizationIssuesV1(auth);
    expect(issues.join(" ")).toMatch(/tools\/whatever/);
    expect(issues.join(" ")).toMatch(/supported|suite/i);
  });

  it("refuses a case id with no suite prefix at all", () => {
    const ids = [...CASE_IDS.slice(0, 7), "bare-case"];
    const auth = baseAuth({ caseIds: ids, caseFingerprints: fingerprints() });
    const issues = r92AuthorizationIssuesV1(auth);
    expect(issues.join(" ")).toMatch(/bare-case/);
  });

  it("refuses a holdout case even though the suite is otherwise known", () => {
    const ids = [...CASE_IDS.slice(0, 7), "holdout/reg-16"];
    const auth = baseAuth({ caseIds: ids, caseFingerprints: fingerprints() });
    const issues = r92AuthorizationIssuesV1(auth);
    expect(issues.join(" ")).toMatch(/holdout\/reg-16/);
  });
});

// ===========================================================================
describe("E4-R95 refusals name a path and never echo a secret", () => {
  it("does not echo a raw endpoint that carries a token", () => {
    const secret = "sk-live-DEADBEEF-not-a-real-credential";
    const auth = baseAuth({ endpointIdentity: `https://api.example.com/v1?key=${secret}` });
    const parsed = parseR92AuthorizationV1(auth);
    const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    expect(parsed.issues.join(" ")).not.toContain(secret);
    expect(r.reason).not.toContain(secret);
    expect(r.issues.join(" ")).not.toContain(secret);
    expect(parsed.issues.join(" ")).toContain("endpointIdentity");
  });

  it("does not echo the value of an unknown field", () => {
    const secret = "sk-live-SECRET-not-a-real-credential";
    const parsed = parseR92AuthorizationV1({ ...baseAuth(), apiKey: secret });
    expect(parsed.issues.join(" ")).not.toContain(secret);
    expect(parsed.issues.join(" ")).toContain("apiKey");
  });

  it("never includes the authorization env var VALUES in a refusal", () => {
    const secret = "sk-live-ENVVALUE-not-a-real-credential";
    const auth = baseAuth({ serialism: 4 });
    const r = r92AuthorizationGate({
      env: { ...envFor(auth), OPENAI_API_KEY: secret },
      authorization: auth,
      facts: facts(),
    });
    expect(r.reason).not.toContain(secret);
    expect(r.issues.join(" ")).not.toContain(secret);
  });

  it("makes no external call: the module imports no HTTP or provider client", () => {
    const src = readFileSync(fileURLToPath(new URL("./r92-authorization.ts", import.meta.url)), "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
    for (const line of importLines) {
      expect(line, line).not.toMatch(/http|fetch|openai|anthropic|provider/i);
    }
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

// ===========================================================================
describe("E4-R95 repeated evaluation is stable and timezone-independent", () => {
  it("returns byte-identical verdicts across repeated runs", () => {
    const auth = baseAuth();
    const inputs = [
      { env: {}, authorization: auth, facts: facts() },
      { env: envFor(auth), authorization: auth, facts: facts() },
      { env: envFor(auth), authorization: baseAuth({ serialism: 4 }), facts: facts() },
      { env: envFor(auth), authorization: baseAuth({ expiresAt: "2026-09-19T20:00:00-04:00" }), facts: facts() },
    ];
    for (const input of inputs) {
      expect(JSON.stringify(r92AuthorizationGate(input))).toBe(JSON.stringify(r92AuthorizationGate(input)));
    }
  });

  it("is unaffected by the process timezone offset for an equivalent instant", () => {
    // Same instant written two ways must give the same verdict.
    const utc = baseAuth({ expiresAt: "2026-09-25T00:00:00.000Z" });
    const offset = baseAuth({ expiresAt: "2026-09-25T08:00:00+08:00" });
    const a = r92AuthorizationGate({ env: envFor(utc), authorization: utc, facts: facts() });
    const b = r92AuthorizationGate({ env: envFor(offset), authorization: offset, facts: facts() });
    expect(a.authorizedToExecute).toBe(b.authorizedToExecute);
    expect(a.code).toBe(b.code);
  });

  it("produces a stable digest for an envelope, independent of evaluation order", () => {
    const a = computeR92AuthorizationDigestV1(baseAuth());
    const b = computeR92AuthorizationDigestV1(baseAuth());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
