import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { computeExecutionPlanDigest, type ExecutionPlanV1, type ExecutionPlanIsolationStrength } from "./execution-plan.js";
import { DEFAULT_DECISION_POLICY_V3, computeThresholdDigestV3, type DecisionPolicyV3 } from "./decision-policy-v3.js";

const PREFIX = "harness-eval-";
const createdPaths: string[] = [];

function tmpRoot(): string {
  return resolve(tmpdir()) + sep;
}

function isUnderTmp(path: string): boolean {
  return resolve(path).toLowerCase().startsWith(tmpRoot().toLowerCase());
}

/**
 * Create a temporary workspace for eval fixtures (test-only).
 *
 * Relative keys may contain ".." to place files OUTSIDE the workspace
 * (path-traversal fixtures, e.g. { "../escape.txt": "secret" }). Paths that
 * would escape `os.tmpdir()` are rejected so cleanup() stays safe. All created
 * paths are tracked and removed by cleanup().
 */
export async function makeTempWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(tmpdir() + sep + PREFIX);
  createdPaths.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(root, rel);
    if (!isUnderTmp(abs)) {
      throw new Error(`fixture path escapes temp dir: ${abs}`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    createdPaths.push(abs);
  }
  return root;
}

/** Remove every fixture workspace (and escaped file) created so far. Idempotent. */
export async function cleanup(): Promise<void> {
  for (const path of createdPaths.splice(0)) {
    if (isUnderTmp(path)) {
      // P14-6: fixture cleanup is best-effort — a failure is reported, never
      // silently swallowed (test-teardown evidence).
      await rm(path, { recursive: true, force: true }).catch((err) => {
        process.stderr.write(`[degraded] fixture.cleanup: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  }
}

/**
 * E4-R22 (F02) — build a COMPLETE, protocol-valid execution plan for fixtures.
 *
 * Since promotion-grade artifacts require the full confirmed plan (parsed,
 * digest-bound, cross-bound to the manifest), tests need one canonical way to
 * construct a plan that agrees with their manifest facts (judge 1.0.0,
 * provider fake, model m, gitSha "c".repeat(40) by default). The recorded
 * planDigest is always `computeExecutionPlanDigest(plan)` — never a stand-in
 * like "d".repeat(64).
 */
export function fixtureExecutionPlan(opts: {
  suite: string;
  caseIds: readonly string[];
  repeat: number;
  judgeVersion?: string;
  providerId?: string;
  modelId?: string;
  sourceSha?: string | null;
  candidate?: string | null;
  isolationStrength?: ExecutionPlanIsolationStrength;
  /** E4-R27: a promotion-grade plan must be confirmed on a CLEAN source tree,
   *  which the CLI encodes as `treeFingerprint === null` (a non-null fingerprint
   *  MEANS a dirty tree). The default is therefore null; pass a 64-hex value
   *  only to build a dirty-tree (non-promotion-grade) fixture. */
  treeFingerprint?: string | null;
  isolationBackendId?: string;
  /** The pre-registered policy the evaluator will APPLY (default: V3 default). */
  decisionPolicy?: DecisionPolicyV3;
}): ExecutionPlanV1 {
  const policy = opts.decisionPolicy ?? DEFAULT_DECISION_POLICY_V3;
  const fp = (c: string): string => createHash("sha256").update(`${opts.suite}:${c}`, "utf8").digest("hex");
  return {
    schemaVersion: "e4-01",
    suite: opts.suite,
    caseIds: [...opts.caseIds],
    caseFingerprints: Object.fromEntries(opts.caseIds.map((c) => [c, fp(c)])),
    limit: 100,
    repeat: opts.repeat,
    interleave: true,
    shuffle: false,
    seed: 7,
    candidate: opts.candidate === undefined ? "cand-x" : opts.candidate,
    billingClass: "offline",
    maxLogicalRuns: 100,
    maxModelCalls: 100,
    maxEstimatedTokens: 1_000_000,
    maxEstimatedCostUsd: 1,
    estimateStatus: "bounded",
    isolationBackendId: opts.isolationBackendId ?? "fixture-strong",
    isolationStrength: opts.isolationStrength ?? "strong",
    promotionEligible: true,
    providerId: opts.providerId ?? "fake",
    modelId: opts.modelId ?? "m",
    judgeVersion: opts.judgeVersion ?? "1.0.0",
    sourceSha: opts.sourceSha === undefined ? "c".repeat(40) : opts.sourceSha,
    treeFingerprint: opts.treeFingerprint ?? null,
    decisionPolicy: { ...policy },
    thresholdDigest: computeThresholdDigestV3(policy),
    effectiveModelParams: { budgetTokens: 8192 },
  };
}

/** The plan digest to record in a fixture manifest — always derived from the
 *  plan itself (E4-R22: the digest must match the plan content). */
export function fixtureExecutionPlanDigest(opts: Parameters<typeof fixtureExecutionPlan>[0]): string {
  return computeExecutionPlanDigest(fixtureExecutionPlan(opts));
}
