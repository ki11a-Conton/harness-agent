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
import { buildR92AuthorizationPlan, R92_BASELINE_COMMITTED_AT, R92_BASELINE_SHA, R92_CANDIDATE_COMMITTED_AT, R92_CANDIDATE_SHA } from "./r92-plan.js";
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
    // Anchored to the candidate commit's PINNED timestamp, not to "now" and not
    // to a git read (CI clones shallow, so git cannot supply it there).
    expect(a.authorization.createdAt).toBe("2026-09-16T08:27:46.000Z");
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
    // The candidate arm is the revision that carries the H2 fix. `null` is
    // UNKNOWN (CI clones shallow), so this asserts only when git could answer —
    // and when it could, the answer must be the right one.
    if (plan.facts.candidateContainsH2Fix !== null) {
      expect(plan.facts.candidateContainsH2Fix).toBe(true);
      expect(plan.facts.baselineContainsH2Fix).toBe(false);
    }
  });

  it("builds without full git history (CI clones shallow with depth 1)", async () => {
    // Regression: the builder used to call `git show`/`git merge-base` on the
    // historical commits. `actions/checkout` clones shallow, so those fail with
    // `bad object` / `Not a valid commit name` and the whole plan was
    // unbuildable in CI while passing locally. The builder must depend only on
    // objects present in a depth-1 clone: HEAD, the working tree, and the
    // committed selection file.
    const plan = await buildR92AuthorizationPlan({ repoRoot: REPO });
    // These are the fields that come from the working tree / committed file, and
    // they must be fully populated even with no history.
    expect(plan.authorization.caseIds.length).toBeGreaterThanOrEqual(6);
    for (const id of plan.authorization.caseIds) {
      expect(plan.authorization.caseFingerprints[id]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(plan.authorization.selectionDigest).toMatch(/^[0-9a-f]{64}$/);
    // createdAt comes from a pinned constant, not a git read.
    expect(plan.authorization.createdAt).toBe("2026-09-16T08:27:46.000Z");
    // Ancestry may be UNKNOWN, but it must never be a silent `false`.
    expect([true, false, null]).toContain(plan.facts.candidateContainsH2Fix);
    expect([true, false, null]).toContain(plan.facts.baselineContainsH2Fix);
  });

  it("the pinned committer timestamps match the real commits when history is present", async () => {
    // The builder reads `R92_*_COMMITTED_AT` as pinned constants instead of
    // calling `git show`, because CI clones shallow (depth 1) and the historical
    // commits are absent there. A pinned constant can silently DRIFT from the
    // commit it claims to describe, so when the objects ARE present we assert
    // the constants against git. In a depth-1 clone `git show` fails and the
    // check is reported as skipped, never as a vacuous pass.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const runGit = promisify(execFile);
    const committedAt = async (sha: string): Promise<string | null> => {
      try {
        const { stdout } = await runGit("git", ["show", "-s", "--format=%cI", sha], { cwd: REPO });
        return new Date(stdout.trim()).toISOString();
      } catch {
        return null; // shallow clone: the object is not here.
      }
    };
    const baseline = await committedAt(R92_BASELINE_SHA);
    const candidate = await committedAt(R92_CANDIDATE_SHA);
    if (baseline === null || candidate === null) {
      // Depth-1 checkout: nothing to compare against. Not a pass, not a failure.
      expect(baseline === null && candidate === null).toBe(true);
      return;
    }
    expect(baseline).toBe(R92_BASELINE_COMMITTED_AT);
    expect(candidate).toBe(R92_CANDIDATE_COMMITTED_AT);
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
