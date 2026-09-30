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
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyDispatchJournal } from "./n3-dispatch-journal-contract.mjs";

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

/**
 * S5/N5 — THE ONE CLOCK, READ ONCE. WHY THIS IS NOT A FROZEN CONSTANT.
 *
 * This driver used to pass `now: () => 1_700_000_000_000` (2023-11-14T22:13:20Z)
 * to `prereg run`. The formal gate freezes the durable campaign deadline as
 * `clock() + budget.maxDurationMs`, and S2/F2 made that deadline REAL:
 * `prereg-arm-executor.ts` refuses a campaign whose deadline has already passed
 * rather than silently re-deriving a fresh window. A clock pinned ~2 years in the
 * PAST therefore made every arm refuse with `ARM_DEADLINE_EXCEEDED` before its
 * first model request — the campaign recorded ZERO arm runs on a CLEAN tree, and
 * the refusal was correct: the DRIVER was wrong. (The previous round attributed
 * `records=0` to the dirty tree alone; that refusal was real, but it masked this
 * second, independent blocker.)
 *
 * The wall-clock anchor is now OPEN (read ONCE, here, at process start) while
 * everything determinism actually depends on — the artifact, its digests, the
 * case set, the repetitions — stays fixed. `assertCampaignClockIsOpen` below makes
 * a regression LOUD instead of silent.
 *
 * The same defect was already found and fixed once in `prereg-production-e2e.mjs`
 * (its `FIXTURE_CLOCK_CLOSED` guard, commit 6b784c1). This driver never got it.
 */
export const CAMPAIGN_NOW = Date.now();

/** The declared campaign duration the artifact binds (`budget.maxDurationMs`).
 *  The gate freezes `campaignDeadlineAtMs = clock() + THIS`, so the guard below
 *  must use the same number or it would validate a deadline nobody creates. */
export const R5_DECLARED_MAX_DURATION_MS = 600_000;

/**
 * Fail LOUDLY if this driver's own injected clock would place the campaign
 * deadline in the past. An ASSERTION, not a comment: a frozen past clock must
 * break the run here, naming the cause, instead of surfacing as an opaque
 * `ARM_DEADLINE_EXCEEDED` from inside the executor.
 */
export function assertCampaignClockIsOpen(nowMs, maxDurationMs) {
  const deadlineAtMs = nowMs + maxDurationMs;
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(nowMs)) {
    throw new Error(`R5_CAMPAIGN_CLOCK_INVALID: the injected clock ${String(nowMs)} is not a safe integer epoch`);
  }
  if (deadlineAtMs <= Date.now()) {
    throw new Error(
      `R5_CAMPAIGN_CLOCK_CLOSED: the injected clock ${nowMs} (${new Date(nowMs).toISOString()}) places the campaign ` +
        `deadline at ${deadlineAtMs} (${new Date(deadlineAtMs).toISOString()}), which is already in the past relative ` +
        `to ${new Date(Date.now()).toISOString()}. The arm executor would (correctly) refuse with ` +
        `ARM_DEADLINE_EXCEEDED before the first model request, so no arm run would record anything.`,
    );
  }
  return deadlineAtMs;
}

/** The claim-anchor variable name, mirrored from the ledger that reads it. */
const R97_CAMPAIGN_CLAIMS_DIR_ENV = "R97_CAMPAIGN_CLAIMS_DIR";

/**
 * S5/N5 — SCOPE THE CAMPAIGN CLAIM ANCHOR TO THIS RUN.
 *
 * The durable ledger records, for each campaign id, an anchor under
 * `R97_CAMPAIGN_CLAIMS_DIR` — and it reads that variable from **`process.env`**,
 * not from the injected env object the runner is constructed with. This driver
 * only ever set the injected copy, so the anchor landed in the machine-global
 * `tmpdir()/e4-r97-campaign-claims`. It remembered a budget directory that this
 * driver deletes at the end of every run, and the NEXT run was refused with
 * `CAMPAIGN_STATE_LOST` ("a deleted root is a LOSS of the consumed record, not a
 * fresh allowance"): the gate was not re-runnable, which a reproducible gate must
 * be.
 *
 * Pointing it INSIDE the run's own disposable root keeps the run idempotent
 * WITHOUT weakening that runtime rule: within one run the anchor still holds, and
 * a lost root is still a loss. `prereg-production-e2e.mjs` carries the same fix
 * for the same reason.
 */
async function withScopedCampaignClaimsDir(claimsDir, fn) {
  const previous = process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
  await mkdir(claimsDir, { recursive: true });
  process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = claimsDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
    else process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = previous;
  }
}


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
    // S5/N5 — the LOADED-entry identity is recorded HERE too, not only inside the
    // bundle, because plan §8 item 3 requires the report itself to name, per arm:
    // the source SHA, the clean tree, the worker ABI, the closure digest, the REAL
    // loaded entry hash and the probe. The load is a genuine `import()` of that
    // arm's built entry in a child process whose cwd IS the arm checkout.
    const loaded = observeArmEntryLoad(dir, entryRel);
    const abiSource = existsSync(join(dir, "apps", "cli", "dist", "r97-arm-abi.js"))
      ? readFileSync(join(dir, "apps", "cli", "dist", "r97-arm-abi.js"), "utf8")
      : "";
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
      // The ABI the arm's own build declares, from the loaded module when it can be
      // loaded and from its bytes otherwise — never from this driver's constants.
      workerAbi: (PAIR_CONFIG.requiredWorkerAbi ?? []).filter((abi) => abiSource.includes(abi)),
      declaredArmAbi: loaded.abi,
      probe: loaded.probe,
      probeError: loaded.error,
      runOneCaseExport: loaded.runOneCaseExport,
      loadedEntrySha256: loaded.entrySha256,
      entryHashAgrees: entrySha256 !== null && loaded.entrySha256 !== null && entrySha256 === loaded.entrySha256,
      protocolFixes: fixes,
    };
  }
  const distinguishable = arms.baseline.buildDigest !== arms.candidate.buildDigest;
  return {
    // The label is DERIVED from the pinned config, never a remembered string: this
    // line used to name the superseded E4-N1 pair (8265dc39/ee15e7e7) while the
    // config pinned a different one, so the report described a pair it was not
    // observing.
    pair: `pinned formal pair (baseline ${PAIR_CONFIG.baseline.sha.slice(0, 8)} / candidate ${PAIR_CONFIG.candidate.sha.slice(0, 8)})`,
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
  // S5/N5 — THE CASE THE BUILT-IN OFFLINE PROVIDER CAN ACTUALLY FINISH.
  //
  // Measured, not assumed: `reg-22-api-stub`'s frozen verification is
  // `node -e "const s=require('./server.js'); s.listen(0, …) … /health …"`, and the
  // offline scripted provider's ONE content task writes exactly that `server.js`
  // (`OFFLINE_CONTENT_TASK`: suite "regression", caseId "reg-22-api-stub",
  // outputPath "server.js"). The other five cases ask for artifacts and commands
  // that script cannot produce (`out/cleaned.json`, `python3 …`, and — measured by
  // direct reproduction — a `node` import of an ESM body the case workspace has no
  // `"type": "module"` for), so under this posture they can only ever fail content
  // verification. That is a SCHEDULE/PROVIDER MISMATCH, not a Runtime defect: it
  // predates this round (at 00c8660a the script wrote only the demo file
  // `offline-forward-proof.txt`, which satisfies no case at all, and this list never
  // contained `reg-22-api-stub`).
  //
  // Including a case the posture CAN satisfy is what makes plan §8's "the normal
  // content path must reach a REAL verifier success" reachable at all. It changes no
  // standard: the same two arms, the same budget, the same evidence chain and the
  // same gate are compared — the offline provider is simply given one case it was
  // built for. The other five stay in the schedule on purpose and are reported as
  // the control group this posture cannot serve.
  "reg-22-api-stub",
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

  const result = await withScopedCampaignClaimsDir(join(dir, "claims"), () =>
    cliMod.preregCmd(
      ["run", preregPath, "--authorization", authPath, "--budget-dir", budgetDir, "--out", outDir, "--mode", "first-run"],
      { runner, now: () => CAMPAIGN_NOW },
    ),
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
  return { dir, evidence, records, recordsDir, budgetDir };
}

// ---------------------------------------------------------------------------
// Phase: the FOUR-VARIANT content matrix, through the ACTUAL formal chain
// ---------------------------------------------------------------------------

/**
 * S4/task-6 item 4. The pre-S4 script had only `--content`, which called the arm's
 * `runOneCase` DIRECTLY — a fixture result, not formal four-variant evidence, and it
 * never exercised the pre-registration/budget/worker/aggregate path. This phase
 * instead schedules correct, empty, wrong and skipped THROUGH `phaseFormal`, i.e.
 * through the same formal `preregCmd(["run", …])` entry as the real campaign, and
 * reads every verdict from the RAW `verifier.json` the arm wrote.
 *
 * The matrix is restricted to the content-sensitive cases (`CONTENT_FIXES`): for a
 * case with no content dimension, "empty/wrong/skipped" has no meaning and claiming
 * a verdict for it would be a fabricated result.
 */
async function phaseContentMatrix({ workRoot }) {
  const modes = ["correct", "empty", "wrong", "skipped"];
  const matrix = {};
  const perMode = {};
  for (const mode of modes) {
    const res = await phaseFormal({ full: false, workRoot: join(workRoot, `cm-${mode}`), contentMode: mode });
    perMode[mode] = {
      exitCode: res.evidence.exitCode,
      records: res.evidence.records,
      evidenceVerified: res.evidence.evidenceVerified,
      modelCalls: res.evidence.modelCallsByTranscript,
    };
    for (const [caseId, entry] of Object.entries(res.evidence.perCase ?? {})) {
      if (!(caseId in CONTENT_FIXES)) continue;
      matrix[caseId] ??= { contentMode: "formal-four-variant", arms: { baseline: {}, candidate: {} } };
      for (const armId of ["baseline", "candidate"]) {
        const verifier = entry?.[armId] ?? null;
        matrix[caseId].arms[armId][mode] =
          verifier === null || verifier === undefined ? "absent" : verifier.verifiedCompletion === true ? "passed" : "failed";
      }
    }
  }
  return { matrix, perMode };
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

/**
 * S4/task-6: the refusal CODE each counter-example must produce. Without this, a
 * single environmental condition (a dirty driver work tree refuses EVERY row with
 * `PREREGISTRATION_IDENTITY_DRIFT`) makes the whole matrix look "refused" while
 * proving nothing about any individual boundary. Keyed by the label `phaseNegative`
 * passes to `attempt()`, because that label is what lands in `negatives.json`.
 */
const EXPECTED_REFUSAL_CODES = {
  "swapped-arms (grant vs checkout directory)": "TRUSTED_BUILD_NOT_PROVEN",
  "missing-ABI (arm build without R97_ARM_PROBE)": "ARM_WORKER_ABI_UNSUPPORTED",
  "wrong-policy (tampered decision policy digest)": "PREREGISTRATION_IDENTITY_DRIFT",
  "undeclared-mode (process-exec with real checkouts, no fixture capability)": "EGRESS_ISOLATION_UNAVAILABLE",
  "dirty-tree (git work tree with uncommitted bytes)": "TRUSTED_BUILD_NOT_PROVEN",
  "unsupported-isolation": "ARM_ISOLATION_UNSUPPORTED",
};

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
    const res = await withScopedCampaignClaimsDir(join(dir, "claims"), () =>
      cliMod.preregCmd(["run", preregPath, "--authorization", authPath, "--budget-dir", join(dir, "budget"), "--out", join(dir, "out"), "--mode", "first-run"], {
        runner,
        now: () => CAMPAIGN_NOW,
      }),
    );
    const recordsDir = join(dir, "out", "runs");
    const records = existsSync(recordsDir) ? readdirSync(recordsDir).filter((f) => f.endsWith(".json")).length : 0;
    // S4/task-6: record the refusal CODE, not just the exit code. A negative that is
    // refused for the WRONG reason (a dirty tree masks every boundary at once) proves
    // nothing about the boundary under test, so the gate compares this against the
    // code the violation is supposed to produce.
    const refusalLine = res.lines.find((l) => l.includes("REFUSED")) ?? res.lines[0] ?? "";
    const refusalCode = /REFUSED\s*\(([A-Z0-9_]+)\)/.exec(refusalLine)?.[1] ?? null;
    rows.push({
      violation: label,
      exitCode: res.exitCode,
      refused: res.exitCode !== 0,
      refusalCode,
      expectedRefusalCode: EXPECTED_REFUSAL_CODES[label] ?? null,
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

/**
 * A copy of the baseline arm's execution closure with NO `R97_ARM_PROBE` export.
 *
 * S5/N5 — IT MUST ALSO BE *RESOLVABLE*. A real arm checkout has its own installed
 * `node_modules`; this synthetic one is only a copied closure, so the moment the
 * worker imports `apps/cli/dist/benchmark-command.js` it died with
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@ar/contracts'` — module resolution
 * failing FIRST, which is NOT the boundary this row exists to prove. The row is
 * supposed to be refused because the arm declares no `R97_ARM_PROBE`
 * (`ARM_WORKER_ABI_UNSUPPORTED`), and an unrelated resolution error must not be
 * accepted as evidence for it (the gate said exactly that:
 * `NEGATIVE_WRONG_REASON`). So the fixture gets a `node_modules` link to the
 * workspace's own installed tree, which is what a real arm has, and nothing else
 * about the arm changes: the probe export is still removed.
 */
async function makeAbiLessArm(workRoot) {
  const dir = join(workRoot, "arm-no-abi");
  const { entryRel } = await copyArmClosure(DEFAULT_PAIR.baseline, dir);
  await linkWorkspaceModules(dir);
  const entryPath = join(dir, entryRel);
  const bytes = await readFile(entryPath, "utf8");
  await writeFile(entryPath, bytes.replace(/export const R97_ARM_PROBE =/, "const REMOVED_R97_ARM_PROBE ="), "utf8");
  gitInitCommit(dir, "abi-less arm");
  return { baseline: dir, candidate: DEFAULT_PAIR.candidate };
}

/** Give a synthetic arm the module resolution a real installed arm has.
 *  `apps/cli/node_modules` is where this workspace's pnpm layout puts the
 *  `@ar/*` links the closure entry imports. */
async function linkWorkspaceModules(armDir) {
  const target = join(REPO_ROOT, "apps", "cli", "node_modules");
  if (!existsSync(target)) return;
  try {
    await symlink(target, join(armDir, "node_modules"), "junction");
  } catch {
    // A pre-existing link is fine; anything else will surface as a named refusal.
  }
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
    emitRealShapedBundle: null,
    deriveBaseline: null,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--all") out.phases = new Set(["identity", "formal", "full", "content", "content-matrix", "negative"]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--evidence-dir") out.evidenceDir = argv[++i];
    else if (a === "--verify") out.verify = argv[++i];
    else if (a === "--verify-pair-observations") out.verifyPairObservations = argv[++i];
    else if (a === "--setup-pair") out.setupPair = argv[++i];
    else if (a === "--derive-baseline") out.deriveBaseline = argv[++i];
    else if (a === "--emit-fixture-bundle") out.emitFixtureBundle = argv[++i];
    else if (a === "--emit-real-shaped-bundle") out.emitRealShapedBundle = argv[++i];
    else if (a.startsWith("--")) out.phases.add(a.slice(2));
    else out.unknown.push(a);
  }
  return out;
}

// ===========================================================================
// S5/N5 — THE PINNED PAIR'S BASELINE, DERIVED DETERMINISTICALLY
// ===========================================================================
//
// The historical pair claimed (in `r5-formal-pair.json` AND in the report) that
// `r5-real-formal.mjs --setup-pair` "creates the baseline locally from the
// candidate SHA when it is absent, so the pair is reproducible offline". The flag
// existed and NOTHING consumed it: the claim was false, and the pair was in fact
// reproducible only by fetching a commit that is not in this repository.
//
// This is that missing implementation, and it is DETERMINISTIC: the same candidate
// always yields the same baseline SHA, on any machine, with no network, because
// every input to the commit object is fixed — the candidate's tree, the ONE
// transformed file, a fixed message, a fixed author and a fixed timestamp. The
// commit is built with `git hash-object -t commit -w --stdin` from bytes this
// module assembles, so no git heuristic (`commit.gpgsign`, hooks, message cleanup)
// can add a header or change a byte.
//
// PROVEN, not asserted: with the historical recipe (candidate 2314ce1d, the R15
// message/author/date) this generator reproduces the hand-made commit 4f8d98ec
// BYTE-FOR-BYTE — same blob e11c4231, same tree 8c0471fc, same commit SHA. That
// self-test lives in `apps/cli/src/n5-pair-setup.test.ts` and is skipped where the
// historical objects are not present (a shallow CI clone).

/** The ONE file a comparable baseline may differ in. */
const BASELINE_MECHANISM_PATH = "packages/evaluation/src/mechanism-guidance.ts";

/**
 * The ONE transformation: the v1 tool-call-efficiency strategy text neutralised to
 * the empty string, exactly as the historical comparable baselines were built.
 * Deterministic and fail-closed: if the anchor does not appear EXACTLY once the
 * generator refuses rather than emitting a baseline nobody reviewed.
 */
export function neutraliseGuidance(source) {
  const pattern = /export const TOOL_CALL_EFFICIENCY_GUIDANCE_V1 = \[[\s\S]*?\]\.join\("\\n"\);/;
  const hits = source.match(new RegExp(pattern.source, "g")) ?? [];
  if (hits.length !== 1) {
    throw new Error(
      `R5_PAIR_TRANSFORM_FAILED: expected exactly ONE TOOL_CALL_EFFICIENCY_GUIDANCE_V1 array literal in ${BASELINE_MECHANISM_PATH}, found ${hits.length} — the baseline must be derived by a reviewed transformation, never guessed`,
    );
  }
  return source.replace(pattern, 'export const TOOL_CALL_EFFICIENCY_GUIDANCE_V1 = "";');
}

/** The fixed recipe the N5 baseline is derived with. `epochSeconds` is computed
 *  from a fixed ISO instant so two machines agree on the commit bytes. */
export const R5_BASELINE_RECIPE = Object.freeze({
  message:
    "E4-N5: purpose-built comparable baseline (neutralize tool_call_efficiency_v1 guidance only)\n" +
    "\n" +
    "The candidate arm is this commit's parent, unmodified. The ENTIRE diff is\n" +
    "packages/evaluation/src/mechanism-guidance.ts: TOOL_CALL_EFFICIENCY_GUIDANCE_V1 is\n" +
    "set to the empty string and nothing else changes. Both arms therefore carry the\n" +
    "same S1/S2 budget, cancellation and evidence infrastructure, and the only\n" +
    "dimension under test is the pre-registered guidance text.\n" +
    "\n" +
    "This commit is NOT an ancestor of product main and deliberately fails its own\n" +
    "product-strategy assertions; that is the point of a comparable baseline and it\n" +
    "MUST NOT be fixed on main. It is reproduced offline by `--setup-pair`, which\n" +
    "asserts the derived SHA equals the pinned one.\n",
  authorName: "n5-formal",
  authorEmail: "n5@local",
  epochSeconds: Math.floor(Date.parse("2026-09-30T00:00:00+08:00") / 1000),
  timezone: "+0800",
});

/** `git` with the output NOT trimmed — a blob read must keep its exact bytes. */
function gitRaw(root, args, input) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

/**
 * Build the deterministic neutralised child commit of `candidateSha`.
 *
 * The tree is assembled through a PRIVATE `GIT_INDEX_FILE`, so the driver's own
 * work tree, index and HEAD are never touched — this works on a dirty tree, which
 * matters because the pin step runs before the final commit is written.
 */
export async function deriveNeutralisedCommit(repoRoot, recipe) {
  const { candidateSha, message, authorName, authorEmail, epochSeconds, timezone } = recipe;
  const source = gitRaw(repoRoot, ["show", `${candidateSha}:${BASELINE_MECHANISM_PATH}`]);
  const transformed = neutraliseGuidance(source);
  const blob = gitRaw(repoRoot, ["hash-object", "-w", "--stdin"], transformed).trim();

  const scratch = await mkdtemp(join(tmpdir(), "r5-setup-pair-"));
  const indexArgs = (args) =>
    execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: join(scratch, "index") },
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  try {
    indexArgs(["read-tree", candidateSha]);
    indexArgs(["update-index", "--cacheinfo", `100644,${blob},${BASELINE_MECHANISM_PATH}`]);
    const tree = indexArgs(["write-tree"]);
    const commitBody =
      `tree ${tree}\n` +
      `parent ${candidateSha}\n` +
      `author ${authorName} <${authorEmail}> ${epochSeconds} ${timezone}\n` +
      `committer ${authorName} <${authorEmail}> ${epochSeconds} ${timezone}\n` +
      `\n` +
      message;
    const sha = gitRaw(repoRoot, ["hash-object", "-t", "commit", "-w", "--stdin"], commitBody).trim();
    return { sha, tree, blob, transformedBytes: Buffer.byteLength(transformed, "utf8") };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Derive the N5 baseline for one candidate SHA. */
export async function deriveBaselineCommit(repoRoot, candidateSha) {
  return deriveNeutralisedCommit(repoRoot, {
    candidateSha,
    message: R5_BASELINE_RECIPE.message,
    authorName: R5_BASELINE_RECIPE.authorName,
    authorEmail: R5_BASELINE_RECIPE.authorEmail,
    epochSeconds: R5_BASELINE_RECIPE.epochSeconds,
    timezone: R5_BASELINE_RECIPE.timezone,
  });
}

/** Does this repository hold the object? (Empty output + exit 0 = yes.) */
function objectPresent(root, revision) {
  try {
    return git(root, ["cat-file", "-e", `${revision}^{commit}`]) !== null;
  } catch {
    return false;
  }
}

/**
 * Make the pinned pair usable locally: the candidate must exist, and the baseline
 * is either already present or derived — and a DERIVED baseline whose SHA is not
 * the pinned one is a SETUP FAILURE, never a silently different experiment.
 */
export async function setupPair(configPath, repoRoot = REPO_ROOT) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    return { ok: false, code: "PAIR_CONFIG_UNREADABLE", detail: `${configPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const baselineSha = config?.baseline?.sha;
  const candidateSha = config?.candidate?.sha;
  if (!isSha40(baselineSha) || !isSha40(candidateSha)) {
    return { ok: false, code: "PAIR_CONFIG_INVALID", detail: "baseline.sha and candidate.sha must both be 40-hex revisions" };
  }
  if (!objectPresent(repoRoot, candidateSha)) {
    return {
      ok: false,
      code: "CANDIDATE_ABSENT",
      detail: `the candidate ${candidateSha} is not present in ${repoRoot}; the pair cannot be reproduced from a commit this repository does not have`,
    };
  }
  const already = objectPresent(repoRoot, baselineSha);
  const derived = await deriveBaselineCommit(repoRoot, candidateSha);
  if (derived.sha !== baselineSha) {
    return {
      ok: false,
      code: "BASELINE_PIN_MISMATCH",
      detail:
        `deriving the baseline from candidate ${candidateSha} produced ${derived.sha}, but the pair pins ${baselineSha}. ` +
        `A pair is re-pinned by DERIVING the baseline and writing that SHA into r5-formal-pair.json (--derive-baseline), never by accepting whatever came out.`,
    };
  }
  return { ok: true, baselineSha, candidateSha, created: !already, tree: derived.tree, blob: derived.blob };
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
    // S5/N5 — FAIL LOUDLY BEFORE ANY PHASE if this driver's own clock would make
    // the campaign deadline already-expired. Phase-scoped and fatal on purpose:
    // the alternative is a silent `records=0` reported as an arm problem.
    assertCampaignClockIsOpen(CAMPAIGN_NOW, R5_DECLARED_MAX_DURATION_MS);
    if (args.phases.has("identity")) report.identity = await phaseIdentity();
    if (args.phases.has("formal")) report.formalSmall = await phaseFormal({ full: false, workRoot });
    if (args.phases.has("full")) report.formalFull = await phaseFormal({ full: true, workRoot });
    if (args.phases.has("content")) report.contentFixture = await phaseContent({ workRoot });
    if (args.phases.has("content-matrix")) {
      const cm = await phaseContentMatrix({ workRoot });
      report.contentMatrix = cm.matrix;
      report.contentMatrixRuns = cm.perMode;
    }
    if (args.phases.has("negative")) report.negative = await phaseNegative({ workRoot });
  } catch (err) {
    report.fatal = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  }
  // S5/N5 — THE SCRATCH ROOT IS **NOT** DELETED HERE ANY MORE.
  //
  // It used to be, in this `finally`, and that single line is what emptied the
  // bundle: `writeEvidenceBundle` runs BELOW this point and copies the per-armRun
  // evidence (`<phase>/out/runs/evidence/<armRunId>/…`), the cost journal, the
  // dispatch journal and the aggregate OUT of this root. Deleting the root first
  // left every copy with a non-existent source, which the copies silently skip, so
  // the bundle kept `raw/` EMPTY and the gate reported 20 × MISSING_EVIDENCE plus
  // JOURNAL_MISMATCH — with the failures on the record but no longer recomputable.
  // The deletion now happens after the bundle has taken its copy (see below).

  const summary = [];
  if (report.identity) {
    for (const [armId, a] of Object.entries(report.identity.arms)) {
      summary.push(
        `identity ${armId}: exists=${a.exists} head=${a.head?.slice(0, 12) ?? "null"} clean=${a.clean ?? "?"} closure=${a.buildDigestShort ?? "?"} P2-41=${a.protocolFixes?.["P2-41"]?.presentInArmBuild ?? "?"} P2-43=${a.protocolFixes?.["P2-43"]?.presentInArmBuild ?? "?"} abi=[${(a.workerAbi ?? []).join(",")}] loadedEntryAgrees=${a.entryHashAgrees === true ? "yes" : "NO"} probe=${a.probe === null || a.probe === undefined ? "MISSING" : String(a.probe).split("wiring=")[1]?.slice(0, 12) ?? "present"}`,
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
  } finally {
    // NOW the scratch root may go: the bundle holds the bytes.
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
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

/** The codes the fixture bundle records for each required counter-example. */
const FIXTURE_REFUSAL_CODES = {
  "swapped-arms": "TRUSTED_BUILD_NOT_PROVEN",
  "missing-ABI": "ARM_WORKER_ABI_UNSUPPORTED",
  "wrong-policy": "PREREGISTRATION_IDENTITY_DRIFT",
  "undeclared-mode": "EGRESS_ISOLATION_UNAVAILABLE",
  "dirty-tree": "TRUSTED_BUILD_NOT_PROVEN",
  "unsupported-isolation": "ARM_ISOLATION_UNSUPPORTED",
};

function isSha40(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}
function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
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
  // S5/N5 — the entry is also REALLY LOADED, in its own process and its own cwd,
  // so `probe` is an observation of the module rather than a string scraped out of
  // a text scan. `buildDigest` identifies the arm's execution closure; the PROBE
  // is what binds the mechanism wiring, and the entry hash is cross-checked
  // against the driver's own read below.
  const loaded = observeArmEntryLoad(dir, "apps/cli/dist/benchmark-command.js");
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
    probe: loaded.probe,
    probeError: loaded.error,
    runOneCaseExport: loaded.runOneCaseExport,
    declaredArmAbi: loaded.abi,
    loadedEntrySha256: loaded.entrySha256,
    entryHashAgrees: entrySha256 !== null && loaded.entrySha256 !== null && entrySha256 === loaded.entrySha256,
  };
}

/**
 * S5/N5 — LOAD the arm's built entry the way the FORMAL WORKER loads it, and read
 * the identity the BUILD ITSELF declares.
 *
 * This is a REAL module load in a child process whose cwd IS the arm checkout, so
 * the probe it reports is a property of the module the worker would import — not a
 * regex hit on the bundle's bytes. It returns the child's OWN sha256 of the entry
 * file as well, so the driver can require that the bytes it hashed are the bytes
 * that were imported (a mismatch is reported, never smoothed over).
 *
 * The arm's `r97-arm-abi.js` text scan in `observeArm` stays: it is the same
 * observation `verifyPairArms` documents, and the two together mean a missing ABI
 * is named whether it is missing from the SOURCE or from the LOADED module.
 */
export function observeArmEntryLoad(dir, entryRel) {
  const entryPath = join(dir, entryRel);
  if (!existsSync(entryPath)) return { probe: null, abi: null, runOneCaseExport: "missing", entrySha256: null, error: `the arm declares no built entry at ${entryRel}` };
  const script = [
    'const { createHash } = await import("node:crypto");',
    'const { readFileSync } = await import("node:fs");',
    `const ENTRY_URL = ${JSON.stringify(pathToFileURL(entryPath).href)};`,
    `const ENTRY_PATH = ${JSON.stringify(entryPath)};`,
    "let out = { probe: null, abi: null, runOneCaseExport: 'missing', entrySha256: null, error: null };",
    "try {",
    "  const m = await import(ENTRY_URL);",
    "  out.probe = typeof m.R97_ARM_PROBE === 'string' && m.R97_ARM_PROBE !== '' ? m.R97_ARM_PROBE : null;",
    "  out.abi = Array.isArray(m.R97_ARM_ABI) ? m.R97_ARM_ABI.filter((s) => typeof s === 'string') : null;",
    "  out.runOneCaseExport = typeof m.runOneCase;",
    "  out.entrySha256 = createHash('sha256').update(readFileSync(ENTRY_PATH, 'utf8'), 'utf8').digest('hex');",
    "} catch (err) { out.error = err && err.message ? String(err.message) : String(err); }",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch (err) {
    const detail = err !== null && typeof err === "object" && "stderr" in err ? String(err.stderr ?? "") : "";
    return {
      probe: null,
      abi: null,
      runOneCaseExport: "missing",
      entrySha256: null,
      error: `the arm entry could not be loaded: ${(detail.trim() || (err instanceof Error ? err.message : String(err))).split("\n")[0]}`,
    };
  }
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
    // S5/N5 — the root identity must be able to BIND an execution: without a
    // really-loaded probe and an entry hash that the loading process agrees with,
    // there is nothing for a record's manifest to be checked against. A fixture
    // bundle is exempt from the PRESENCE rule only (it declares `fixture: true`
    // and is never evidence that an experiment ran); a real bundle is not.
    if (identity.fixture !== true) {
      if (!isNonEmptyString(arm.probe)) {
        failures.push(
          fail("ARM_IDENTITY_INCOMPLETE", `${armId} records no probe from a real module load${arm.probeError === undefined || arm.probeError === null ? "" : ` (${String(arm.probeError)})`}, so no manifest can be bound to this arm's build`),
        );
      }
      if (arm.entryHashAgrees !== true) {
        failures.push(
          fail("ARM_IDENTITY_INCOMPLETE", `${armId} does not record that the entry bytes the driver hashed are the bytes the loader imported (driver ${String(arm.entrySha256).slice(0, 12)}…, loader ${String(arm.loadedEntrySha256).slice(0, 12)}…)`),
        );
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

    // ---- S5/N5: the manifest must describe THIS run, on THIS arm's build ----
    //
    // A6 (`verifyArmEvidenceFromArtifacts`) already replays the run identity and
    // the declared trace digest, and it deliberately admits manifests whose build
    // fields are ABSENT so old fixtures keep working. That permissiveness must not
    // be read as a real-layer pass, so the binding to the ROOT identity is checked
    // here — and for a real bundle the three build fields are REQUIRED.
    //
    // Measured against the pre-S5 gate: a bundle carrying one arm's manifest under
    // another arm's record, a swapped root buildDigest, a swapped entry hash, a
    // swapped baseline/candidate identity and a manifest with its build fields
    // deleted were ALL accepted with exit 0.
    if (existsSync(manifestPath)) {
      let man = null;
      try {
        man = readJsonFile(manifestPath);
      } catch {
        failures.push(fail("MANIFEST_IDENTITY_MISMATCH", `${label} carries a manifest that is not readable JSON`));
      }
      if (man !== null && typeof man === "object" && !Array.isArray(man)) {
        for (const key of ["armRunId", "armId", "caseId", "repetition", "orderIndex"]) {
          if (man[key] !== rec[key]) {
            failures.push(
              fail(
                "MANIFEST_IDENTITY_MISMATCH",
                `${label} carries a manifest whose ${key} is ${JSON.stringify(man[key])} — the record and its evidence describe different runs (a spliced manifest cannot be attributed to this arm run)`,
              ),
            );
          }
        }
        const armIdentity = identity.pair?.[String(rec.armId)] ?? null;
        const buildFields = { armBuildDigest: armIdentity?.buildDigest ?? null, armEntrySha256: armIdentity?.entrySha256 ?? null, armProbe: armIdentity?.probe ?? null };
        const absent = Object.keys(buildFields).filter((k) => !isNonEmptyString(man[k]));
        if (absent.length > 0) {
          if (identity.fixture !== true) {
            failures.push(
              fail(
                "ARM_BUILD_FIELDS_MISSING",
                `${label} carries no ${absent.join(", ")} in its manifest, so the build that RAN this arm run is not bound to the root identity (a real-layer bundle must name it)`,
              ),
            );
          }
        } else {
          const codes = {
            armBuildDigest: "ARM_BUILD_DIGEST_MISMATCH",
            armEntrySha256: "ARM_ENTRY_MISMATCH",
            armProbe: "ARM_PROBE_MISMATCH",
          };
          for (const [field, expected] of Object.entries(buildFields)) {
            if (isNonEmptyString(expected) && man[field] !== expected) {
              failures.push(
                fail(
                  codes[field],
                  `${label} manifest ${field} ${String(man[field]).slice(0, 24)}… is not the ${String(rec.armId)} build the root identity observed (${String(expected).slice(0, 24)}…)`,
                ),
              );
            }
          }
        }
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

    // ---- N3: the TOOL-DISPATCH journal, through the SAME shared contract ----
    //
    // The readiness verifier (`readiness-evidence-verify.mjs`) and this bundle
    // verifier must recompute ONE contract, not two drifting copies — that is why
    // the checks live in `n3-dispatch-journal-contract.mjs` and both import them.
    //
    // What is checked here is the RAW journal this bundle carries, against the
    // schedule it declares and the request/attempt entries of the cost journal it
    // also carries: schema, field types, the closed settlement enum, unique
    // identifiers, a contiguous event sequence, the coverage proof, the parent
    // request/attempt it names, and count conservation against the durable
    // `charged.toolCalls` / `reserved.toolCalls`.
    //
    // A MISSING journal stays NOT_PROVEN; it is never read as "nothing
    // dispatched". The synthetic fixture bundle is exempt ONLY because it declares
    // `fixture: true` and its cost journal carries no tool dimension at all — a
    // real bundle that wired the campaign tool budget must carry one.
    const dispatchNames = existsSync(root)
      ? readdirSync(root).filter((n) => /^dispatch.*\.json$/i.test(n)).sort()
      : [];
    const journalArmRuns = new Map();
    for (const rec of records) {
      if (rec === null || typeof rec !== "object" || typeof rec.armRunId !== "string") continue;
      journalArmRuns.set(rec.armRunId, {
        armRunId: rec.armRunId,
        armId: rec.armId,
        caseId: rec.caseId,
        repetition: rec.repetition,
        orderIndex: rec.orderIndex,
      });
    }
    const chargedToolCalls = Number.isInteger(journal.charged?.toolCalls) ? journal.charged.toolCalls : null;
    const reservedToolCalls = Number.isInteger(journal.reserved?.toolCalls) ? journal.reserved.toolCalls : null;
    if (dispatchNames.length === 0) {
      if (identity.fixture !== true) {
        failures.push(
          fail(
            "DISPATCH_JOURNAL_MISSING",
            "the bundle carries no dispatch journal, so a tool call that was granted a reservation but never settled cannot be excluded from the budget proof (NOT_PROVEN, not zero)",
          ),
        );
      } else if ((chargedToolCalls ?? 0) > 0 || (reservedToolCalls ?? 0) > 0) {
        failures.push(
          fail(
            "DISPATCH_JOURNAL_MISSING",
            `the cost journal shows ${String(chargedToolCalls)} charged / ${String(reservedToolCalls)} outstanding tool call(s) but the bundle carries no dispatch journal`,
          ),
        );
      }
    } else {
      const dispatchPath = need(dispatchNames[0]);
      let dispatchJournal = null;
      try {
        dispatchJournal = readJsonFile(dispatchPath);
      } catch {
        failures.push(fail("DISPATCH_JOURNAL_MALFORMED", `${dispatchNames[0]} is not readable JSON`));
      }
      if (dispatchJournal !== null) {
        const verdict = verifyDispatchJournal({
          journal: dispatchJournal,
          journalFile: dispatchNames[0],
          scheduleArms: journalArmRuns,
          requestEntries: Array.isArray(journal.entries) ? journal.entries : null,
          budgetFacts: { chargedToolCalls, reservedToolCalls },
        });
        for (const problem of verdict.problems) {
          failures.push(fail(problem.split(":")[0], problem));
        }
      }
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
        // COMPLETENESS FIRST. If the four-variant schedule did not actually run, the
        // honest outcome is a NAMED failure that says which variant is missing — the
        // case is NOT deleted, and a missing variant is never read as a pass.
        for (const variant of ["correct", "empty", "wrong", "skipped"]) {
          const verdict = variants[variant];
          if (verdict !== "passed" && verdict !== "failed") {
            failures.push(
              fail(
                "CONTENT_MATRIX_INCOMPLETE",
                `${caseId}/${armId} has no "${variant}" variant result (got ${String(verdict)}): the four-variant schedule did not run, so content sensitivity is unproven for this case`,
              ),
            );
          }
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
    // The producer labels a row with the FULL violation description ("dirty-tree (git
    // work tree with uncommitted bytes)") so the report reads well; the required set
    // is keyed by the short id. Match on the prefix so a reworded description cannot
    // silently drop a required counter-example.
    const rowFor = (violation) => rows.find((r) => r.violation === violation || String(r.violation).startsWith(`${violation} `) || String(r.violation).startsWith(`${violation}(`));
    for (const violation of REQUIRED_NEGATIVES) {
      if (rowFor(violation) === undefined) {
        failures.push(fail("NEGATIVE_ROW_MISSING", `the counter-example "${violation}" is not recorded`));
      }
    }
    for (const row of rows) {
      if (row.exitCode === 0) {
        failures.push(fail("NEGATIVE_ACCEPTED", `the "${String(row.violation)}" counter-example was ACCEPTED (exit 0) instead of refused`));
      }
      // REFUSED FOR THE RIGHT REASON. A row that is refused by an unrelated
      // condition (a dirty driver tree refuses EVERY row with
      // PREREGISTRATION_IDENTITY_DRIFT) does not evidence the boundary it names, so
      // the code must match. `expectedRefusalCode` is recorded by the producer from
      // EXPECTED_REFUSAL_CODES; a row with no expectation cannot be checked and is
      // reported as such rather than passed silently.
      if (row.refused === true) {
        if (row.expectedRefusalCode === null || row.expectedRefusalCode === undefined) {
          failures.push(
            fail("NEGATIVE_WRONG_REASON", `the "${String(row.violation)}" row records no expected refusal code, so "refused" cannot be attributed to this violation`),
          );
        } else if (row.refusalCode !== row.expectedRefusalCode) {
          failures.push(
            fail(
              "NEGATIVE_WRONG_REASON",
              `the "${String(row.violation)}" row was refused with ${String(row.refusalCode)} but this violation must produce ${String(row.expectedRefusalCode)}; the refusal is not evidence for this boundary`,
            ),
          );
        }
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
    // `phaseIdentity()` observes the git/build identity; the WORKER ABI has to be
    // observed separately (it is a property of the arm's own dist tree), so ask
    // `observeArm` rather than assuming a field that phaseIdentity never sets —
    // assuming it is what made the first real run report WORKER_ABI_MISSING for two
    // arms that do declare the ABI.
    const abiObserved = observeArm(armId === "baseline" ? DEFAULT_PAIR.baseline : DEFAULT_PAIR.candidate, PAIR_CONFIG);
    pair[armId] = {
      sourceSha: armId === "baseline" ? PAIR_CONFIG.baseline.sha : PAIR_CONFIG.candidate.sha,
      head: observed?.head ?? abiObserved.head ?? null,
      clean: observed?.clean ?? abiObserved.clean ?? null,
      buildDigest: typeof observed?.buildDigest === "string" && observed.buildDigest.length === 64 ? observed.buildDigest : abiObserved.buildDigest,
      entrySha256: observed?.entrySha256 ?? abiObserved.entrySha256 ?? null,
      workerAbi: abiObserved.workerAbi ?? [],
      // S5/N5 — the LOADED entry identity: the probe the build's own module
      // exports (observed by really importing it), the hash the CHILD computed for
      // the file it imported, and whether that agrees with the driver's own read.
      probe: abiObserved.probe ?? null,
      probeError: abiObserved.probeError ?? null,
      loadedEntrySha256: abiObserved.loadedEntrySha256 ?? null,
      entryHashAgrees: abiObserved.entryHashAgrees === true,
      declaredArmAbi: abiObserved.declaredArmAbi ?? null,
      runOneCaseExport: abiObserved.runOneCaseExport ?? null,
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
  if (budgetDir !== null && existsSync(budgetDir)) {
    for (const name of readdirSync(budgetDir)) {
      if (name.startsWith("dispatch") && name.endsWith(".json")) {
        await cp(join(budgetDir, name), join(evidenceDir, name));
      }
    }
  }
  if (formal?.dir !== undefined && existsSync(join(formal.dir, "aggregate.json"))) {
    await cp(join(formal.dir, "aggregate.json"), join(evidenceDir, "aggregate.json"));
  }

  // The content matrix, taken from the per-case RAW verifier evidence. RESTRICTED to
  // the content-sensitive cases (`CONTENT_FIXES`): a case with no content dimension
  // has no empty/wrong/skipped meaning, and seeding it here would manufacture a
  // CONTENT_MATRIX_INCOMPLETE failure for a case that was never supposed to have one.
  const matrixCases = {};
  for (const [caseId, entry] of Object.entries(formal?.evidence?.perCase ?? {})) {
    if (!(caseId in CONTENT_FIXES)) continue;
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
          // The refusal CODE and the code this violation MUST produce travel with the
          // row, so the gate can tell "refused for the right reason" from "refused
          // because the driver work tree happened to be dirty".
          refusalCode: r.refusalCode ?? null,
          expectedRefusalCode: r.expectedRefusalCode ?? null,
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

/**
 * A deliberately SYNTHETIC but internally CONSISTENT bundle, for the counter-examples.
 *
 * S5/N5 — TWO SHAPES, ONE HONESTY LABEL.
 *
 * `fixture: true` (the default) is the labelled synthetic bundle: it says so in
 * `identity.json` and is never evidence that an experiment ran.
 * `fixture: false` (`--emit-real-shaped-bundle`) has the SHAPE of a real bundle —
 * per-arm probes, entry hashes and per-run manifests that carry the build fields —
 * because the build-binding checks below only mean something if a bundle can carry
 * the fields they require. Having the SHAPE is NOT evidence that a real run
 * happened, and the emitted `identity.json` of the real-shaped bundle is written by
 * THIS function, which never builds an arm, never spawns a worker and never
 * contacts a provider. Only the real chain's own `writeEvidenceBundle` produces
 * evidence.
 */
export async function emitFixtureBundle(dir, opts = {}) {
  const fixture = opts.fixture !== false;
  await mkdir(dir, { recursive: true });
  const armRuns = [
    { armRunId: "fixture-baseline-reg-12-csv-parse-r1", armId: "baseline", caseId: "reg-12-csv-parse", repetition: 1, orderIndex: 0 },
    { armRunId: "fixture-candidate-reg-12-csv-parse-r1", armId: "candidate", caseId: "reg-12-csv-parse", repetition: 1, orderIndex: 1 },
  ];
  // One build identity per arm, and a manifest for EACH run that names exactly the
  // run it belongs to and the build it ran on.
  const armBuild = {
    baseline: { buildDigest: "a".repeat(64), entrySha256: "b".repeat(64), probe: "r97-arm-probe-v1;candidate=tool_call_efficiency_v1;guidance=fixture-baseline" },
    candidate: { buildDigest: "c".repeat(64), entrySha256: "d".repeat(64), probe: "r97-arm-probe-v1;candidate=tool_call_efficiency_v1;guidance=fixture-candidate" },
  };
  const manifestTexts = {};
  for (const rec of armRuns) {
    const evDir = join(dir, "evidence", rec.armRunId);
    await mkdir(evDir, { recursive: true });
    const manifestText = `${JSON.stringify(
      {
        schemaVersion: "prereg-run-manifest-v1",
        executorId: "fixture",
        preregistrationDigest: "f".repeat(64),
        planDigest: "f".repeat(64),
        armRunId: rec.armRunId,
        armId: rec.armId,
        caseId: rec.caseId,
        repetition: rec.repetition,
        orderIndex: rec.orderIndex,
        armBuildDigest: armBuild[rec.armId].buildDigest,
        armEntrySha256: armBuild[rec.armId].entrySha256,
        armProbe: armBuild[rec.armId].probe,
        fixture: true,
      },
      null,
      2,
    )}\n`;
    manifestTexts[rec.armRunId] = manifestText;
    await writeFile(join(evDir, "manifest.json"), manifestText, "utf8");
    await writeFile(
      join(evDir, "verifier.json"),
      `${JSON.stringify({ fixture: true, armRunId: rec.armRunId, verifiedCompletion: true, casesTotal: 1, casesVerified: 1 }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(evDir, "security.json"), `${JSON.stringify({ fixture: true, violations: [] }, null, 2)}\n`, "utf8");
  }
  const armIdentitySource = (armId) => ({
    sourceSha: armId === "baseline" ? PAIR_CONFIG.baseline.sha : PAIR_CONFIG.candidate.sha,
    head: armId === "baseline" ? PAIR_CONFIG.baseline.sha : PAIR_CONFIG.candidate.sha,
    clean: true,
    buildDigest: armBuild[armId].buildDigest,
    entrySha256: armBuild[armId].entrySha256,
    workerAbi: PAIR_CONFIG.requiredWorkerAbi,
    protocolFixes: { "P2-41": true, "P2-43": true },
    probe: armBuild[armId].probe,
    probeError: null,
    loadedEntrySha256: armBuild[armId].entrySha256,
    entryHashAgrees: true,
    declaredArmAbi: PAIR_CONFIG.requiredWorkerAbi,
    runOneCaseExport: "function",
  });
  await writeFile(
    join(dir, "identity.json"),
    `${JSON.stringify(
      {
        schemaVersion: R5_EVIDENCE_SCHEMA,
        fixture,
        gateVersion: R5_GATE_VERSION,
        driverHead: PAIR_CONFIG.candidate.sha,
        treeClean: true,
        platform: `${process.platform}-${process.arch}`,
        pair: {
          baseline: armIdentitySource("baseline"),
          candidate: armIdentitySource("candidate"),
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
        records: armRuns.map((r) => ({
          ...r,
          status: "ok",
          verifiedCompletion: true,
          traceDigest: sha256Hex(manifestTexts[r.armRunId]),
          preregistrationDigest: "f".repeat(64),
          planDigest: "f".repeat(64),
          evidenceFiles: ["manifest.json", "verifier.json", "security.json"],
        })),
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
        // S5/N5 — the durable TOOL dimension the dispatch contract reconciles
        // against. Zero here, and proved zero below by a coverage record for every
        // scheduled arm run rather than by an absent file.
        charged: { totalTokens: 230, toolCalls: 0 },
        reserved: { toolCalls: 0 },
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

  if (!fixture) {
    // A real-SHAPED bundle carries a dispatch journal, because a real bundle that
    // wired the campaign tool budget must: its absence is `DISPATCH_JOURNAL_MISSING`
    // (NOT_PROVEN, never "nothing dispatched"). This one is EMPTY on purpose and
    // carries the coverage proof the contract requires for an empty journal.
    const at = 1_700_000_000_000;
    await writeFile(
      join(dir, "dispatch-journal.json"),
      `${JSON.stringify(
        {
          schemaVersion: "e4-n3-tool-dispatch-journal-v1",
          campaignDigest: "f".repeat(64),
          eventCount: 0,
          events: [],
          coverage: {
            armRuns: armRuns.map((r, i) => ({ armRunId: r.armRunId, openedAtMs: at + i, closedAtMs: at + i + 1, reserveFrames: 0, settleFrames: 0 })),
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
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
          refusalCode: FIXTURE_REFUSAL_CODES[violation],
          expectedRefusalCode: FIXTURE_REFUSAL_CODES[violation],
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

  if (args.emitRealShapedBundle !== null) {
    await emitFixtureBundle(resolve(args.emitRealShapedBundle), { fixture: false });
    process.stdout.write(
      `wrote a bundle with the real bundle's SHAPE to ${resolve(args.emitRealShapedBundle)}\n` +
        "  it has no arm build, no worker run and no provider call behind it: SHAPE is not EVIDENCE\n",
    );
    return 0;
  }

  if (args.deriveBaseline !== null) {
    const result = await deriveBaselineCommit(REPO_ROOT, args.deriveBaseline);
    process.stdout.write(`R5 pair baseline for candidate ${args.deriveBaseline}:\n  ${result.sha}\n`);
    return 0;
  }

  if (args.setupPair !== null) {
    const result = await setupPair(args.setupPair);
    if (!result.ok) {
      process.stderr.write(`SETUP FAILED ${result.code}: ${result.detail}\n`);
      return 1;
    }
    process.stdout.write(`PAIR READY: baseline ${result.baselineSha} (${result.created ? "created" : "already present"}), candidate ${result.candidateSha}\n`);
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
