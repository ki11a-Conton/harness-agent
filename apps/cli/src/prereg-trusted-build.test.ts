/**
 * R5 — the audited TRUSTED-BUILD posture.
 *
 * The fixture capability (R1) answers "may this process run code the HARNESS
 * generated?". This suite pins the other question: "may this process run TWO REAL,
 * operator-built arms of this repository?" — and it pins that the answer is a
 * DECLARED mode inside the digest-bound pre-registration, not a marker, not an env
 * variable, and not a flag.
 *
 * THE INVARIANTS
 * --------------
 *   1. `trusted-build`/`no-os-network-sandbox` is the ONLY added posture, its name
 *      states the honest limitation (NO OS network sandbox), and the executor
 *      supports exactly the two declared contracts.
 *   2. The mode is self-proving: BOTH checkouts must be clean git work trees at a
 *      40-hex HEAD with resolving, DIFFERING execution closures. Every violation
 *      is refused BEFORE any provider call.
 *   3. The optional host grant makes "swapped SHA / swapped closure / swapped
 *      directory" refusals precise, and a grant for one directory can never be
 *      applied to another.
 *   4. The POSITIVE path really spawns the shipped worker against the arm's own
 *      build entry and writes the per-arm evidence (manifest build digest + entry
 *      hash + probe) — with ZERO provider calls, because the stub arm makes none.
 *   5. Untrusted checkouts stay refused: without the declared mode, a real
 *      checkout with no fixture capability is still EGRESS_ISOLATION_UNAVAILABLE.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "@ar/contracts";
import {
  PREREG_RUN_EVIDENCE_FILENAMES,
  computeArmBuildDigestV1,
  type PreregisteredArmContext,
  type PreregisteredArmOutcome,
} from "@ar/evaluation";
import {
  ARM_BUILD_IDENTICAL,
  ARM_ISOLATION_UNSUPPORTED,
  EGRESS_ISOLATION_UNAVAILABLE,
  TRUSTED_BUILD_BACKEND_ID,
  TRUSTED_BUILD_NETWORK_SANDBOX,
  TRUSTED_BUILD_NOT_PROVEN,
  TRUSTED_BUILD_STRENGTH,
  createPreregArmExecutor,
  createTrustedBuildGrant,
  isTrustedBuildGrant,
} from "./prereg-arm-executor.js";

const REPO_ROOT = process.cwd();
const FROZEN_CASE = "reg-12-csv-parse";

/** A provider that counts every model call — so "refused before the provider"
 *  is a MEASURED zero, not an assumption. */
function countingProvider(): { provider: ModelProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      id: "r5-counting",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          async *generate() {
            calls += 1;
            yield { type: "text_delta", text: "should never be reached", timestamp: 0 };
            yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
          },
        };
      },
    },
    calls: () => calls,
  };
}

const dirs: string[] = [];
async function tempDir(tag: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `r5-${tag}-`));
  dirs.push(d);
  return d;
}

const COMMON_ENTRIES = [
  "apps/cli/dist/main.js",
  "apps/cli/dist/benchmark-command.js",
  "packages/model/dist/index.js",
  "packages/core/dist/index.js",
  "packages/evaluation/dist/index.js",
];

/**
 * Build a MINIMAL arm tree whose DECLARED closure resolves, so the executor's
 * build-identity checks are exercised for real without a 10-minute `pnpm build`.
 * `probe` makes the two arms differ; `abiLess` removes the probe export.
 */
async function makeStubArm(dir: string, opts: { probe: string; abiLess?: boolean; clean?: boolean; git?: boolean }): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: `r5-arm-${opts.probe}`, private: true, type: "module" }, null, 2)}\n`, "utf8");
  for (const rel of COMMON_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    const body =
      rel === "apps/cli/dist/benchmark-command.js"
        ? [
            opts.abiLess ? `const REMOVED_R97_ARM_PROBE = ${JSON.stringify(opts.probe)};` : `export const R97_ARM_PROBE = ${JSON.stringify(opts.probe)};`,
            "export async function runOneCase(caseDef, opts, suite) {",
            "  void opts;",
            "  return {",
            "    caseId: caseDef.id,",
            '    status: "passed",',
            '    actualStatus: "passed",',
            "    events: [],",
            "    metrics: { turn_count: 0, tool_call_count: 0, tokens_input: 3, tokens_output: 2, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 0 },",
            "    violations: [],",
            "    suite: suite,",
            '    judgeVersion: "r5-stub-judge",',
            "  };",
            "}",
          ].join("\n")
        : `export const R5_STUB = ${JSON.stringify(`${rel}:${opts.probe}`)};`;
    await writeFile(abs, `${body}\n`, "utf8");
  }
  if (opts.git !== false) {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "-c", "user.name=r5", "-c", "user.email=r5@local", "commit", "-q", "-m", `stub arm ${opts.probe}`]);
  }
  if (opts.clean === false) {
    await writeFile(join(dir, "UNCOMMITTED.txt"), "dirty\n", "utf8");
  }
}

interface RunResult {
  outcome: PreregisteredArmOutcome | null;
  refused: string | null;
  calls: number;
}

async function runArm(input: {
  baselineDir: string;
  candidateDir: string;
  isolation: { isolationBackendId: string; isolationStrength: string };
  grant?: unknown;
  evidenceDir: string;
}): Promise<RunResult> {
  const counted = countingProvider();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    R97_ARM_BASELINE_DIR: input.baselineDir,
    R97_ARM_CANDIDATE_DIR: input.candidateDir,
  };
  delete env["R97_ARM_REQUIRE_GIT"];
  const runner = createPreregArmExecutor({
    rootDir: REPO_ROOT,
    env,
    isolation: input.isolation,
    ...(input.grant === undefined ? {} : { trustedBuildGrant: input.grant as never }),
  });
  const ctx: PreregisteredArmContext = {
    provider: counted.provider,
    armRunId: `pair-${FROZEN_CASE}-0-baseline`,
    arm: { armId: "baseline", caseId: FROZEN_CASE, repetition: 0, orderIndex: 0 },
    preregistrationDigest: "a".repeat(64),
    planDigest: "b".repeat(64),
    isolation: input.isolation,
    evidenceDir: input.evidenceDir,
  };
  try {
    const outcome = await runner({ armId: "baseline", caseId: FROZEN_CASE, repetition: 0, orderIndex: 0 }, ctx);
    return { outcome, refused: null, calls: counted.calls() };
  } catch (err) {
    return { outcome: null, refused: (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err)), calls: counted.calls() };
  }
}

const TRUSTED = { isolationBackendId: TRUSTED_BUILD_BACKEND_ID, isolationStrength: TRUSTED_BUILD_STRENGTH };
const FIXTURE_POSTURE = { isolationBackendId: "process-exec", isolationStrength: "process" };

let work: string;
beforeEach(async () => {
  work = await tempDir("work");
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("R5 — the declared trusted-build posture", () => {
  it("[R5.1] the mode's own name declares the limitation it does not remove", () => {
    expect(TRUSTED_BUILD_BACKEND_ID).toBe("trusted-build");
    expect(TRUSTED_BUILD_STRENGTH).toBe("no-os-network-sandbox");
    expect(TRUSTED_BUILD_NETWORK_SANDBOX).toBe("none");
  });

  it("[R5.2] a branded grant pins canonical dir + HEAD + closure + entry, and a look-alike is not a grant", async () => {
    const a = join(work, "arm-g-a");
    const b = join(work, "arm-g-b");
    await makeStubArm(a, { probe: "g-a" });
    await makeStubArm(b, { probe: "g-b" });
    const grant = createTrustedBuildGrant({ baselineDir: a, candidateDir: b });
    expect(isTrustedBuildGrant(grant)).toBe(true);
    expect(grant.pins.map((p) => p.armId)).toEqual(["baseline", "candidate"]);
    expect(grant.pins[0]!.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(grant.pins[0]!.buildDigest).toBe(computeArmBuildDigestV1(a));
    expect(grant.pins[1]!.buildDigest).toBe(computeArmBuildDigestV1(b));
    expect(grant.networkSandbox).toBe("none");
    // The brand is a SYMBOL, so it survives an in-process spread but NOT any
    // JSON/env/marker round trip — which is exactly the fabrication route R1/R5
    // must close. A serialized grant is not a grant.
    expect(isTrustedBuildGrant(JSON.parse(JSON.stringify(grant)))).toBe(false);
    expect(isTrustedBuildGrant({ pins: grant.pins })).toBe(false);
    expect(isTrustedBuildGrant({ ...grant, pins: grant.pins })).toBe(true);
  });

  it("[R5.3] refusing to issue a grant for two IDENTICAL closures is a refusal, not a silent pass", async () => {
    const a = join(work, "arm-same-a");
    const b = join(work, "arm-same-b");
    await makeStubArm(a, { probe: "same" });
    await makeStubArm(b, { probe: "same" });
    // Different directories, byte-identical closures => not a paired experiment.
    let threw: string | null = null;
    try {
      createTrustedBuildGrant({ baselineDir: a, candidateDir: b });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    // Identical bytes in different git repos resolve to the SAME closure digest.
    expect(computeArmBuildDigestV1(a)).toBe(computeArmBuildDigestV1(b));
    expect(threw).toContain(ARM_BUILD_IDENTICAL);
  });

  it("[R5.4] a real checkout with NO declared mode is still refused (untrusted stays untrusted)", async () => {
    const a = join(work, "arm-u-a");
    const b = join(work, "arm-u-b");
    await makeStubArm(a, { probe: "u-a" });
    await makeStubArm(b, { probe: "u-b" });
    const r = await runArm({ baselineDir: a, candidateDir: b, isolation: FIXTURE_POSTURE, evidenceDir: join(work, "ev") });
    expect(r.refused).toBe(EGRESS_ISOLATION_UNAVAILABLE);
    expect(r.calls).toBe(0);
  });

  it("[R5.5] the declared mode refuses a NON-git tree before any provider call", async () => {
    const a = join(work, "arm-ng-a");
    const b = join(work, "arm-ng-b");
    await makeStubArm(a, { probe: "ng-a", git: false });
    await makeStubArm(b, { probe: "ng-b" });
    const r = await runArm({ baselineDir: a, candidateDir: b, isolation: TRUSTED, evidenceDir: join(work, "ev") });
    expect(r.refused).toBe(TRUSTED_BUILD_NOT_PROVEN);
    expect(r.calls).toBe(0);
  });

  it("[R5.6] the declared mode refuses a DIRTY tree with the reason that applies, before any provider call", async () => {
    const a = join(work, "arm-d-a");
    const b = join(work, "arm-d-b");
    await makeStubArm(a, { probe: "d-a", clean: false });
    await makeStubArm(b, { probe: "d-b" });
    const r = await runArm({ baselineDir: a, candidateDir: b, isolation: TRUSTED, evidenceDir: join(work, "ev") });
    expect(r.refused).toBe(TRUSTED_BUILD_NOT_PROVEN);
    expect(r.calls).toBe(0);
    // The env flag is NOT required: the mode itself demands the git identity.
    expect(process.env["R97_ARM_REQUIRE_GIT"]).toBeUndefined();
  });

  it("[R5.7] a grant pinned to ANOTHER directory refuses a swapped checkout, before any provider call", async () => {
    const a = join(work, "arm-s-a");
    const b = join(work, "arm-s-b");
    const other = join(work, "arm-s-other");
    await makeStubArm(a, { probe: "s-a" });
    await makeStubArm(b, { probe: "s-b" });
    await makeStubArm(other, { probe: "s-other" });
    const grant = createTrustedBuildGrant({ baselineDir: other, candidateDir: b });
    expect(isTrustedBuildGrant(grant)).toBe(true);
    const r = await runArm({ baselineDir: a, candidateDir: b, isolation: TRUSTED, grant, evidenceDir: join(work, "ev") });
    expect(r.refused).toBe(TRUSTED_BUILD_NOT_PROVEN);
    expect(r.calls).toBe(0);
  });

  it("[R5.8] a grant for a DIFFERENT posture is refused as a grant", async () => {
    const a = join(work, "arm-p-a");
    const b = join(work, "arm-p-b");
    await makeStubArm(a, { probe: "p-a" });
    await makeStubArm(b, { probe: "p-b" });
    const grant = createTrustedBuildGrant({ baselineDir: a, candidateDir: b });
    const r = await runArm({
      baselineDir: a,
      candidateDir: b,
      isolation: { isolationBackendId: "trusted-build", isolationStrength: "strict" },
      grant,
      evidenceDir: join(work, "ev"),
    });
    expect(r.refused).toBe(ARM_ISOLATION_UNSUPPORTED);
    expect(r.calls).toBe(0);
  });

  it("[R5.9] an unsupported backend is refused before any provider call", async () => {
    const a = join(work, "arm-x-a");
    const b = join(work, "arm-x-b");
    await makeStubArm(a, { probe: "x-a" });
    await makeStubArm(b, { probe: "x-b" });
    const r = await runArm({
      baselineDir: a,
      candidateDir: b,
      isolation: { isolationBackendId: "os-container", isolationStrength: "strict" },
      evidenceDir: join(work, "ev"),
    });
    expect(r.refused).toBe(ARM_ISOLATION_UNSUPPORTED);
    expect(r.calls).toBe(0);
  });

  it("[R5.10] an ABI-less arm (no R97_ARM_PROBE) is refused by the worker boundary with ZERO provider calls", async () => {
    const a = join(work, "arm-abi-a");
    const b = join(work, "arm-abi-b");
    await makeStubArm(a, { probe: "abi-a" });
    await makeStubArm(b, { probe: "abi-b", abiLess: true });
    // The ABI-LESS tree is the one being RUN, so the worker boundary is what
    // decides — not the pair check.
    const r = await runArm({ baselineDir: b, candidateDir: a, isolation: TRUSTED, evidenceDir: join(work, "ev") });
    expect(r.refused).not.toBeNull();
    expect(r.calls).toBe(0);
  });

  it("[R5.11] the POSITIVE path runs the arm's OWN build and writes per-arm evidence with zero provider calls", async () => {
    const a = join(work, "arm-ok-a");
    const b = join(work, "arm-ok-b");
    await makeStubArm(a, { probe: "ok-a" });
    await makeStubArm(b, { probe: "ok-b" });
    const grant = createTrustedBuildGrant({ baselineDir: a, candidateDir: b });
    const evidenceDir = join(work, "evidence");
    const r = await runArm({ baselineDir: a, candidateDir: b, isolation: TRUSTED, grant, evidenceDir });
    expect(r.refused).toBeNull();
    expect(r.calls).toBe(0);
    expect(r.outcome?.status).toBe("passed");

    // The evidence chain: the manifest carries the arm build digest, the ENTRY
    // hash the worker actually loaded, and the build's own versioned probe.
    const manifest = JSON.parse(readFileSync(join(evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.manifest), "utf8")) as Record<string, unknown>;
    expect(manifest["armBuildDigest"]).toBe(computeArmBuildDigestV1(a));
    expect(manifest["armProbe"]).toBe("ok-a");
    expect(typeof manifest["armEntrySha256"]).toBe("string");
    expect(manifest["armId"]).toBe("baseline");
    expect(existsSync(join(evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.verifier))).toBe(true);
    expect(r.outcome?.evidence?.verifiedCompletion).toBe(true);
    expect(r.outcome?.evidence?.traceDigest).toHaveLength(64);
  });
});
