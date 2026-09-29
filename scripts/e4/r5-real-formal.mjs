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
 *   - two GENUINE git checkouts of this repository, pinned in ONE place
 *     (`scripts/e4/r5-formal-pair.json`; see that file for why the historical
 *     `4f8d98ec…` / `2314ce1d…` pair is unusable here), enforced as clean work
 *     trees at a 40-hex HEAD with resolving, DIFFERING execution closures;
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

// ---------------------------------------------------------------------------
// S4/task-6 — THE AUTHORITATIVE PAIR, READ FROM ONE FILE
// ---------------------------------------------------------------------------
/**
 * The pair is pinned in `scripts/e4/r5-formal-pair.json` and NOWHERE ELSE. This
 * module, `r97-observe-arms.mjs`, `apps/cli/src/r5-formal-gate.test.ts` and CI all
 * read that one file, so a re-pin is a ONE-file change that can never be
 * half-applied (the defect the historical hardcoded defaults invited).
 *
 * The arm DIRECTORIES remain a local convention (they are build outputs, not
 * revisions); only the SHAs are identity.
 */
const PAIR_CONFIG_PATH = join(here, "r5-formal-pair.json");

function readPairConfig() {
  const raw = readFileSync(PAIR_CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw);
  if (cfg.schemaVersion !== "e4-r5-formal-pair-v1") {
    throw new Error(`r5-formal-pair.json has schemaVersion ${String(cfg.schemaVersion)}, expected e4-r5-formal-pair-v1`);
  }
  return cfg;
}

export const PAIR_CONFIG = readPairConfig();

const DEFAULT_PAIR = {
  baseline: join(tmpdir(), "r97-arms-r5pair", "baseline"),
  candidate: join(tmpdir(), "r97-arms-r5pair", "candidate"),
  baselineSha: PAIR_CONFIG.baseline.sha,
  candidateSha: PAIR_CONFIG.candidate.sha,
  // Kept for `--identity`'s `headMatchesPublished` check: it compares a PREFIX of
  // the arm's HEAD against the pinned SHA's prefix, so a wrong checkout is named.
  expectedBaselineHead: PAIR_CONFIG.baseline.sha.slice(0, 8),
  expectedCandidateHead: PAIR_CONFIG.candidate.sha.slice(0, 8),
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
  // S4/task-6: the RAW records and the directory they (and their A6 evidence)
  // live in travel with the result, so the gate can re-derive the schedule from
  // the bytes rather than from a self-reported count.
  return { dir, evidence, records, recordsDir };
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

/**
 * Copy an arm's DECLARED execution closure into `dest`.
 *
 * The closure walker follows the entries' own relative imports, so copying the
 * five entry FILES is not enough — the whole `dist` directory each entry lives in
 * must travel (`packages/evaluation/dist/index.js` imports `./eval-case.js`, and a
 * missing sibling is refused as "the covered artifact set must never shrink
 * silently"). Bare specifiers stay external, so `node_modules` is not needed.
 */
async function copyArmClosure(srcArm, dest) {
  const mod = await import(pathToFileURL(EVAL_ENTRY).href);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const distDirs = new Set(mod.R97_ARM_BUILD_ENTRIES.map((rel) => dirname(rel)));
  for (const rel of distDirs) {
    await cp(join(srcArm, rel), join(dest, rel), { recursive: true });
  }
  // The copied dist is ESM; a bare tmp tree needs the marker or Node refuses the
  // copy as CJS ("Cannot use import statement outside a module") — which would
  // refuse for the WRONG reason and mask the violation under test.
  await writeFile(join(dest, "package.json"), `${JSON.stringify({ name: "r5-temp-arm", private: true, type: "module" }, null, 2)}\n`, "utf8");
  return { entryRel: mod.R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js")), distDirs: [...distDirs] };
}

function gitInitCommit(dir, message) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=r5", "-c", "user.email=r5@local", "commit", "-q", "-m", message]);
}

/** A copy of the baseline arm's execution closure with NO `R97_ARM_PROBE` export. */
async function makeAbiLessArm(workRoot) {
  const dir = join(workRoot, "arm-no-abi");
  const { entryRel } = await copyArmClosure(DEFAULT_PAIR.baseline, dir);
  const entryPath = join(dir, entryRel);
  const bytes = await readFile(entryPath, "utf8");
  await writeFile(entryPath, bytes.replace(/export const R97_ARM_PROBE =/, "const REMOVED_R97_ARM_PROBE ="), "utf8");
  gitInitCommit(dir, "abi-less arm");
  return { baseline: dir, candidate: DEFAULT_PAIR.candidate };
}

/** A real git work tree that is DIRTY (an uncommitted file). */
async function makeDirtyArm(workRoot) {
  const dir = join(workRoot, "arm-dirty");
  await copyArmClosure(DEFAULT_PAIR.baseline, dir);
  gitInitCommit(dir, "clean arm");
  await writeFile(join(dir, "UNCOMMITTED.txt"), "dirty\n", "utf8");
  return { baseline: dir, candidate: DEFAULT_PAIR.candidate };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * S4/task-6 — the CLI. Every `--name <value>` option is listed HERE so a new
 * valued option can never be silently swallowed as a "phase": the old parser
 * treated every `--x` except `--out` as a phase name, so a typo'd option became
 * a no-op phase instead of an error.
 */
function parseArgs(argv) {
  const out = {
    phases: new Set(),
    out: null,
    evidenceDir: null,
    verify: null,
    verifyPairObservations: null,
    setupPair: null,
    emitFixtureBundle: null,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--all") out.phases = new Set(["identity", "formal", "full", "content", "negative"]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--evidence-dir") out.evidenceDir = argv[++i];
    else if (a === "--verify") out.verify = argv[++i];
    else if (a === "--verify-pair-observations") out.verifyPairObservations = argv[++i];
    else if (a === "--setup-pair") out.setupPair = argv[++i];
    else if (a === "--emit-fixture-bundle") out.emitFixtureBundle = argv[++i];
    else if (a.startsWith("--")) out.phases.add(a.slice(2));
    else out.unknown.push(a);
  }
  return out;
}

async function runRealChain() {
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

  // S4/task-6 item 7: the RAW evidence tree is KEPT. `workRoot` is a scratch
  // workspace and may be deleted, but the raw manifest/verifier/security/activation
  // files, the request journal, the dispatch journal, the build identity, the
  // schedule and the aggregate are copied OUT of it FIRST, because a report that
  // references evidence which no longer exists is not evidence.
  const evidenceDir = args.evidenceDir !== null ? resolve(args.evidenceDir) : join(REPO_ROOT, ".ci", "r5-evidence");
  let bundle = null;
  try {
    bundle = await writeEvidenceBundle({ evidenceDir, report, args });
    summary.push(`bundle: ${evidenceDir} records=${bundle.recordCount} verified=${bundle.verifiedCount}`);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    report.bundleError = message;
    summary.push(`BUNDLE ERROR: ${message.split("\n")[0]}`);
  }

  const outPath = args.out !== null ? resolve(args.out) : join(REPO_ROOT, ".ci", "r5-real-formal.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`prereg-r5-real-formal (${R5_VERSION})\n  ${summary.join("\n  ")}\n  evidence: ${outPath}\n`);
  return { report, outPath, evidenceDir };
}

// ===========================================================================
// S4/task-6 — THE STRICT GATE (plan(20260929-015956).md §8, defect F5)
// ===========================================================================
//
// WHY THIS EXISTS. The pre-S4 script decided success from ONE thing:
// `report.fatal === undefined`. That is an exit-code defect in both directions:
// every assertion it made lived INSIDE `report`, so a report that recorded a
// missing record, a substituted "passed", a corrupted record, a deleted verifier,
// a journal mismatch or incomplete evidence still exited 0, and a downstream job
// could not tell a passing gate from a failed one without parsing prose.
//
// The gate below therefore (a) re-derives every claim from the RAW BYTES rather
// than from a self-reported count, and (b) turns every violation into a NAMED
// failure with a NONZERO exit. `report.fatal` remains a failure, but it is no
// longer the ONLY one.
//
// WHAT IT DOES NOT PROVE. `verifyEvidenceBundle` proves the bundle is CONSISTENT
// WITH ITSELF and with the pinned pair. It does NOT prove a real experiment ran:
// a synthetic fixture bundle can be perfectly consistent. That is why the bundle
// carries `fixture: true|false`, why the real-chain path records that the chain
// actually executed, and why "harness gate passed" is kept distinct from
// "experiment decision ACCEPT". Real model quality and promotion stay NOT_RUN.

export const R5_EVIDENCE_SCHEMA = "e4-r5-evidence-v1";
export const R5_SCHEDULE_SCHEMA = "e4-r5-schedule-v1";
export const R5_GATE_VERSION = "e4-r5-formal-gate-v1";

const EVIDENCE_FILES = ["manifest.json", "verifier.json", "security.json"];
const OPTIONAL_EVIDENCE_FILES = ["activation.json"];
const REQUIRED_NEGATIVES = ["swapped-arms", "missing-ABI", "wrong-policy", "undeclared-mode", "dirty-tree", "unsupported-isolation"];

function isSha40(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}
function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function fail(code, detail) {
  return { code, detail };
}
function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The recomputation contract for the cost journal, stated once so the producer and
 * the verifier cannot drift: a MEASURED entry charges its real input+output tokens;
 * a non-measured (reserved) entry charges its reserved tokens. This mirrors
 * `readCostJournal(...).chargedTotalTokens`.
 */
function recomputeJournal(entries) {
  const perArm = { baseline: 0, candidate: 0 };
  let total = 0;
  let measured = 0;
  for (const e of entries ?? []) {
    const arm = e.arm === "baseline" ? "baseline" : "candidate";
    const charged =
      e.basis === "MEASURED"
        ? (e.inputTokens ?? 0) + (e.outputTokens ?? 0)
        : (e.reservedInputTokens ?? 0) + (e.reservedOutputTokens ?? 0);
    if (e.basis === "MEASURED") measured += 1;
    perArm[arm] += charged;
    total += charged;
  }
  return { total, measured, perArm, delta: perArm.candidate - perArm.baseline };
}

/** Observe ONE arm checkout: HEAD, cleanliness, closure digest, entry hash, ABI. */
export function observeArm(dir, config) {
  if (dir === null || !existsSync(dir)) return { exists: false, dir };
  const head = git(dir, ["rev-parse", "HEAD"]);
  const porcelain = git(dir, ["status", "--porcelain"]);
  let buildDigest = null;
  let closureError = null;
  try {
    buildDigest = evalMod.computeArmBuildDigestV1(dir);
  } catch (err) {
    closureError = err instanceof Error ? err.message : String(err);
  }
  // The ABI strings live in `apps/cli/dist/r97-arm-abi.js` (tsc emits per file, so
  // the entry does not inline them). A missing file means a pre-S1 checkout.
  const abiPath = join(dir, "apps", "cli", "dist", "r97-arm-abi.js");
  const abiSource = existsSync(abiPath) ? readFileSync(abiPath, "utf8") : "";
  const workerAbi = (config.requiredWorkerAbi ?? []).filter((abi) => abiSource.includes(abi));
  const entryPath = join(dir, "apps", "cli", "dist", "benchmark-command.js");
  const entrySha256 = existsSync(entryPath) ? sha256Hex(readFileSync(entryPath, "utf8")) : null;
  return {
    exists: true,
    dir,
    head,
    clean: porcelain === "",
    porcelain,
    buildDigest,
    closureError,
    entrySha256,
    workerAbi,
    declaredAbi: (config.requiredWorkerAbi ?? []).length,
  };
}

/**
 * Verify the pinned pair from OBSERVATIONS (never from a claim). Pure over its
 * input, so the counter-examples in `apps/cli/src/r5-formal-gate.test.ts` can drive
 * every branch cheaply, while the real chain feeds it `observeArm()` output.
 */
export function verifyPairArms(config, observed) {
  const failures = [];
  const pinned = { baseline: config.baseline.sha, candidate: config.candidate.sha };
  for (const armId of ["baseline", "candidate"]) {
    const o = observed?.[armId];
    if (o === undefined || o === null || o.exists !== true) {
      failures.push(fail("PAIR_NOT_PINNED", `the ${armId} arm checkout is absent; the pinned pair cannot be verified`));
      continue;
    }
    if (o.head !== pinned[armId]) {
      failures.push(fail("WRONG_PAIR", `${armId} HEAD ${String(o.head)} is not the pinned ${pinned[armId]}`));
    }
    if (o.clean !== true) {
      failures.push(fail("DIRTY_ARM", `${armId} work tree is not clean (uncommitted changes present)`));
    }
    if (!isSha256(o.buildDigest)) {
      failures.push(
        fail("CLOSURE_UNRESOLVABLE", `${armId} has no resolvable execution-closure digest (${o.closureError ?? String(o.buildDigest)})`),
      );
    }
    for (const fix of config.requiredProtocolFixes ?? []) {
      if (o.protocolFixes?.[fix.id] !== true) {
        failures.push(fail("PROTOCOL_FIX_MISSING", `${armId} does not carry ${fix.id} (${fix.sha}): ${fix.what}`));
      }
    }
    for (const abi of config.requiredWorkerAbi ?? []) {
      if (!(o.workerAbi ?? []).includes(abi)) {
        failures.push(fail("WORKER_ABI_MISSING", `${armId} does not declare the worker ABI ${abi}`));
      }
    }
  }
  if (isSha256(observed?.baseline?.buildDigest) && observed.baseline.buildDigest === observed?.candidate?.buildDigest) {
    failures.push(
      fail("IDENTICAL_CLOSURE", `both arms report the SAME execution closure ${String(observed.baseline.buildDigest).slice(0, 16)}…, so the pair is not comparable`),
    );
  }
  if (Array.isArray(observed?.armDiffFiles)) {
    const allowed = new Set(config.allowedArmDiff ?? []);
    const extra = observed.armDiffFiles.filter((f) => !allowed.has(f));
    if (extra.length > 0) {
      failures.push(
        fail("INFRASTRUCTURE_DIFF", `the arms differ outside the allowed mechanism file(s): ${extra.join(", ")}`),
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Verify a KEPT evidence bundle. Every check re-reads the raw bytes; nothing is
 * taken from the report's own summary. Returns NAMED failures.
 */
export function verifyEvidenceBundle(root, config = PAIR_CONFIG) {
  const failures = [];
  const need = (rel) => join(root, rel);

  const identityPath = need("identity.json");
  if (!existsSync(identityPath)) {
    return { ok: false, failures: [fail("IDENTITY_MISSING", `identity.json is absent from ${root}`)] };
  }
  const identity = readJsonFile(identityPath);
  if (identity.schemaVersion !== R5_EVIDENCE_SCHEMA) {
    failures.push(fail("IDENTITY_INVALID", `identity schemaVersion is ${String(identity.schemaVersion)}, expected ${R5_EVIDENCE_SCHEMA}`));
  }
  if (!isSha40(identity.driverHead)) {
    failures.push(fail("IDENTITY_INVALID", `driverHead ${String(identity.driverHead)} is not a 40-hex revision`));
  }
  if (identity.closuresDistinguishable !== true) {
    failures.push(fail("IDENTITY_INVALID", "identity does not record that the two arms' execution closures are distinguishable"));
  }
  for (const armId of ["baseline", "candidate"]) {
    const arm = identity.pair?.[armId];
    if (arm === undefined || arm === null) {
      failures.push(fail("WRONG_PAIR", `identity carries no ${armId} arm`));
      continue;
    }
    if (arm.sourceSha !== config[armId].sha) {
      failures.push(fail("WRONG_PAIR", `${armId} sourceSha ${String(arm.sourceSha)} is not the pinned ${config[armId].sha}`));
    }
    if (!isSha40(arm.head)) {
      failures.push(fail("WRONG_PAIR", `${armId} head ${String(arm.head)} is not a 40-hex revision`));
    }
    if (arm.clean !== true) {
      failures.push(fail("DIRTY_ARM", `${armId} was not a clean checkout when the bundle was written`));
    }
    if (!isSha256(arm.buildDigest)) {
      failures.push(fail("CLOSURE_UNRESOLVABLE", `${armId} buildDigest ${String(arm.buildDigest)} is not a 64-hex closure digest`));
    }
    for (const abi of config.requiredWorkerAbi ?? []) {
      if (!(arm.workerAbi ?? []).includes(abi)) {
        failures.push(fail("WORKER_ABI_MISSING", `${armId} does not declare the worker ABI ${abi}`));
      }
    }
    for (const fix of config.requiredProtocolFixes ?? []) {
      if (arm.protocolFixes?.[fix.id] !== true) {
        failures.push(fail("PROTOCOL_FIX_MISSING", `${armId} does not carry ${fix.id} (${fix.sha})`));
      }
    }
  }
  if (isSha256(identity.pair?.baseline?.buildDigest) && identity.pair.baseline.buildDigest === identity.pair?.candidate?.buildDigest) {
    failures.push(fail("IDENTICAL_CLOSURE", "identity records ONE execution closure for both arms, so the pair is not comparable"));
  }

  // ---- the schedule, re-derived from the raw records -----------------------
  const schedulePath = need("schedule.json");
  if (!existsSync(schedulePath)) {
    return { ok: false, failures: [...failures, fail("MISSING_RECORD", `schedule.json is absent from ${root}`)] };
  }
  const schedule = readJsonFile(schedulePath);
  const planned = schedule.planned ?? {};
  const records = Array.isArray(schedule.records) ? schedule.records : [];
  const expectedLogicalRuns =
    (planned.cases ?? []).length * (planned.repetitions ?? 0) * (planned.arms ?? []).length;
  if (records.length !== expectedLogicalRuns) {
    const seen = new Set(records.map((r) => `${r.caseId}|${r.armId}|${r.repetition}`));
    const missing = [];
    for (const caseId of planned.cases ?? []) {
      for (const armId of planned.arms ?? []) {
        for (let rep = 1; rep <= (planned.repetitions ?? 0); rep += 1) {
          if (!seen.has(`${caseId}|${armId}|${rep}`)) missing.push(`${caseId}/${armId}/rep${rep}`);
        }
      }
    }
    failures.push(
      fail(
        "MISSING_RECORD",
        `the schedule planned ${expectedLogicalRuns} logical runs but carries ${records.length} record(s); missing: ${missing.slice(0, 6).join(", ") || "(none derivable — the plan itself is incomplete)"}`,
      ),
    );
  }

  for (const rec of records) {
    const label = `${String(rec.caseId)}/${String(rec.armId)}/rep${String(rec.repetition)}`;
    if (rec.status === "error" && (rec.reason === undefined || rec.reason === null || rec.reason === "")) {
      failures.push(fail("UNEXPLAINED_INFRA_ERROR", `${label} recorded an infrastructure error with no reason`));
    }
    const evDir = need(join("evidence", String(rec.armRunId)));
    if (!existsSync(evDir)) {
      failures.push(fail("MISSING_EVIDENCE", `${label} has no evidence directory (evidence/${String(rec.armRunId)})`));
      continue;
    }
    for (const f of EVIDENCE_FILES) {
      if (!existsSync(join(evDir, f))) {
        failures.push(fail("INCOMPLETE_EVIDENCE", `${label} is missing evidence/${String(rec.armRunId)}/${f}`));
      }
    }
    const manifestPath = join(evDir, "manifest.json");
    if (existsSync(manifestPath)) {
      const digest = sha256Hex(readFileSync(manifestPath, "utf8"));
      if (rec.traceDigest !== digest) {
        failures.push(
          fail(
            "CORRUPT_RECORD",
            `${label} records traceDigest ${String(rec.traceDigest)} but the manifest bytes hash to ${digest}`,
          ),
        );
      }
    }
    const verifierPath = join(evDir, "verifier.json");
    if (existsSync(verifierPath)) {
      const verifier = readJsonFile(verifierPath);
      if (verifier.verifiedCompletion !== rec.verifiedCompletion) {
        failures.push(
          fail(
            "WRONG_AS_PASSED",
            `${label} claims verifiedCompletion=${String(rec.verifiedCompletion)} but the raw verifier says ${String(verifier.verifiedCompletion)}`,
          ),
        );
      }
    }
    for (const f of OPTIONAL_EVIDENCE_FILES) {
      if (rec.evidenceFiles !== undefined && Array.isArray(rec.evidenceFiles) && rec.evidenceFiles.includes(f) && !existsSync(join(evDir, f))) {
        failures.push(fail("INCOMPLETE_EVIDENCE", `${label} declares ${f} but the file is absent`));
      }
    }
  }

  // ---- the cost journal, recomputed from the raw entries -------------------
  const journalPath = need("cost-journal.json");
  const aggregatePath = need("aggregate.json");
  if (!existsSync(journalPath)) {
    failures.push(fail("JOURNAL_MISMATCH", "cost-journal.json is absent, so no cost claim can be recomputed"));
  } else if (!existsSync(aggregatePath)) {
    failures.push(fail("JOURNAL_MISMATCH", "aggregate.json is absent, so the journal has nothing to agree with"));
  } else {
    const journal = readJsonFile(journalPath);
    const aggregate = readJsonFile(aggregatePath);
    const recomputed = recomputeJournal(journal.entries);
    const claimedTotal = aggregate.cost?.totalTokens ?? null;
    const claimedDelta = aggregate.cost?.deltaTokens ?? null;
    if (claimedTotal !== recomputed.total) {
      failures.push(
        fail("JOURNAL_MISMATCH", `aggregate claims totalTokens=${String(claimedTotal)} but the raw journal entries sum to ${recomputed.total}`),
      );
    }
    if (claimedDelta !== recomputed.delta) {
      failures.push(
        fail("JOURNAL_MISMATCH", `aggregate claims deltaTokens=${String(claimedDelta)} but the raw journal entries give ${recomputed.delta}`),
      );
    }
    if (journal.schemaVersion !== "tool-call-efficiency-cost-journal-v2") {
      failures.push(fail("JOURNAL_MISMATCH", `cost journal schema is ${String(journal.schemaVersion)}`));
    }
  }

  // ---- the content matrix: correct passes, every degradation fails ---------
  const matrixPath = need("content-matrix.json");
  if (!existsSync(matrixPath)) {
    failures.push(fail("CONTENT_INSENSITIVE", "content-matrix.json is absent, so content sensitivity is unproven"));
  } else {
    const matrix = readJsonFile(matrixPath);
    const cases = matrix.cases ?? {};
    if (Object.keys(cases).length === 0) {
      failures.push(fail("CONTENT_INSENSITIVE", "the content matrix carries no case, so content sensitivity is unproven"));
    }
    for (const [caseId, entry] of Object.entries(cases)) {
      for (const armId of ["baseline", "candidate"]) {
        const variants = entry?.arms?.[armId];
        if (variants === undefined || variants === null) {
          failures.push(fail("CONTENT_INSENSITIVE", `${caseId}/${armId} has no variant results`));
          continue;
        }
        if (variants.correct !== "passed") {
          failures.push(
            fail("CONTENT_CORRECT_FAILED", `${caseId}/${armId} correct variant is ${String(variants.correct)}, not passed — the content verifier did not confirm the real fix`),
          );
        }
        for (const variant of ["empty", "wrong", "skipped"]) {
          if (variants[variant] === "passed") {
            failures.push(
              fail(
                "CONTENT_INSENSITIVE",
                `${caseId}/${armId} ${variant} variant PASSED, so this result is not sensitive to content and cannot support a strategy claim`,
              ),
            );
          }
        }
      }
    }
  }

  // ---- the negative matrix: refused BEFORE the first model request ---------
  const negativesPath = need("negatives.json");
  if (!existsSync(negativesPath)) {
    failures.push(fail("NEGATIVE_ROW_MISSING", "negatives.json is absent, so no counter-example is recorded"));
  } else {
    const rows = readJsonFile(negativesPath).rows ?? [];
    for (const violation of REQUIRED_NEGATIVES) {
      if (!rows.some((r) => r.violation === violation)) {
        failures.push(fail("NEGATIVE_ROW_MISSING", `the counter-example "${violation}" is not recorded`));
      }
    }
    for (const row of rows) {
      if (row.exitCode === 0) {
        failures.push(fail("NEGATIVE_ACCEPTED", `the "${String(row.violation)}" counter-example was ACCEPTED (exit 0) instead of refused`));
      }
      if (row.violation === "missing-ABI") {
        if (row.refusedBeforeAnyModelCall !== true || row.physicalModelCalls !== 0) {
          failures.push(
            fail(
              "MISSING_ABI_REACHED_MODEL",
              `the missing-ABI counter-example reached the model (physicalModelCalls=${String(row.physicalModelCalls)}), so the refusal happened too late to prove the boundary`,
            ),
          );
        }
      }
      if (row.violation === "wrong-policy" || row.violation === "unsupported-isolation") {
        if (row.refused !== true) {
          failures.push(
            fail(
              "POLICY_OR_ISOLATION_UNREFUSED",
              `the "${String(row.violation)}" counter-example was not refused, so the isolation/policy boundary is not enforced`,
            ),
          );
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Write the KEPT evidence bundle from the phase results. The raw per-phase trees
 * are copied verbatim under `raw/`, and the canonical gate inputs are written from
 * the RAW records — never from a summary.
 */
async function writeEvidenceBundle({ evidenceDir, report, args }) {
  await mkdir(evidenceDir, { recursive: true });
  const formal = report.formalSmall ?? null;
  const records = formal?.records ?? [];
  const recordsDir = formal?.recordsDir ?? null;

  const pair = {};
  const identity = report.identity ?? null;
  for (const armId of ["baseline", "candidate"]) {
    const observed = identity?.arms?.[armId] ?? null;
    pair[armId] = {
      sourceSha: armId === "baseline" ? PAIR_CONFIG.baseline.sha : PAIR_CONFIG.candidate.sha,
      head: observed?.head ?? null,
      clean: observed?.clean ?? null,
      buildDigest: observed?.buildDigest ?? null,
      entrySha256: observed?.armEntrySha256 ?? null,
      workerAbi: PAIR_CONFIG.requiredWorkerAbi.filter((abi) => observed?.abi?.[abi] === true || observed?.workerAbi?.includes?.(abi) === true),
      protocolFixes: Object.fromEntries(
        (PAIR_CONFIG.requiredProtocolFixes ?? []).map((f) => [f.id, observed?.protocolFixes?.[f.id]?.presentInArmBuild === true]),
      ),
    };
  }
  const distinct =
    isSha256(pair.baseline.buildDigest) && isSha256(pair.candidate.buildDigest) && pair.baseline.buildDigest !== pair.candidate.buildDigest;

  await writeFile(
    join(evidenceDir, "identity.json"),
    `${JSON.stringify(
      {
        schemaVersion: R5_EVIDENCE_SCHEMA,
        fixture: false,
        gateVersion: R5_GATE_VERSION,
        driverHead: report.driverHead ?? null,
        treeClean: report.treeClean === true,
        platform: report.platform ?? null,
        pair,
        closuresDistinguishable: distinct,
        isolation: PAIR_CONFIG.isolation,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Copy the raw trees FIRST: the schedule below must point at bytes that exist.
  const rawRoot = join(evidenceDir, "raw");
  await mkdir(rawRoot, { recursive: true });
  if (recordsDir !== null && existsSync(recordsDir)) {
    await cp(recordsDir, join(rawRoot, "runs"), { recursive: true });
  }
  const evidenceRoot = join(evidenceDir, "evidence");
  if (recordsDir !== null && existsSync(join(recordsDir, "evidence"))) {
    await cp(join(recordsDir, "evidence"), evidenceRoot, { recursive: true });
  }

  let verifiedCount = 0;
  const scheduleRecords = [];
  for (const rec of records) {
    const evDir = join(evidenceRoot, String(rec.armRunId));
    const manifestPath = join(evDir, "manifest.json");
    const traceDigest = existsSync(manifestPath) ? sha256Hex(readFileSync(manifestPath, "utf8")) : null;
    const verifiedCompletion = rec.outcome?.evidence?.verifiedCompletion ?? null;
    if (rec.outcome?.status !== "error" && traceDigest !== null) verifiedCount += 1;
    scheduleRecords.push({
      armRunId: rec.armRunId,
      armId: rec.armId,
      caseId: rec.caseId,
      repetition: rec.repetition,
      orderIndex: rec.orderIndex,
      preregistrationDigest: rec.preregistrationDigest,
      planDigest: rec.planDigest,
      status: rec.outcome?.status ?? "unknown",
      reason: rec.outcome?.reason ?? rec.reason ?? null,
      verifiedCompletion,
      traceDigest,
      evidenceFiles: existsSync(evDir) ? readdirSync(evDir).filter((f) => f.endsWith(".json")) : [],
    });
  }
  await writeFile(
    join(evidenceDir, "schedule.json"),
    `${JSON.stringify(
      {
        schemaVersion: R5_SCHEDULE_SCHEMA,
        planned: {
          cases: formal?.evidence?.sampleCaseIds ?? [],
          arms: ["baseline", "candidate"],
          repetitions: formal?.evidence?.logicalRuns !== undefined && (formal?.evidence?.sampleCaseIds ?? []).length > 0
            ? (formal.evidence.logicalRuns / ((formal.evidence.sampleCaseIds ?? []).length * 2))
            : 0,
          logicalRuns: formal?.evidence?.logicalRuns ?? 0,
        },
        records: scheduleRecords,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // The journals: copied from the budget dir, kept byte-for-byte.
  const budgetDir = formal?.budgetDir ?? null;
  if (budgetDir !== null && existsSync(join(budgetDir, "cost-budget.json"))) {
    await cp(join(budgetDir, "cost-budget.json"), join(evidenceDir, "cost-journal.json"));
  }
  if (budgetDir !== null) {
    for (const name of readdirSync(budgetDir)) {
      if (name.startsWith("dispatch") && name.endsWith(".json")) {
        await cp(join(budgetDir, name), join(evidenceDir, name));
      }
    }
  }
  if (formal?.dir !== undefined && existsSync(join(formal.dir, "aggregate.json"))) {
    await cp(join(formal.dir, "aggregate.json"), join(evidenceDir, "aggregate.json"));
  }

  // The content matrix, taken from the per-case RAW verifier evidence.
  const matrixCases = {};
  for (const [caseId, entry] of Object.entries(formal?.evidence?.perCase ?? {})) {
    const verdict = (verifier) => (verifier === null || verifier === undefined ? "absent" : verifier.verifiedCompletion === true ? "passed" : "failed");
    matrixCases[caseId] = {
      contentMode: entry?.contentMode ?? null,
      arms: {
        baseline: { correct: verdict(entry?.baseline), empty: "absent", wrong: "absent", skipped: "absent" },
        candidate: { correct: verdict(entry?.candidate), empty: "absent", wrong: "absent", skipped: "absent" },
      },
    };
  }
  const contentRuns = report.contentMatrix ?? null;
  if (contentRuns !== null) {
    for (const [caseId, entry] of Object.entries(contentRuns)) {
      matrixCases[caseId] = entry;
    }
  }
  await writeFile(
    join(evidenceDir, "content-matrix.json"),
    `${JSON.stringify({ schemaVersion: "e4-r5-content-matrix-v1", cases: matrixCases }, null, 2)}\n`,
    "utf8",
  );

  await writeFile(
    join(evidenceDir, "negatives.json"),
    `${JSON.stringify(
      {
        schemaVersion: "e4-r5-negatives-v1",
        rows: (report.negative ?? []).map((r) => ({
          violation: r.violation,
          exitCode: r.exitCode,
          refused: r.refused,
          physicalModelCalls: r.physicalModelCalls,
          refusedBeforeAnyModelCall: r.refused === true && (r.physicalModelCalls ?? 0) === 0,
          reasonLine: r.reasonLine ?? null,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { recordCount: scheduleRecords.length, verifiedCount };
}

/** A deliberately SYNTHETIC but internally CONSISTENT bundle, for the counter-examples. */
export async function emitFixtureBundle(dir) {
  await mkdir(dir, { recursive: true });
  const manifestText = `${JSON.stringify({ fixture: true, armProbe: { guidance: "fixture" } }, null, 2)}\n`;
  const armRuns = [
    { armRunId: "fixture-baseline-reg-12-csv-parse-r1", armId: "baseline", caseId: "reg-12-csv-parse", repetition: 1, orderIndex: 0 },
    { armRunId: "fixture-candidate-reg-12-csv-parse-r1", armId: "candidate", caseId: "reg-12-csv-parse", repetition: 1, orderIndex: 1 },
  ];
  for (const rec of armRuns) {
    const evDir = join(dir, "evidence", rec.armRunId);
    await mkdir(evDir, { recursive: true });
    await writeFile(join(evDir, "manifest.json"), manifestText, "utf8");
    await writeFile(
      join(evDir, "verifier.json"),
      `${JSON.stringify({ fixture: true, armRunId: rec.armRunId, verifiedCompletion: true, casesTotal: 1, casesVerified: 1 }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(evDir, "security.json"), `${JSON.stringify({ fixture: true, violations: [] }, null, 2)}\n`, "utf8");
  }
  const traceDigest = sha256Hex(manifestText);
  await writeFile(
    join(dir, "identity.json"),
    `${JSON.stringify(
      {
        schemaVersion: R5_EVIDENCE_SCHEMA,
        fixture: true,
        gateVersion: R5_GATE_VERSION,
        driverHead: PAIR_CONFIG.candidate.sha,
        treeClean: true,
        platform: `${process.platform}-${process.arch}`,
        pair: {
          baseline: {
            sourceSha: PAIR_CONFIG.baseline.sha,
            head: PAIR_CONFIG.baseline.sha,
            clean: true,
            buildDigest: "a".repeat(64),
            entrySha256: "b".repeat(64),
            workerAbi: PAIR_CONFIG.requiredWorkerAbi,
            protocolFixes: { "P2-41": true, "P2-43": true },
          },
          candidate: {
            sourceSha: PAIR_CONFIG.candidate.sha,
            head: PAIR_CONFIG.candidate.sha,
            clean: true,
            buildDigest: "c".repeat(64),
            entrySha256: "d".repeat(64),
            workerAbi: PAIR_CONFIG.requiredWorkerAbi,
            protocolFixes: { "P2-41": true, "P2-43": true },
          },
        },
        closuresDistinguishable: true,
        isolation: PAIR_CONFIG.isolation,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "schedule.json"),
    `${JSON.stringify(
      {
        schemaVersion: R5_SCHEDULE_SCHEMA,
        planned: { cases: ["reg-12-csv-parse"], arms: ["baseline", "candidate"], repetitions: 1, logicalRuns: 2 },
        records: armRuns.map((r) => ({ ...r, status: "ok", verifiedCompletion: true, traceDigest, evidenceFiles: ["manifest.json", "verifier.json", "security.json"] })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "cost-journal.json"),
    `${JSON.stringify(
      {
        schemaVersion: "tool-call-efficiency-cost-journal-v2",
        entries: [
          { arm: "baseline", basis: "MEASURED", inputTokens: 100, outputTokens: 20, requestId: "r1" },
          { arm: "candidate", basis: "MEASURED", inputTokens: 90, outputTokens: 20, requestId: "r2" },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "aggregate.json"),
    `${JSON.stringify({ fixture: true, cost: { totalTokens: 230, deltaTokens: -10, baselineTokens: 120, candidateTokens: 110 }, decision: { decision: "INCONCLUSIVE", reasonCodes: ["FIXTURE"] } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "content-matrix.json"),
    `${JSON.stringify(
      {
        schemaVersion: "e4-r5-content-matrix-v1",
        cases: {
          "reg-12-csv-parse": {
            contentMode: "formal-four-variant",
            arms: {
              baseline: { correct: "passed", empty: "failed", wrong: "failed", skipped: "failed" },
              candidate: { correct: "passed", empty: "failed", wrong: "failed", skipped: "failed" },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "negatives.json"),
    `${JSON.stringify(
      {
        schemaVersion: "e4-r5-negatives-v1",
        rows: REQUIRED_NEGATIVES.map((violation) => ({
          violation,
          exitCode: 1,
          refused: true,
          physicalModelCalls: 0,
          refusedBeforeAnyModelCall: true,
          reasonLine: `${violation} refused (fixture)`,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return dir;
}

function reportFailures(label, failures, stream = process.stdout) {
  for (const f of failures) stream.write(`${label} ${f.code}: ${f.detail}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.emitFixtureBundle !== null) {
    await emitFixtureBundle(resolve(args.emitFixtureBundle));
    process.stdout.write(`wrote a SYNTHETIC fixture bundle to ${resolve(args.emitFixtureBundle)}\n`);
    return 0;
  }

  if (args.verify !== null) {
    const root = resolve(args.verify);
    const result = verifyEvidenceBundle(root);
    if (!result.ok) {
      reportFailures("GATE FAIL", result.failures);
      return 1;
    }
    process.stdout.write(`GATE PASS (${R5_GATE_VERSION}): ${root} is consistent with the pinned pair\n`);
    return 0;
  }

  if (args.verifyPairObservations !== null) {
    const observed = readJsonFile(resolve(args.verifyPairObservations));
    const result = verifyPairArms(PAIR_CONFIG, observed);
    if (!result.ok) {
      reportFailures("GATE FAIL", result.failures);
      return 1;
    }
    process.stdout.write(`PAIR OK (${R5_GATE_VERSION}): both arms match scripts/e4/r5-formal-pair.json\n`);
    return 0;
  }

  if (args.unknown.length > 0) {
    process.stderr.write(`unknown argument(s): ${args.unknown.join(", ")}\n`);
    return 2;
  }

  const { report, evidenceDir } = await runRealChain();

  // The OVERALL result: every phase outcome AND the strict gate over the KEPT
  // bundle. A fatal error is a failure, but it is no longer the ONLY one.
  const failures = [];
  if (report.fatal !== undefined) {
    failures.push(fail("FATAL", String(report.fatal).split("\n")[0]));
  }
  if (report.bundleError !== undefined) {
    failures.push(fail("BUNDLE_ERROR", String(report.bundleError).split("\n")[0]));
  }
  const gate = verifyEvidenceBundle(evidenceDir);
  for (const f of gate.failures) failures.push(f);

  report.gate = {
    version: R5_GATE_VERSION,
    evidenceDir,
    passed: failures.length === 0,
    failures,
    // "harness gate passed" is NOT "experiment decision ACCEPT": the decision is
    // reported separately and real model quality stays NOT_RUN.
    decision: report.formalSmall?.evidence?.decision ?? null,
    realModelQuality: "NOT_RUN",
    promotion: "NOT_RUN",
  };
  const outPath = args.out !== null ? resolve(args.out) : join(REPO_ROOT, ".ci", "r5-real-formal.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (failures.length > 0) {
    reportFailures("GATE FAIL", failures);
    process.stdout.write(`R5 gate: ${failures.length} named failure(s); bundle ${evidenceDir}\n`);
    return 1;
  }
  process.stdout.write(`GATE PASS (${R5_GATE_VERSION}): bundle ${evidenceDir}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
