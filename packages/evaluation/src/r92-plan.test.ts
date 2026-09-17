/**
 * E4-R92 — the authorization-ready plan artifact.
 *
 * This is the actual deliverable plan §R92 asks for: a concrete, auditable plan
 * naming the two SHAs, the frozen case list with content fingerprints, the
 * endpoint identity, the enforceable vs blocked caps, the plan digest, the
 * expiry and the output location — and a gate that stays NOT_RUN until a human
 * approves THIS plan.
 *
 * The generator is deliberately side-effect-free with respect to money: it
 * builds the envelope from repository facts and computes the digest. It never
 * constructs a provider.
 */

import { describe, expect, it } from "vitest";
import { buildR92AuthorizationPlan } from "./r92-plan.js";
import { r92AuthorizationGate, r92CapViolations } from "./r92-authorization.js";

const REPO = process.cwd();

describe("E4-R92 the authorization-ready plan binds real repository facts", () => {
  it("selects 6-10 real non-holdout cases and fingerprints their content", async () => {
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    expect(plan.authorization.caseIds.length).toBeGreaterThanOrEqual(6);
    expect(plan.authorization.caseIds.length).toBeLessThanOrEqual(10);
    for (const id of plan.authorization.caseIds) {
      expect(id, "no holdout case may enter the dev-set selection").not.toMatch(/^holdout\//);
      expect(plan.authorization.caseFingerprints[id]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is re-derivable without a pinned clock, so the approved digest stays verifiable", async () => {
    // The user approves a digest today; the run happens later. If the digest
    // depended on wall-clock time, the gate would refuse the very digest that
    // was approved. It must be a pure function of repository facts + validity.
    const a = await buildR92AuthorizationPlan({ repoRoot: REPO });
    const b = await buildR92AuthorizationPlan({ repoRoot: REPO });
    expect(a.planDigest).toBe(b.planDigest);
    expect(a.authorization.createdAt).toBe(b.authorization.createdAt);
    // Anchored to the candidate commit, not to "now".
    const commitTime = new Date(
      (await import("node:child_process")).execFileSync("git", ["show", "-s", "--format=%cI", a.authorization.arms.candidate.sha], {
        cwd: REPO,
        encoding: "utf8",
      }).trim(),
    ).toISOString();
    expect(a.authorization.createdAt).toBe(commitTime);
    expect(Date.parse(a.authorization.createdAt)).toBeLessThan(Date.now());
  });

  it("keeps the case order frozen and the digest reproducible for fixed inputs", async () => {
    const clock = "2026-09-17T00:00:00.000Z";
    const a = await buildR92AuthorizationPlan({ repoRoot: REPO, now: clock });
    const b = await buildR92AuthorizationPlan({ repoRoot: REPO, now: clock });
    // Case order is frozen by the committed selection, not by iteration order.
    expect(a.authorization.caseIds).toEqual(b.authorization.caseIds);
    // The digest binds createdAt, so it is reproducible GIVEN the same clock —
    // which is what makes the value the user approves verifiable.
    expect(a.planDigest).toBe(b.planDigest);
    expect(a.planDigest).toMatch(/^[0-9a-f]{64}$/);
    // A different clock is a different authorization, so the digest must move.
    const other = await buildR92AuthorizationPlan({ repoRoot: REPO, now: "2026-09-18T00:00:00.000Z" });
    expect(other.planDigest).not.toBe(a.planDigest);
  });

  it("binds two real, distinct commits and per-arm build identity", async () => {
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    const { baseline, candidate } = plan.authorization.arms;
    expect(baseline.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(candidate.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.sha).not.toBe(candidate.sha);
    expect(plan.authorization.armIdentityMode).toBe("isolated-checkout-build");
    // The candidate arm is the revision that carries the H2 fix.
    expect(plan.facts.candidateContainsH2Fix).toBe(true);
    expect(plan.facts.baselineContainsH2Fix).toBe(false);
  });

  it("states the fix scope as single-fix-H2 and explains it", async () => {
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    expect(plan.authorization.fixScope).toBe("single-fix-H2");
    expect(plan.authorization.fixScopeStatement).toMatch(/H2/);
    expect(plan.authorization.jointAttributionNote).toBeNull();
  });

  it("declares the enforceable caps and marks the unprovable USD cap BLOCKED", async () => {
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    const caps = plan.authorization.caps;
    const globalCalls = caps.find((c) => c.cap === "maxModelCalls")!;
    expect(globalCalls.enforcement).toBe("runtime-enforced");
    expect(globalCalls.blocked).toBe(false);
    expect(globalCalls.value).toBeGreaterThan(0);

    const usd = caps.find((c) => c.cap === "maxEstimatedCostUsd")!;
    expect(usd.enforcement).toBe("unprovable");
    // Declaring no USD hard cap is the honest posture; the unknown is named.
    expect(plan.authorization.unknownCostItems.length).toBeGreaterThan(0);

    // The plan as built must not carry a cap the layer cannot enforce.
    expect(r92CapViolations(caps)).toEqual([]);
  });

  it("refuses to run until the user approves THIS digest", async () => {
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    // No authorization in the environment at all.
    const g = r92AuthorizationGate({
      env: {},
      authorization: plan.authorization,
      facts: plan.facts.gateFacts,
    });
    expect(g.authorizedToExecute).toBe(false);
    expect(g.planStatus).toBe("READY_FOR_AUTHORIZATION");
    expect(g.runStatus).toBe("NOT_RUN");
    expect(g.code).toBe("PAID_AUTHORIZATION_REQUIRED");
  });

  it("would authorize exactly when the environment carries this plan's own digest", async () => {
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    const g = r92AuthorizationGate({
      env: {
        E4_R92_PAID_AUTH: "1",
        RUN_PAID_BENCHMARKS: "1",
        E4_R92_PAID_AUTH_DIGEST: plan.planDigest,
      },
      authorization: plan.authorization,
      facts: plan.facts.gateFacts,
    });
    expect(g.authorizedToExecute).toBe(true);
    // Even when authorized, the gate never claims a run occurred.
    expect(g.runStatus).toBe("NOT_RUN");
  });

  it("sets an expiry in the future and a non-promotion posture", async () => {
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    expect(Date.parse(plan.authorization.expiresAt)).toBeGreaterThan(Date.parse(plan.authorization.createdAt));
    expect(plan.authorization.promotionEligible).toBe(false);
    expect(plan.authorization.serialism).toBe(1);
    expect(plan.authorization.repetitions).toBe(1);
  });

  it("names the output location and the exact approval materials", async () => {
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    expect(plan.authorization.outputDir).toBeTruthy();
    // The approval package must name every item plan §R92 requires.
    const md = plan.approvalMarkdown;
    for (const needle of [
      "baseline",
      "candidate",
      "endpoint",
      "maxModelCalls",
      "maxEstimatedCostUsd",
      "unknown",
      "digest",
      "expires",
      "output",
      "READY_FOR_AUTHORIZATION",
      "NOT_RUN",
    ]) {
      expect(md.toLowerCase(), `approval package must mention ${needle}`).toContain(needle.toLowerCase());
    }
  });

  it("never claims a real score or a pass-rate improvement while unauthorized", async () => {
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    expect(plan.realScores).toBe(false);
    expect(plan.passRateClaim).toBe(false);
    const md = plan.approvalMarkdown;
    expect(md).not.toMatch(/pass[- ]rate (improved|increased|gain)/i);
  });
});
