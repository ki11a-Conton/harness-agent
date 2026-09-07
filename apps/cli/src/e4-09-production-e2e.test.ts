/**
 * E4-09 — REAL production-path end-to-end (fully offline, zero paid calls).
 *
 * Unlike the old e3-13 test (which ran a benchmark then hand-built V3 artifacts
 * with fabricated passed/verified/security fields), EVERY artifact here is
 * produced by the PREVIOUS real production stage:
 *
 *   fake cases
 *   -> arm-aware deterministic provider (a fake MODEL, but the OUTCOMES emerge
 *      from the real harness running the real arm config: the candidate arm's
 *      budget-aware completion guidance is injected into its system prompt by
 *      the production wiring — the baseline arm has no such guidance — so only
 *      the candidate is driven to write the file the verifier requires)
 *   -> CLI benchmark -> real paired executor
 *   -> canonical V3 (in-process writer, strict-reloaded)
 *   -> real champion evaluator -> DecisionArtifact
 *   -> real promotion envelope + loader + CAS -> applicationPending
 *   -> real createHarness startup -> applied proof
 *   -> observable candidate behavior
 *
 * No buildV3ArtifactPair, no hand-filled booleans.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelEvent, ModelProvider, ModelRef, ProviderConfig } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import {
  runV3ChampionEval,
  buildPromotionEnvelope,
  loadPromotionEnvelope,
  createInitialChampionState,
  applyPromotion,
  championLifecycleStatus,
  PROMOTION_ENVELOPE_POLICY_VERSION,
} from "@ar/evaluation";
import { writeChampionStateFileCas, championStateDigest } from "./champion-state-file.js";
import { createHarnessWithChampion } from "./champion-application.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const GUIDANCE_MARKER = "Budget-aware completion guidance:";
const CANDIDATE = "budget_aware_completion_v1";

/**
 * A deterministic fake provider whose behavior keys on the REAL arm config: the
 * candidate arm's system prompt carries the budget-aware guidance (injected by
 * the production runOneCase wiring only when a candidate is active), so it is
 * told to write the file the verifier requires; the baseline arm is not and
 * never writes. The provider records every call for the exact-call-count
 * assertion and the observable behavior check.
 */
class ArmAwareProvider implements ModelProvider {
  readonly id = "arm-aware";
  readonly calls: { seq: number; arm: "candidate" | "baseline"; wrote: boolean }[] = [];
  private seq = 0;
  async listModels() {
    return [{ id: "arm-aware-model", name: "ArmAware" }];
  }
  createClient(_model: ModelRef, _config: ProviderConfig) {
    const self = this;
    return {
      async *generate(request: unknown, _signal: AbortSignal): AsyncIterable<ModelEvent> {
        const req = (request ?? {}) as { system?: unknown; messages?: unknown };
        const sys = typeof req.system === "string" ? req.system : "";
        const isCandidate = sys.includes(GUIDANCE_MARKER);
        const alreadyWrote = JSON.stringify(req.messages ?? "").includes("write_file");
        const shouldWrite = isCandidate && !alreadyWrote;
        self.calls.push({ seq: self.seq++, arm: isCandidate ? "candidate" : "baseline", wrote: shouldWrite });
        const script = shouldWrite
          ? ScriptedModelProvider.toolCall("write_file", { path: "out.txt", content: "done by candidate\n" })
          : ScriptedModelProvider.text("done");
        yield* script;
      },
    };
  }
}

let tempDirs: string[] = [];
afterEach(async () => {
  vi.doUnmock("@ar/evaluation");
  vi.resetModules();
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeCaseDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e4-09-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    if (rel.includes("/")) await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return dir;
}

/** Mock the isolation probe so the promotion run is strong / promotion-eligible
 *  (the offline stand-in for a real OS sandbox backend). */
async function importBenchmarkWithStrongIsolation() {
  vi.resetModules();
  vi.doMock("@ar/evaluation", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@ar/evaluation")>();
    return {
      ...actual,
      probeIsolationBackend: (async () => ({
        schemaVersion: 1, id: "mock-bwrap", platform: "test", strongIsolation: true, note: "e4-09 test backend",
      })) as unknown as typeof actual.probeIsolationBackend,
    };
  });
  return import("./benchmark-command.js");
}

describe("E4-09 real production-path E2E (offline)", () => {
  it("benchmark -> V3 -> evaluator -> promote -> createHarness -> applied, all real stages", async () => {
    // 3 cases, each requiring the agent to produce out.txt (artifact verification).
    const caseJson = JSON.stringify({ verification: [{ kind: "artifact", path: "out.txt", mustChange: true }] });
    const root = await makeCaseDir({
      "cases/a/request.md": "Produce out.txt.",
      "cases/a/expected.md": "out.txt exists.",
      "cases/a/case.json": caseJson,
      "cases/b/request.md": "Produce out.txt.",
      "cases/b/expected.md": "out.txt exists.",
      "cases/b/case.json": caseJson,
      "cases/c/request.md": "Produce out.txt.",
      "cases/c/expected.md": "out.txt exists.",
      "cases/c/case.json": caseJson,
    });
    const outDir = join(root, "out");

    // STAGE 1: real CLI benchmark, real paired executor, strong isolation.
    const bench = await importBenchmarkWithStrongIsolation();
    const provider = new ArmAwareProvider();
    const res = await bench.runBenchmarkCommand(
      ["--cases", join(root, "cases"), "--candidate", CANDIDATE, "--repeat", "2", "--out", outDir],
      provider,
    );
    expect(res.exitCode).toBe(0);
    expect(res.lines.join("\n")).toContain("canonical V3 artifacts written + strict-reloaded");

    // STAGE 2: the V3 artifacts are REAL files produced by the executor's writer.
    const v3BaselinePath = join(outDir, "v3-baseline.json");
    const v3CandidatePath = join(outDir, "v3-candidate.json");
    const candV3 = JSON.parse(await readFile(v3CandidatePath, "utf8")) as {
      manifest: { promotionEligible: boolean; isolationStrength: string };
      outcomes: { passed: boolean }[];
    };
    const baseV3 = JSON.parse(await readFile(v3BaselinePath, "utf8")) as { outcomes: { passed: boolean }[] };
    expect(candV3.manifest.promotionEligible).toBe(true); // strong isolation
    expect(candV3.manifest.isolationStrength).toBe("strong");
    // OBSERVABLE candidate behavior (not fabricated, not mere config equality):
    // the champion's budget-aware guidance changed the agent's real ACTIONS —
    // the candidate wrote the file every repetition, the baseline never did.
    expect(candV3.outcomes.every((o) => o.passed)).toBe(true);
    expect(baseV3.outcomes.every((o) => !o.passed)).toBe(true);
    expect(provider.calls.some((c) => c.arm === "candidate" && c.wrote)).toBe(true);
    expect(provider.calls.every((c) => c.arm === "candidate" || !c.wrote)).toBe(true);

    // STAGE 3: real evaluator derives the decision from the real V3 files.
    const evalResult = await runV3ChampionEval({
      baselinePath: v3BaselinePath,
      candidatePath: v3CandidatePath,
      candidateId: CANDIDATE,
    });
    expect(evalResult.decisionArtifact.decision).toBe("ACCEPT");

    // STAGE 4: real promotion bundle (decision artifact file + envelope).
    const bundleDir = join(root, "bundle");
    await mkdir(bundleDir, { recursive: true });
    const decisionArtifactPath = join(bundleDir, "decision-artifact.json");
    await writeFile(decisionArtifactPath, JSON.stringify(evalResult.decisionArtifact), "utf8");
    const [da, base, cand] = await Promise.all([
      readFile(decisionArtifactPath, "utf8"), readFile(v3BaselinePath, "utf8"), readFile(v3CandidatePath, "utf8"),
    ]);
    const c0 = createInitialChampionState();
    const envelope = buildPromotionEnvelope({
      generatedBy: "e4-09",
      decisionEnvelopeDigest: sha(JSON.stringify(evalResult.decisionArtifact.statistics)),
      candidateId: CANDIDATE,
      parentLevel: "C0",
      parentStateDigest: championStateDigest(c0),
      decisionArtifactPath,
      decisionArtifactDigest: sha(da),
      artifactRefs: [
        { role: "baseline", path: v3BaselinePath, digest: sha(base) },
        { role: "candidate", path: v3CandidatePath, digest: sha(cand) },
      ],
      sourceSha: null,
    });
    const envPath = join(bundleDir, "envelope.json");
    await writeFile(envPath, JSON.stringify(envelope), "utf8");

    // STAGE 5: real loader verifies the bundle; promote -> applicationPending.
    const statePath = join(root, "champion-state.json");
    await writeChampionStateFileCas(c0, championStateDigest(c0), statePath);
    const verified = await loadPromotionEnvelope(envPath, {
      parentStateDigest: championStateDigest(c0),
      candidateId: CANDIDATE,
      expectedPolicyVersion: PROMOTION_ENVELOPE_POLICY_VERSION,
      verifyArtifactRefs: true,
      bundleRoot: root,
    });
    expect(verified.ok).toBe(true);
    const pending = applyPromotion(c0, CANDIDATE, {}, decisionArtifactPath, {
      envelopeDigest: envelope.contentDigest,
      decisionEnvelopeDigest: envelope.decisionEnvelopeDigest,
    });
    const cas = await writeChampionStateFileCas(pending, championStateDigest(c0), statePath);
    expect(cas.ok).toBe(true);
    expect(championLifecycleStatus(pending)).toBe("APPLICATION_PENDING");

    // STAGE 6: real createHarness startup applies + proves.
    const dataDir = join(root, "runtime-data");
    const startup = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: {
        cwd: root,
        dataDir,
        profile: "interactive",
        modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("hi")]),
        model: { providerId: "scripted", modelId: "m" },
      },
      stateFilePath: statePath,
      sourceSha: null,
    });
    try {
      expect(startup.status).toBe("applied");
      expect(startup.proof).not.toBeNull();
      // The applied runtime really runs the champion profile.
      expect(startup.harness.resolvedConfig.value.profile).toBe("champion");
      const saved = JSON.parse(await readFile(statePath, "utf8")) as { applied: boolean; appliedProof?: { appliedConfigHash: string; targetConfigHash: string } };
      expect(saved.applied).toBe(true);
      expect(saved.appliedProof?.appliedConfigHash).toBe(saved.appliedProof?.targetConfigHash);
    } finally {
      await startup.harness.close();
    }
  }, 60_000);
});

/**
 * E4-09 adversarial E2E — attacks on the REAL chain artifacts. Each proves a
 * tamper of a genuine production-stage artifact is rejected by the next stage,
 * and that the provider-call guard stops an over-budget run before it can
 * produce a promotable artifact.
 */
async function buildRealChain(root: string): Promise<{
  v3BaselinePath: string; v3CandidatePath: string; decisionArtifactPath: string;
  evalResult: Awaited<ReturnType<typeof runV3ChampionEval>>;
}> {
  const caseJson = JSON.stringify({ verification: [{ kind: "artifact", path: "out.txt", mustChange: true }] });
  for (const c of ["a", "b", "c"]) {
    const dir = join(root, "cases", c);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "request.md"), "Produce out.txt.", "utf8");
    await writeFile(join(dir, "expected.md"), "out.txt exists.", "utf8");
    await writeFile(join(dir, "case.json"), caseJson, "utf8");
  }
  const outDir = join(root, "out");
  const bench = await importBenchmarkWithStrongIsolation();
  const res = await bench.runBenchmarkCommand(
    ["--cases", join(root, "cases"), "--candidate", CANDIDATE, "--repeat", "2", "--out", outDir],
    new ArmAwareProvider(),
  );
  expect(res.exitCode).toBe(0);
  const v3BaselinePath = join(outDir, "v3-baseline.json");
  const v3CandidatePath = join(outDir, "v3-candidate.json");
  const evalResult = await runV3ChampionEval({ baselinePath: v3BaselinePath, candidatePath: v3CandidatePath, candidateId: CANDIDATE });
  expect(evalResult.decisionArtifact.decision).toBe("ACCEPT");
  const bundleDir = join(root, "bundle");
  await mkdir(bundleDir, { recursive: true });
  const decisionArtifactPath = join(bundleDir, "decision-artifact.json");
  await writeFile(decisionArtifactPath, JSON.stringify(evalResult.decisionArtifact), "utf8");
  return { v3BaselinePath, v3CandidatePath, decisionArtifactPath, evalResult };
}

async function envelopeFor(root: string, chain: Awaited<ReturnType<typeof buildRealChain>>, mutate?: (env: ReturnType<typeof buildPromotionEnvelope>) => void): Promise<string> {
  const [da, base, cand] = await Promise.all([
    readFile(chain.decisionArtifactPath, "utf8"), readFile(chain.v3BaselinePath, "utf8"), readFile(chain.v3CandidatePath, "utf8"),
  ]);
  const c0 = createInitialChampionState();
  const envelope = buildPromotionEnvelope({
    generatedBy: "e4-09-adv",
    decisionEnvelopeDigest: sha("stats"),
    candidateId: CANDIDATE,
    parentLevel: "C0",
    parentStateDigest: championStateDigest(c0),
    decisionArtifactPath: chain.decisionArtifactPath,
    decisionArtifactDigest: sha(da),
    artifactRefs: [
      { role: "baseline", path: chain.v3BaselinePath, digest: sha(base) },
      { role: "candidate", path: chain.v3CandidatePath, digest: sha(cand) },
    ],
    sourceSha: null,
  });
  if (mutate) mutate(envelope);
  const envPath = join(root, "bundle", "envelope.json");
  await writeFile(envPath, JSON.stringify(envelope), "utf8");
  return envPath;
}

describe("E4-09 adversarial E2E (real chain)", () => {
  it("editing a real V3 artifact's outcomes while only updating the file SHA breaks the chain", async () => {
    const root = await makeCaseDir({});
    const chain = await buildRealChain(root);
    // Tamper the candidate artifact's outcomes; recompute the envelope file SHA.
    const cand = JSON.parse(await readFile(chain.v3CandidatePath, "utf8")) as { outcomes: { passed: boolean }[]; contentDigest: string };
    cand.outcomes[0]!.passed = false; // leave the internal contentDigest stale
    await writeFile(chain.v3CandidatePath, JSON.stringify(cand), "utf8");
    const envPath = await envelopeFor(root, chain, (env) => {
      // attacker refreshes the ref digest to the new bytes (as far as they can reach)
      env.artifactRefs.find((r) => r.role === "candidate")!.digest = sha(JSON.stringify(cand));
    });
    const verified = await loadPromotionEnvelope(envPath, {
      candidateId: CANDIDATE, expectedPolicyVersion: PROMOTION_ENVELOPE_POLICY_VERSION, verifyArtifactRefs: true, bundleRoot: root,
    });
    expect(verified.ok).toBe(false);
    expect(verified.issues.map((i) => i.code)).toContain("ARTIFACT_NOT_V3");
  }, 60_000);

  it("a forged decision field (digest recomputed) is caught by the evaluator replay", async () => {
    const root = await makeCaseDir({});
    const chain = await buildRealChain(root);
    const da = JSON.parse(await readFile(chain.decisionArtifactPath, "utf8")) as Record<string, unknown>;
    da.statistics = { ...(da.statistics as Record<string, unknown>), netPassedDelta: 999 };
    const { computeDecisionArtifactContentDigestV3 } = await import("@ar/evaluation");
    da.contentDigest = computeDecisionArtifactContentDigestV3(da);
    await writeFile(chain.decisionArtifactPath, JSON.stringify(da), "utf8");
    const envPath = await envelopeFor(root, chain);
    const verified = await loadPromotionEnvelope(envPath, {
      candidateId: CANDIDATE, expectedPolicyVersion: PROMOTION_ENVELOPE_POLICY_VERSION, verifyArtifactRefs: true, bundleRoot: root,
    });
    expect(verified.ok).toBe(false);
    expect(verified.issues.map((i) => i.code)).toContain("DECISION_REPLAY_MISMATCH");
  }, 60_000);

  it("a candidate ref pointing outside the bundle root is rejected", async () => {
    const root = await makeCaseDir({});
    const chain = await buildRealChain(root);
    const envPath = await envelopeFor(root, chain, (env) => {
      env.artifactRefs.find((r) => r.role === "candidate")!.path = join(root, "..", "outside", "candidate.json");
    });
    const verified = await loadPromotionEnvelope(envPath, {
      candidateId: CANDIDATE, expectedPolicyVersion: PROMOTION_ENVELOPE_POLICY_VERSION, verifyArtifactRefs: true, bundleRoot: root,
    });
    expect(verified.ok).toBe(false);
    expect(verified.issues.map((i) => i.code)).toContain("PATH_OUTSIDE_BUNDLE");
  }, 60_000);

  it("provider over-call guard halts the paired run before it can finalize a promotable artifact", async () => {
    const root = await makeCaseDir({});
    const caseJson = JSON.stringify({ verification: [{ kind: "artifact", path: "out.txt", mustChange: true }] });
    for (const c of ["a", "b", "c"]) {
      const dir = join(root, "cases", c);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "request.md"), "Produce out.txt.", "utf8");
      await writeFile(join(dir, "expected.md"), "x", "utf8");
      await writeFile(join(dir, "case.json"), caseJson, "utf8");
    }
    const bench = await importBenchmarkWithStrongIsolation();
    // A budget of 1 model call cannot complete 3 cases x 2 reps x 2 arms.
    const res = await bench.runBenchmarkCommand(
      ["--cases", join(root, "cases"), "--candidate", CANDIDATE, "--repeat", "2", "--max-model-calls", "1", "--out", join(root, "out")],
      new ArmAwareProvider(),
    );
    // The run must be refused BEFORE any provider call (budget guard) and must
    // NOT produce a complete promotable paired artifact.
    expect(res.exitCode).not.toBe(0);
    const out = res.lines.join("\n");
    expect(out).toMatch(/exceeds --max-model-calls|STOPPED EARLY|partial/i);
    expect(out).not.toMatch(/canonical V3 artifacts written \+ strict-reloaded/);
  }, 60_000);
});
