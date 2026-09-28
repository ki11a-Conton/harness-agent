#!/usr/bin/env node
/**
 * R5 — THE REAL DUAL BUILD IN THE FORMAL `prereg run` PATH.
 *
 * WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT
 * --------------------------------------------------
 * The legacy closed loop already runs two REAL checkouts and the real verifier
 * (`scripts/e4/r97-closed-loop.mjs`). That is a different entry point, and its
 * numbers must not be presented as formal acceptance. This script drives the
 * FORMAL command — `preregCmd(["run", …])`, the release CLI's own `prereg run`
 * implementation — with:
 *
 *   - the DECLARED audited isolation posture `trusted-build` /
 *     `no-os-network-sandbox` (it lives in the pre-registration artifact, so the
 *     mode is bound by the artifact digest and by the authorization that names
 *     that digest);
 *   - two GENUINE git checkouts of this repository (the published pair
 *     `8265dc39…` / `ee15e7e7…` by default), enforced as clean work trees at a
 *     40-hex HEAD with resolving, DIFFERING execution closures;
 *   - a test-host OFFLINE scripted provider, so no request is paid and no socket
 *     is opened (the release CLI cannot reach an offline transport by design —
 *     R1 — which is why this composition root exists and why the bare
 *     `main.js prereg run` is reported separately as REFUSED/NOT_RUN);
 *   - the real arm builds' OWN `runOneCase`, which wires the real tool loop and
 *     the real `TaskVerifier`.
 *
 * It reports NOT_OBSERVED / BLOCKED rather than borrowing "564/564 legacy" or
 * "124/124 synthetic" numbers for any of that.
 *
 * PHASES
 * ------
 *   --identity   the published pair's ancestry: HEAD, closure digest, entry hash,
 *                and whether P2-41 (`9df60bd5`) / P2-43 (`a85db6dc`) are PRESENT
 *                IN THE ARM BUILDS. The driver being newer proves nothing about
 *                the arms: the check is `git merge-base --is-ancestor` IN EACH
 *                ARM CHECKOUT.
 *   --formal     the small-sample formal run through `preregCmd(["run", …])`.
 *   --full       the declared formal schedule (all frozen cases).
 *   --content    the INDEPENDENT content-sensitive fixture (non-holdout, not part
 *                of the frozen eight): correct content passes; empty / wrong /
 *                skipped write all fail, with the arm's own verifier evidence.
 *   --negative   swapped SHA, dirty tree, missing ABI, wrong policy: each refused
 *                with ZERO physical model calls.
 *   --all        every phase.
 *
 * USAGE
 * -----
 *   node scripts/e4/r5-real-formal.mjs --all
 *   node scripts/e4/r5-real-formal.mjs --formal --out .ci/r5.json
 *
 * Zero paid requests, zero external network, no credentials.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

export const R5_VERSION = "e4-r5-real-formal-v1";

const EVAL_ENTRY = join(REPO_ROOT, "packages", "evaluation", "dist", "index.js");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "dist", "prereg-command.js");
const IDENTITY_ENTRY = join(REPO_ROOT, "apps", "cli", "dist", "prereg-execution-identity.js");
const RUNNER_ENTRY = join(REPO_ROOT, "apps", "cli", "dist", "prereg-production-runner.js");
const EXECUTOR_ENTRY = join(REPO_ROOT, "apps", "cli", "dist", "prereg-arm-executor.js");
const MODEL_ENTRY = join(REPO_ROOT, "packages", "model", "dist", "index.js");

/** The two protocol fixes this round must be able to state per arm. */
const PROTOCOL_FIXES = [
  { id: "P2-41", sha: "9df60bd5", what: "tool-call transcript ordering" },
  { id: "P2-43", sha: "a85db6dc", what: "provider function-name grammar" },
];

const DEFAULT_PAIR = {
  baseline: join(tmpdir(), "r97-arms-n1pair", "baseline"),
  candidate: join(tmpdir(), "r97-arms-n1pair", "candidate"),
  expectedBaselineHead: "8265dc39",
  expectedCandidateHead: "ee15e7e7",
};

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The environment a formal offline composition root runs under. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of [
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "DEEPSEEK_API_KEY",
    "PREREG_PRICING_JSON",
    "R97_ARM_REQUIRE_GIT",
  ]) {
    delete env[k];
  }
  return { ...env, ...extra };
}

// ---------------------------------------------------------------------------
// Phase: identity / ancestry of the published pair
// ---------------------------------------------------------------------------

async function phaseIdentity() {
  const mod = await import(pathToFileURL(EVAL_ENTRY).href);
  const arms = {};
  for (const [armId, dir] of [
    ["baseline", DEFAULT_PAIR.baseline],
    ["candidate", DEFAULT_PAIR.candidate],
  ]) {
    const exists = existsSync(dir);
    if (!exists) {
      arms[armId] = { dir, exists: false };
      continue;
    }
    const head = git(dir, ["rev-parse", "HEAD"]);
    const porcelain = git(dir, ["status", "--porcelain"]);
    const entries = mod.R97_ARM_BUILD_ENTRIES ?? [];
    const entryRel = entries.find((e) => e.endsWith("benchmark-command.js"));
    let buildDigest = null;
    let entrySha256 = null;
    try {
      buildDigest = mod.computeArmBuildDigestV1(dir);
      entrySha256 = sha256Hex(readFileSync(join(dir, entryRel), "utf8"));
    } catch (err) {
      buildDigest = `UNRESOLVABLE: ${err instanceof Error ? err.message : String(err)}`;
    }
    // PRESENT IN THE ARM? asked of the ARM's OWN git history, never the driver's.
    const fixes = {};
    for (const fix of PROTOCOL_FIXES) {
      let present = null;
      if (head !== null) {
        try {
          execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", fix.sha, head], { stdio: ["ignore", "pipe", "ignore"] });
          present = true;
        } catch {
          present = false;
        }
      }
      fixes[fix.id] = { sha: fix.sha, what: fix.what, presentInArmBuild: present };
    }
    arms[armId] = {
      dir,
      exists: true,
      head,
      headMatchesPublished: head !== null && head.startsWith(armId === "baseline" ? DEFAULT_PAIR.expectedBaselineHead : DEFAULT_PAIR.expectedCandidateHead),
      clean: porcelain === "",
      buildDigest,
      buildDigestShort: typeof buildDigest === "string" && buildDigest.length === 64 ? buildDigest.slice(0, 12) : buildDigest,
      entryRel,
      entrySha256,
      protocolFixes: fixes,
    };
  }
  const distinguishable = arms.baseline.buildDigest !== arms.candidate.buildDigest;
  return {
    pair: "published E4-N1 comparable pair (baseline 8265dc39 / candidate ee15e7e7)",
    arms,
    closuresDistinguishable: distinguishable,
    mechanismDifference:
      "both arms are the SAME repository at different commits; the candidate arm carries the mechanism under test, the baseline arm is the purpose-built comparable baseline (its own commit message: 'neutralize tool_call_efficiency_v1 guidance only'). The arm EXECUTOR passes candidate=TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2 only for the candidate arm, so the mechanism difference is the arm BUILD, not a CLI flag.",
    note:
      "the DRIVER's HEAD is irrelevant to what the arms contain: each fix above is asked of the arm checkout's own git history.",
    driverHead: git(REPO_ROOT, ["rev-parse", "HEAD"]),
  };
}

// ---------------------------------------------------------------------------
// The offline scripted provider (test host; no socket, no credential)
// ---------------------------------------------------------------------------

/** One model CALL's event stream: EXACTLY ONE terminal `completed`, in the shapes
 *  the arm's own `ScriptedModelProvider` emits (`started` + `text_delta` or
 *  `tool_call_delta` + `completed`). Emitting two terminal events in one stream is
 *  a protocol error the runtime retries, so a call emits exactly one step.
 *  Every call reports usage, so the R2 cost journal has real measured tokens. */
function* eventsForCall(steps, counter) {
  const step = steps[0];
  yield { type: "started", timestamp: 0 };
  if (step.tool !== undefined) {
    counter.n += 1;
    const toolCall = { id: `r5-call-${counter.n}`, name: step.tool.name, args: step.tool.args };
    yield { type: "tool_call_delta", toolCall, timestamp: 0 };
    yield { type: "usage", usage: { inputTokens: 12, outputTokens: 6 }, timestamp: 0 };
    yield { type: "completed", result: { finishReason: "tool_calls", toolCalls: [toolCall] }, timestamp: 0 };
  } else {
    yield { type: "text_delta", text: step.text, timestamp: 0 };
    yield { type: "usage", usage: { inputTokens: 12, outputTokens: 6 }, timestamp: 0 };
    yield { type: "completed", result: { finishReason: "stop", text: step.text }, timestamp: 0 };
  }
}

/**
 * A dynamic offline provider: it reads the ACTUAL request it was handed and picks
 * the script for the case whose `request.md` that request carries. Resolving the
 * case from the real context (rather than a call counter) is what makes the tool
 * call genuinely bound to the case the runtime asked about.
 *
 * Per case, the caller's script is one call: the tool write (or the claim-only
 * text). The FOLLOW-UP call (the runtime asks again with the tool result) gets a
 * completing text, so a turn cannot loop and the stream is always total.
 */
function createOfflineScriptedProvider({ caseScripts, transcript }) {
  const counter = { n: 0 };
  const seen = new Map();
  return {
    id: "r5-offline-scripted",
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate(request) {
          const text = JSON.stringify(request ?? {});
          const script = caseScripts.find((c) => c.needle !== null && text.includes(c.needle)) ?? null;
          const caseId = script?.caseId ?? null;
          const callIndex = seen.get(caseId) ?? 0;
          seen.set(caseId, callIndex + 1);
          const variant = script?.variant ?? "text-only";
          let steps;
          if (callIndex === 0 && variant === "write" && script?.writeTarget != null) {
            steps = [
              { tool: { name: "write_file", args: { path: script.writeTarget.path, content: script.writeTarget.content } } },
            ];
          } else if (callIndex === 0 && variant === "wrong-path" && script?.writeTarget != null) {
            steps = [
              { tool: { name: "write_file", args: { path: `${script.writeTarget.path}.not-the-required-path`, content: script.writeTarget.content } } },
            ];
          } else if (callIndex <= 1 && variant === "write") {
            steps = [{ text: `wrote ${script?.writeTarget?.path ?? "the artifact"}` }];
          } else {
            steps = [{ text: "nothing further to do" }];
          }
          transcript.push({ callIndex, caseId, variant, strength: script?.strength ?? null, contentMode: script?.contentMode ?? null, chars: text.length });
          yield* eventsForCall(steps, counter);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Phase: the formal small-sample run through the release CLI's own command
// ---------------------------------------------------------------------------

/**
 * The small sample. It must satisfy the pre-registration's unified minimum
 * (`max(contract.minEligibleCases = 5, policy.minActivationEligibleCases = 3)`),
 * so it is SIX frozen cases — including the artifact-`mustChange` case whose
 * verifier evidence differs between a real tool write and a skipped one.
 */
const SMALL_SAMPLE = [
  "reg-12-csv-parse",
  "reg-15-infinite-loop",
  "adv-artifact-injection",
  "reg-03-add-import",
  "reg-24-error-handling",
];

async function buildArtifactAndAuth({ env, sampleCaseIds, isolationBackendId = "trusted-build", isolationStrength = "no-os-network-sandbox", policyDigestTamper = null, armsRoot = null }) {
  const mod = await import(pathToFileURL(EVAL_ENTRY).href);
  const identityMod = await import(pathToFileURL(IDENTITY_ENTRY).href);
  const resolved = mod.selectionFromFrozenEvidence({ root: REPO_ROOT });
  const profile = identityMod.formalExecutionProfile(env);
  const baselineDir = armsRoot?.baseline ?? env.R97_ARM_BASELINE_DIR;
  const candidateDir = armsRoot?.candidate ?? env.R97_ARM_CANDIDATE_DIR;
  const catalog = sampleCaseIds === null ? resolved.catalog : resolved.catalog.filter((c) => sampleCaseIds.includes(c.caseId));
  const selection = { ...resolved.selection, caseIds: catalog.map((c) => c.caseId) };
  const config = {
    candidateId: "tool_call_efficiency_v1",
    subject: {
      candidateSourceSha: git(REPO_ROOT, ["rev-parse", "HEAD"]),
      baselineArmDigest: mod.computeArmBuildDigestV1(baselineDir),
      candidateArmDigest: mod.computeArmBuildDigestV1(candidateDir),
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: profile.runtimeConfigDigest,
    },
    provider: {
      providerId: profile.provider.providerId,
      modelId: profile.provider.modelId,
      endpointBaseUrl: profile.provider.endpointBaseUrl,
      requestProfile: profile.requestProfile,
    },
    catalog,
    selection,
    suiteId: resolved.suiteId,
    suiteVersion: resolved.suiteVersion,
    evaluation: {
      judgeId: "judge-formal",
      judgeDigest: sha256Hex("judge-formal"),
      verifierDigest: sha256Hex("verifier-formal"),
      scorerDigest: sha256Hex("scorer-formal"),
      decisionPolicy: mod.DEFAULT_DECISION_POLICY_V3,
    },
    schedule: { repetitions: 2, orderSeed: 7 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 100,
      maxDurationMs: 600_000,
      maxInputTokens: 320_000,
      maxOutputTokens: 64_000,
      maxTotalTokens: 384_000,
      // A MONEY-BOUNDED campaign whose authorized maximum is ZERO, priced by the
      // UNBILLED STUB basis (`usdMicrosPerCall = 0`). The cap is enforced, not
      // skipped: no paid path is opened and no credential is read.
      maxUsdMicros: 0,
      pricingUnknownPolicy: "refuse",
    },
    isolation: {
      driverSchema: "r97-driver-v1",
      workerSchema: "r97-worker-v1",
      isolationBackendId,
      isolationStrength,
      resumeStateSchema: "r97-execution-state-v1",
    },
  };
  if (policyDigestTamper !== null) {
    config.evaluation = { ...config.evaluation, decisionPolicy: { ...mod.DEFAULT_DECISION_POLICY_V3, maxTokensDelta: policyDigestTamper } };
  }
  const artifact = mod.buildToolCallEfficiencyPreregistrationV2(config);
  return { artifact, config, serialized: mod.serializePreregistrationV2(artifact), mod, identityMod, resolved };
}

/** The authorization bound to ONE artifact, with a 0-USD cap. */
function authorizationFor(artifact) {
  return {
    schemaVersion: "tool-call-efficiency-authorization-v2",
    preregistrationDigest: artifact.preregistrationDigest,
    candidateSourceSha: artifact.subject.candidateSourceSha,
    baselineArmDigest: artifact.subject.baselineArmDigest,
    candidateArmDigest: artifact.subject.candidateArmDigest,
    providerId: artifact.provider.providerId,
    modelId: artifact.provider.modelId,
    endpointDigest: artifact.provider.endpointDigest,
    caps: {
      maxModelCalls: artifact.budget.campaignWorstCaseModelCalls,
      maxToolCalls: artifact.budget.maxToolCalls,
      maxDurationMs: artifact.budget.maxDurationMs,
      maxInputTokens: artifact.budget.maxInputTokens,
      maxOutputTokens: artifact.budget.maxOutputTokens,
      maxTotalTokens: artifact.budget.maxTotalTokens,
      maxUsdMicros: artifact.budget.maxUsdMicros,
    },
    issuedAtMs: 1_000,
    expiresAtMs: 9_000_000_000_000,
    approvalId: "r5-real-formal-approval",
    allowResume: true,
    paid: true,
  };
}

/** Trusted-build pins for the two real checkouts. */
async function grantFor(env) {
  const execMod = await import(pathToFileURL(EXECUTOR_ENTRY).href);
  return execMod.createTrustedBuildGrant({
    baselineDir: env.R97_ARM_BASELINE_DIR,
    candidateDir: env.R97_ARM_CANDIDATE_DIR,
  });
}

/**
 * CONTENT-SENSITIVE frozen cases and the four variants each is run with.
 *
 * `reg-12-csv-parse` and `reg-15-infinite-loop` are in the frozen catalog
 * (non-holdout, eligible) and their OWN command verifier checks exact bytes:
 *
 *   node -e "import('./src/csv.js').then(m => { const r = m.parse_csv('a, b ,c'); if (r.join('|') !== 'a|b|c') process.exit(1) })"
 *
 * So the arm's REAL TaskVerifier decides on the CONTENT of the file the tool
 * wrote, not on its existence:
 *
 *   correct  the fixed implementation            → the command passes
 *   empty    the file exists but is empty        → the import fails
 *   wrong    a plausible but wrong fix           → the assertion fails
 *   skipped  nothing is written                  → the buggy fixture remains
 *
 * The `wrong` bodies TERMINATE (a still-broken countDown that stops at 1), so a
 * negative cannot hang the campaign.
 */
const CONTENT_FIXES = {
  "reg-12-csv-parse": {
    path: "src/csv.js",
    correct: "export function parse_csv(line) {\n  return line.split(',').map((field) => field.trim());\n}\n",
    empty: "",
    wrong: "export function parse_csv(line) {\n  return line.split(',');\n}\n",
  },
  "reg-15-infinite-loop": {
    path: "src/loop.js",
    correct: "export function countDown(n) {\n  const out = [];\n  let i = n;\n  while (i >= 0) {\n    out.push(i);\n    i -= 1;\n  }\n  return out;\n}\n",
    empty: "",
    wrong: "export function countDown(n) {\n  const out = [];\n  let i = n;\n  while (i > 0) {\n    out.push(i);\n    i -= 1;\n  }\n  return out;\n}\n",
  },
};

async function phaseFormal({ full, workRoot, contentMode = "correct" }) {
  const runnerMod = await import(pathToFileURL(RUNNER_ENTRY).href);
  const cliMod = await import(pathToFileURL(CLI_ENTRY).href);
  const evalMod = await import(pathToFileURL(EVAL_ENTRY).href);
  const samples = full ? null : SMALL_SAMPLE;
  const dir = join(workRoot, full ? "formal-full" : `formal-${contentMode}`);
  await mkdir(dir, { recursive: true });
  const campaignEnv = cleanEnv({
    R97_ARM_BASELINE_DIR: DEFAULT_PAIR.baseline,
    R97_ARM_CANDIDATE_DIR: DEFAULT_PAIR.candidate,
    R97_CAMPAIGN_CLAIMS_DIR: join(dir, "claims"),
  });
  const { artifact, serialized, resolved } = await buildArtifactAndAuth({ env: campaignEnv, sampleCaseIds: samples });
  const preregPath = join(dir, "prereg.json");
  const authPath = join(dir, "auth.json");
  await writeFile(preregPath, serialized, "utf8");
  await writeFile(authPath, `${JSON.stringify(authorizationFor(artifact), null, 2)}\n`, "utf8");

  const budgetDir = join(dir, "budget");
  const outDir = join(dir, "out");
  const grant = await grantFor(campaignEnv);

  // The case scripts. Content-sensitive frozen cases get an explicit fix body
  // (variant per campaign); artifact-only cases get the case's own recoverable
  // target; command-only cases claim completion, which drives them to their REAL
  // verifier — an honest negative, never a fabricated pass.
  const armExec = await import(pathToFileURL(join(REPO_ROOT, "scripts", "e4", "r97-arm-exec.mjs")).href);
  const caseScripts = [];
  for (const c of artifact.dataset.cases) {
    const caseDir = join(REPO_ROOT, "benchmarks", c.suite, c.caseId);
    const def = await armExec.readCaseDef(caseDir, c.caseId);
    const needle = def.requestMd.length > 40 ? def.requestMd.slice(0, 200) : null;
    const content = CONTENT_FIXES[c.caseId];
    if (content !== undefined) {
      const body =
        contentMode === "skipped" ? null : contentMode === "empty" ? content.empty : contentMode === "wrong" ? content.wrong : content.correct;
      caseScripts.push({
        caseId: c.caseId,
        needle,
        writeTarget: body === null ? null : { path: content.path, content: body },
        variant: body === null ? "text-only" : "write",
        strength: "strong",
        contentMode,
      });
    } else if (def.writeTarget !== null) {
      caseScripts.push({ caseId: c.caseId, needle, writeTarget: def.writeTarget, variant: "write", strength: "weak" });
    } else {
      caseScripts.push({ caseId: c.caseId, needle, writeTarget: null, variant: "text-only", strength: null });
    }
  }
  const transcript = [];
  const provider = createOfflineScriptedProvider({ caseScripts, transcript });
  const base = runnerMod.createProductionPreregRunner({ rootDir: REPO_ROOT, env: campaignEnv, trustedBuildGrant: grant });
  const runner = {
    // A test-host observation of the SELECTED subset, re-derived from the same
    // frozen evidence and digest-checked by the same gate.
    observe: async (prereg) => {
      const fullObs = await base.observe(prereg);
      const ids = new Set(prereg.dataset.cases.map((c) => c.caseId));
      const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => ids.has(k)));
      return { ...fullObs, caseContentDigests: pick(fullObs.caseContentDigests), eligibilityDigests: pick(fullObs.eligibilityDigests) };
    },
    makeProvider: async () => provider,
    runArm: base.runArm,
  };

  const result = await cliMod.preregCmd(
    ["run", preregPath, "--authorization", authPath, "--budget-dir", budgetDir, "--out", outDir, "--mode", "first-run"],
    { runner, now: () => 1_700_000_000_000 },
  );

  const recordsDir = join(outDir, "runs");
  const records = existsSync(recordsDir)
    ? readdirSync(recordsDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(recordsDir, f), "utf8")))
    : [];
  const v = (caseId) => records.find((r) => r.caseId === caseId) ?? null;
  const verifierOf = (rec) => {
    if (rec === null || rec === undefined) return null;
    const p = join(recordsDir, "evidence", rec.armRunId, "verifier.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  };
  const manifestOf = (rec) => {
    if (rec === null || rec === undefined) return null;
    const p = join(recordsDir, "evidence", rec.armRunId, "manifest.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  };

  // Independently re-verify every arm's evidence from the bytes it wrote.
  let verified = 0;
  for (const rec of records) {
    if (rec.outcome.status === "error" || rec.outcome.evidence === undefined) continue;
    const res = evalMod.verifyArmEvidenceFromArtifacts(
      join(recordsDir, "evidence", rec.armRunId),
      { preregistrationDigest: rec.preregistrationDigest, planDigest: rec.planDigest, armRunId: rec.armRunId, armId: rec.armId, caseId: rec.caseId, repetition: rec.repetition, orderIndex: rec.orderIndex },
      rec.outcome.evidence,
    );
    if (res.verified) verified += 1;
  }

  const aggregate = existsSync(join(outDir, "aggregate.json")) ? JSON.parse(readFileSync(join(outDir, "aggregate.json"), "utf8")) : null;
  const journal = await evalMod.readCostJournal(budgetDir);
  const recomputed = {};
  {
    const meas = { baseline: 0, candidate: 0 };
    const reserved = { baseline: 0, candidate: 0 };
    for (const e of journal.entries ?? []) {
      const arm = e.arm === "baseline" ? "baseline" : "candidate";
      if (e.basis === "MEASURED") meas[arm] += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
      else reserved[arm] += (e.reservedInputTokens ?? 0) + (e.reservedOutputTokens ?? 0);
    }
    recomputed.total = journal.chargedTotalTokens;
    recomputed.baseline = meas.baseline;
    recomputed.candidate = meas.candidate;
    recomputed.delta = meas.candidate - meas.baseline;
    recomputed.reservedUpperBound = reserved;
  }

  const evidence = {
    sampleCaseIds: artifact.dataset.cases.map((c) => c.caseId),
    scheduledCases: artifact.dataset.cases.length,
    logicalRuns: artifact.schedule.logicalRuns,
    exitCode: result.exitCode,
    lines: result.lines,
    isolation: artifact.isolation,
    providerIdentity: artifact.provider.providerId + "/" + artifact.provider.modelId,
    maxUsdMicros: artifact.budget.maxUsdMicros,
    modelCallsByTranscript: transcript.length,
    physicalProviderCalls: transcript.length,
    records: records.length,
    evidenceVerified: verified,
    contentMode,
    // Per-case verifier evidence, from the RAW `verifier.json` each arm wrote.
    perCase: Object.fromEntries(
      artifact.dataset.cases.map((c) => {
        const script = caseScripts.find((s) => s.caseId === c.caseId);
        return [
          c.caseId,
          {
            scriptStrength: script?.strength ?? null,
            contentMode: script?.contentMode ?? null,
            baseline: verifierOf(records.find((r) => r.caseId === c.caseId && r.armId === "baseline")),
            candidate: verifierOf(records.find((r) => r.caseId === c.caseId && r.armId === "candidate")),
          },
        ];
      }),
    ),
    manifestChain: (() => {
      const rec =
        records.find((r) => r.caseId in CONTENT_FIXES && r.armId === "candidate") ?? records[0] ?? null;
      const man = manifestOf(rec);
      return rec === null
        ? null
        : {
            armRunId: rec.armRunId,
            caseId: rec.caseId,
            armBuildDigest: man?.armBuildDigest ?? null,
            armEntrySha256: man?.armEntrySha256 ?? null,
            armProbe: man?.armProbe ?? null,
            traceDigest: rec.outcome?.evidence?.traceDigest ?? null,
            verifierVerifiedCompletion: rec.outcome?.evidence?.verifiedCompletion ?? null,
            journalRequests: (journal.entries ?? [])
              .filter((e) => e.armRunId === rec.armRunId)
              .map((e) => ({ requestId: e.requestId, attemptId: e.attemptId, reservationId: e.reservationId, basis: e.basis, tokens: e.inputTokens === null ? null : e.inputTokens + e.outputTokens })),
          };
    })(),
    aggregateCost: aggregate?.cost ?? null,
    journalRecomputed: recomputed,
    costMatches: aggregate?.cost != null && aggregate.cost.totalTokens === recomputed.total && aggregate.cost.deltaTokens === recomputed.delta,
    decision: aggregate?.decision?.decision ?? null,
    reasonCodes: aggregate?.decision?.reasonCodes ?? null,
  };
  return { dir, evidence };
}

// ---------------------------------------------------------------------------
// Phase: the independent CONTENT-SENSITIVE fixture, through the real arms
// ---------------------------------------------------------------------------

/**
 * The r98 tool-write fixtures are non-holdout cases that exist OUTSIDE the frozen
 * eight and whose OWN command verifier compares the exact bytes:
 *
 *   node -e "…if(fs.readFileSync('out/r98-request.txt','utf8').trim()!=='r98-request-first-write')process.exit(1)"
 *
 * Four variants through the arm's OWN `runOneCase` (the same entry the formal
 * worker loads) with the arm's OWN `ScriptedModelProvider`:
 *   correct     — writes the required path with the required bytes  → must PASS
 *   empty       — writes the required path with NO bytes            → must FAIL
 *   wrong       — writes the required path with OTHER bytes         → must FAIL
 *   skipped     — writes nothing                                    → must FAIL
 */
async function phaseContent({ workRoot }) {
  const mod = await import(pathToFileURL(EVAL_ENTRY).href);
  const identityMod = await import(pathToFileURL(IDENTITY_ENTRY).href);
  const out = { fixture: "benchmarks/r98-fixtures/r98-tool-write-request (NOT holdout, NOT in the frozen eight)", arms: {} };
  for (const [armId, dir] of [
    ["baseline", DEFAULT_PAIR.baseline],
    ["candidate", DEFAULT_PAIR.candidate],
  ]) {
    if (!existsSync(dir)) {
      out.arms[armId] = { present: false };
      continue;
    }
    const armCli = await import(pathToFileURL(join(dir, "apps", "cli", "dist", "benchmark-command.js")).href);
    const armModel = await import(pathToFileURL(join(dir, "packages", "model", "dist", "index.js")).href);
    const caseDir = join(REPO_ROOT, "benchmarks", "r98-fixtures", "r98-tool-write-request");
    const caseDef = await mod.loadBenchmarkCase(caseDir);
    const profile = identityMod.formalExecutionProfile(cleanEnv());
    const variants = {
      correct: [armModel.ScriptedModelProvider.toolCall("write_file", { path: "out/r98-request.txt", content: "r98-request-first-write" }), armModel.ScriptedModelProvider.text("wrote it")],
      empty: [armModel.ScriptedModelProvider.toolCall("write_file", { path: "out/r98-request.txt", content: "" }), armModel.ScriptedModelProvider.text("wrote empty")],
      wrong: [armModel.ScriptedModelProvider.toolCall("write_file", { path: "out/r98-request.txt", content: "r98-request-SECOND-write" }), armModel.ScriptedModelProvider.text("wrote wrong")],
      skipped: [armModel.ScriptedModelProvider.text("done")],
    };
    const results = {};
    for (const [variant, steps] of Object.entries(variants)) {
      const tail = Array.from({ length: 8 }, () => armModel.ScriptedModelProvider.text("nothing further to do"));
      const provider = new armModel.ScriptedModelProvider([...steps, ...tail]);
      try {
        const outcome = await armCli.runOneCase(
          caseDef,
          { provider, modelId: profile.provider.modelId, budgetTokens: profile.budgetTokens, armId, repetition: 1, attempt: 1 },
          caseDef.suite ?? "regression",
        );
        results[variant] = {
          status: outcome.status,
          grade: outcome.grade ?? null,
          toolCalls: outcome.metrics?.tool_call_count ?? null,
          verificationFailures: outcome.metrics?.verification_failures ?? null,
          violations: outcome.violations,
        };
      } catch (err) {
        results[variant] = { status: "THREW", error: err instanceof Error ? err.message : String(err) };
      }
    }
    out.arms[armId] = {
      present: true,
      head: git(dir, ["rev-parse", "HEAD"]),
      caseId: caseDef.id,
      verification: caseDef.verification,
      variants: results,
      contentSensitive:
        results.correct?.status === "passed" &&
        results.empty?.status !== "passed" &&
        results.wrong?.status !== "passed" &&
        results.skipped?.status !== "passed",
    };
  }
  out.bothArmsContentSensitive =
    out.arms.baseline?.contentSensitive === true && out.arms.candidate?.contentSensitive === true;
  return out;
}

// ---------------------------------------------------------------------------
// Phase: negative refusals BEFORE the provider step
// ---------------------------------------------------------------------------

async function phaseNegative({ workRoot }) {
  const runnerMod = await import(pathToFileURL(RUNNER_ENTRY).href);
  const cliMod = await import(pathToFileURL(CLI_ENTRY).href);
  const evalMod = await import(pathToFileURL(EVAL_ENTRY).href);
  const rows = [];

  /**
   * Drive ONE `prereg run` and report whether it was refused with ZERO physical
   * model calls. `mutate` can point the campaign at a different arm tree or an
   * artifact with a different mode, so each row isolates one violation.
   */
  async function attempt(label, { sampleCaseIds, isolationBackendId, isolationStrength, policyDigestTamper, armsRoot, injectedGrant }) {
    const dir = join(workRoot, `neg-${label.replace(/[^a-z0-9]+/gi, "-")}`);
    await mkdir(dir, { recursive: true });
    const env = cleanEnv({
      R97_ARM_BASELINE_DIR: armsRoot?.baseline ?? DEFAULT_PAIR.baseline,
      R97_ARM_CANDIDATE_DIR: armsRoot?.candidate ?? DEFAULT_PAIR.candidate,
      R97_CAMPAIGN_CLAIMS_DIR: join(dir, "claims"),
    });
    const { artifact, serialized } = await buildArtifactAndAuth({
      env,
      sampleCaseIds,
      isolationBackendId,
      isolationStrength,
      policyDigestTamper,
      armsRoot,
    });
    const preregPath = join(dir, "prereg.json");
    const authPath = join(dir, "auth.json");
    await writeFile(preregPath, serialized, "utf8");
    await writeFile(authPath, `${JSON.stringify(authorizationFor(artifact), null, 2)}\n`, "utf8");
    let providerCalls = 0;
    const base = runnerMod.createProductionPreregRunner({
      rootDir: REPO_ROOT,
      env,
      ...(injectedGrant === undefined ? {} : { trustedBuildGrant: injectedGrant }),
    });
    const runner = {
      observe: async (prereg) => {
        const fullObs = await base.observe(prereg);
        const ids = new Set(prereg.dataset.cases.map((c) => c.caseId));
        const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => ids.has(k)));
        return { ...fullObs, caseContentDigests: pick(fullObs.caseContentDigests), eligibilityDigests: pick(fullObs.eligibilityDigests) };
      },
      makeProvider: async () => {
        return {
          id: "r5-offline-scripted",
          async listModels() {
            return [];
          },
          createClient() {
            return {
              async *generate() {
                providerCalls += 1;
                yield { type: "text", text: "should never happen", timestamp: 0 };
                yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
              },
            };
          },
        };
      },
      runArm: base.runArm,
    };
    const res = await cliMod.preregCmd(["run", preregPath, "--authorization", authPath, "--budget-dir", join(dir, "budget"), "--out", join(dir, "out"), "--mode", "first-run"], {
      runner,
      now: () => 1_700_000_000_000,
    });
    const recordsDir = join(dir, "out", "runs");
    const records = existsSync(recordsDir) ? readdirSync(recordsDir).filter((f) => f.endsWith(".json")).length : 0;
    rows.push({
      violation: label,
      exitCode: res.exitCode,
      refused: res.exitCode !== 0,
      firstLine: res.lines[0] ?? null,
      reasonLine: res.lines[1] ?? null,
      physicalModelCalls: providerCalls,
      armRecordsWritten: records,
      refusedBeforeAnyModelCall: res.exitCode !== 0 && providerCalls === 0,
    });
  }

  // The negatives must clear the same unified minimum (5 eligible cases) before
  // the violation under test can be reached at all.
  const small = SMALL_SAMPLE;
  await attempt("swapped-arms (grant vs checkout directory)", { sampleCaseIds: small, injectedGrant: await grantFor(cleanEnv({ R97_ARM_BASELINE_DIR: DEFAULT_PAIR.candidate, R97_ARM_CANDIDATE_DIR: DEFAULT_PAIR.baseline })) });
  await attempt("missing-ABI (arm build without R97_ARM_PROBE)", { sampleCaseIds: small, armsRoot: await makeAbiLessArm(workRoot) });
  await attempt("wrong-policy (tampered decision policy digest)", { sampleCaseIds: small, policyDigestTamper: 123_456 });
  await attempt("undeclared-mode (process-exec with real checkouts, no fixture capability)", { sampleCaseIds: small, isolationBackendId: "process-exec", isolationStrength: "process" });
  await attempt("dirty-tree (git work tree with uncommitted bytes)", { sampleCaseIds: small, armsRoot: await makeDirtyArm(workRoot) });
  await attempt("unsupported-isolation", { sampleCaseIds: small, isolationBackendId: "os-container", isolationStrength: "strict" });

  return rows;
}

/** A copy of the baseline arm's execution closure with NO `R97_ARM_PROBE` export. */
async function makeAbiLessArm(workRoot) {
  const dir = join(workRoot, "arm-no-abi");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const mod = await import(pathToFileURL(EVAL_ENTRY).href);
  const entryRel = mod.R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"));
  for (const rel of mod.R97_ARM_BUILD_ENTRIES) {
    const src = join(DEFAULT_PAIR.baseline, rel);
    const dst = join(dir, rel);
    await mkdir(dirname(dst), { recursive: true });
    await cp(src, dst);
  }
  const entryPath = join(dir, entryRel);
  const bytes = await readFile(entryPath, "utf8");
  await writeFile(entryPath, bytes.replace(/export const R97_ARM_PROBE =/, "const REMOVED_R97_ARM_PROBE ="), "utf8");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=r5", "-c", "user.email=r5@local", "commit", "-q", "-m", "abi-less arm"]);
  return { baseline: dir, candidate: DEFAULT_PAIR.candidate };
}

/** A real git work tree that is DIRTY (an uncommitted file). */
async function makeDirtyArm(workRoot) {
  const dir = join(workRoot, "arm-dirty");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const mod = await import(pathToFileURL(EVAL_ENTRY).href);
  for (const rel of mod.R97_ARM_BUILD_ENTRIES) {
    const dst = join(dir, rel);
    await mkdir(dirname(dst), { recursive: true });
    await cp(join(DEFAULT_PAIR.baseline, rel), dst);
  }
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=r5", "-c", "user.email=r5@local", "commit", "-q", "-m", "clean arm"]);
  await writeFile(join(dir, "UNCOMMITTED.txt"), "dirty\n", "utf8");
  return { baseline: dir, candidate: DEFAULT_PAIR.candidate };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { phases: new Set(), out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--all") out.phases = new Set(["identity", "formal", "full", "content", "negative"]);
    else if (a.startsWith("--") && a !== "--out") out.phases.add(a.slice(2));
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.phases.size === 0) args.phases.add("identity");
  const workRoot = await mkdtemp(join(tmpdir(), "r5-real-formal-"));
  const report = {
    schemaVersion: R5_VERSION,
    generatedBy: "scripts/e4/r5-real-formal.mjs",
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    driverHead: git(REPO_ROOT, ["rev-parse", "HEAD"]),
    treeClean: git(REPO_ROOT, ["status", "--porcelain"]) === "",
    paidRequests: 0,
    externalNetwork: "none: the only provider is an in-process scripted double",
  };
  try {
    if (args.phases.has("identity")) report.identity = await phaseIdentity();
    if (args.phases.has("formal")) report.formalSmall = await phaseFormal({ full: false, workRoot });
    if (args.phases.has("full")) report.formalFull = await phaseFormal({ full: true, workRoot });
    if (args.phases.has("content")) report.contentFixture = await phaseContent({ workRoot });
    if (args.phases.has("negative")) report.negative = await phaseNegative({ workRoot });
  } catch (err) {
    report.fatal = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  const summary = [];
  if (report.identity) {
    for (const [armId, a] of Object.entries(report.identity.arms)) {
      summary.push(
        `identity ${armId}: exists=${a.exists} head=${a.head?.slice(0, 12) ?? "null"} clean=${a.clean ?? "?"} closure=${a.buildDigestShort ?? "?"} P2-41=${a.protocolFixes?.["P2-41"]?.presentInArmBuild ?? "?"} P2-43=${a.protocolFixes?.["P2-43"]?.presentInArmBuild ?? "?"}`,
      );
    }
  }
  if (report.formalSmall) summary.push(`formal-small: exit=${report.formalSmall.evidence.exitCode} cases=${report.formalSmall.evidence.scheduledCases} records=${report.formalSmall.evidence.records} verified=${report.formalSmall.evidence.evidenceVerified} modelCalls=${report.formalSmall.evidence.modelCallsByTranscript} decision=${report.formalSmall.evidence.decision} total=${report.formalSmall.evidence.journalRecomputed.total} delta=${report.formalSmall.evidence.journalRecomputed.delta} costMatches=${report.formalSmall.evidence.costMatches}`);
  if (report.formalFull) summary.push(`formal-full: exit=${report.formalFull.evidence.exitCode} records=${report.formalFull.evidence.records} verified=${report.formalFull.evidence.evidenceVerified} decision=${report.formalFull.evidence.decision}`);
  if (report.contentFixture) summary.push(`content-fixture: bothArmsContentSensitive=${report.contentFixture.bothArmsContentSensitive}`);
  if (report.negative) for (const r of report.negative) summary.push(`negative ${r.violation}: refused=${r.refused} exit=${r.exitCode} modelCalls=${r.physicalModelCalls} :: ${r.firstLine ?? ""} ${r.reasonLine ?? ""}`);
  if (report.fatal) summary.push(`FATAL: ${report.fatal.split("\n")[0]}`);

  const outPath = args.out !== null ? resolve(args.out) : join(REPO_ROOT, ".ci", "r5-real-formal.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`prereg-r5-real-formal (${R5_VERSION})\n  ${summary.join("\n  ")}\n  evidence: ${outPath}\n`);
  return report.fatal === undefined ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
