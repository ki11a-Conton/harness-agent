/**
 * S2/F1b — the PRODUCTION `prereg` harness adapter.
 *
 * The N5 suite proves the closed loop works when a TEST injects a runner
 * (`CommandDeps.preregRunner`). That is not the shipped path: `node apps/cli/dist/
 * main.js prereg …` runs `preregCommandDeps()`, which used to return `{}` — so
 * `prereg validate`/`run` refused with "no harness adapter wired" no matter how
 * valid the artifact was. This module supplies the seam the release CLI was
 * missing.
 *
 * FAIL-CLOSED IDENTITY (the whole point)
 * -------------------------------------
 * `observe` re-derives the CURRENT execution identity from sources that EXIST
 * independently of the artifact, and it NEVER echoes the artifact's own claims
 * back as "observed":
 *
 *   candidateSourceSha     git HEAD of the checkout
 *   cleanTree              `git status --porcelain` is empty
 *   guidanceDigest         the authoritative guidance constants
 *   contractDigest         the authoritative mechanism contract
 *   decisionPolicyDigest   the DEFAULT decision policy actually enforced
 *   providerId/modelId/    the environment the provider WILL be resolved from
 *   endpointDigest           (OPENAI_MODEL / OPENAI_API_KEY / OPENAI_BASE_URL)
 *   baselineArmDigest/     the two frozen arm checkouts, when they are present
 *   candidateArmDigest       (R97_ARM_BASELINE_DIR / R97_ARM_CANDIDATE_DIR)
 *   caseContentDigests     real `benchmarks/<suite>/<caseId>/` files
 *
 * For identity the build CANNOT independently establish (the two frozen arm
 * checkouts when they are absent), it reports `UNOBSERVABLE` rather than
 * guessing. Because those never equal a bound value, the formal gate REFUSES
 * (`PREREGISTRATION_IDENTITY_DRIFT`) with `providerFactoryCalls = 0`.
 * "Cannot certify" is expressed as a refusal, which is exactly the fail-closed
 * contract — never as a fabricated match.
 *
 * The runtime/request-profile identity, the provider/model/endpoint identity
 * and the per-call price are DERIVED from the real execution sources in
 * `prereg-execution-identity.ts` (A2) — the SAME source `prereg build` writes
 * from — so a legal frozen experiment can be certified, and any drift refuses.
 *
 * A5 — EXECUTION (`runArm`) is now wired to the REAL arm executor
 * (`prereg-arm-executor.ts`): it resolves the arm's frozen checkout, runs the
 * real case through the benchmark harness with the budget-wrapped provider the
 * gate returned, invokes the real verifier and writes the raw evidence
 * artifacts A6 re-reads. Every prerequisite it cannot establish — a missing arm
 * checkout (`ARM_CHECKOUT_MISSING`), an unreadable build closure
 * (`ARM_BUILD_UNRESOLVABLE`), one build for both arms (`ARM_BUILD_IDENTICAL`), a
 * case outside the frozen selection (`ARM_CASE_NOT_FOUND`), an evidence
 * directory (`ARM_EVIDENCE_DIR_MISSING`), a provider — is a stable refusal,
 * never a fabricated `{status:"passed"}`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModelProvider } from "@ar/contracts";
import {
  DEFAULT_DECISION_POLICY_V3,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  captureEndpointIdentity,
  catalogEntryFromCase,
  computeArmBuildDigestV1,
  computeThresholdDigestV3,
  mechanismContractFor,
  readCaseFiles,
  resolveBenchmarkCaseDir,
  selectionFromFrozenEvidence,
  toolCallEfficiencyGuidanceDigest,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";
import { stableStringify } from "@ar/evaluation";
import { PROVIDER_DEFAULT_ENDPOINT_DIGEST } from "@ar/evaluation";
import { createPreregArmExecutor } from "./prereg-arm-executor.js";
import { resolveModelProvider } from "./provider.js";
import { formalExecutionProfile, resolveUsdMicrosPerCall } from "./prereg-execution-identity.js";
import type { PreregRunnerAdapter } from "./prereg-command.js";

/**
 * A value the observer could NOT independently establish. It is deliberately
 * NOT a valid sha/digest, so it can never equal an artifact's bound value: the
 * gate then refuses with `PREREGISTRATION_IDENTITY_DRIFT`. This is the
 * fail-closed encoding of "unobservable" (see the module docstring).
 */
export const UNOBSERVABLE = "<unobservable-in-this-build>";

/** A stable, machine-readable reason code for the fail-closed execution refusal. */
export const ARM_EXECUTOR_NOT_WIRED = "ARM_EXECUTOR_NOT_WIRED";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The arm's execution build digest from a real checkout, or `UNOBSERVABLE`. */
function armDigest(dir: string | undefined): string {
  if (dir === undefined || dir === "" || !isDir(dir)) return UNOBSERVABLE;
  try {
    return computeArmBuildDigestV1(dir);
  } catch {
    return UNOBSERVABLE;
  }
}

/**
 * Re-observe the execution identity from the REAL checkout + environment.
 *
 * `env` is injectable so the identity can be pinned deterministically in a test
 * without touching the process environment; the default is the process env the
 * provider resolution itself reads.
 */
export function observeExecutionIdentity(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): PreregisteredCampaignObservationV2 {
  const head = git(root, ["rev-parse", "HEAD"]);
  const porcelain = git(root, ["status", "--porcelain"]);
  // A2 — the runtime/request-profile identity, the provider/model/endpoint
  // identity and the per-call price are derived from the SAME source the
  // execution path uses (`resolveModelProvider` + the pinned harness wiring +
  // the versioned pricing snapshot). Echoing the artifact's own claims would be
  // the drift defect this observer exists to prevent.
  const { provider, runtimeConfigDigest, requestProfileDigest } = formalExecutionProfile(env);
  const endpointDigest = captureEndpointIdentity(provider.endpointBaseUrl) ?? PROVIDER_DEFAULT_ENDPOINT_DIGEST;
  return {
    // A non-40-hex (or unreadable) HEAD can never equal a bound sha → refusal.
    candidateSourceSha: head !== null && /^[0-9a-f]{40}$/.test(head) ? head : "",
    // `porcelain === null` (git unreadable) is NOT clean → refusal.
    cleanTree: porcelain === "",
    baselineArmDigest: armDigest(env["R97_ARM_BASELINE_DIR"]),
    candidateArmDigest: armDigest(env["R97_ARM_CANDIDATE_DIR"]),
    guidanceDigest: toolCallEfficiencyGuidanceDigest(),
    contractDigest: sha256Hex(stableStringify(mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2))),
    runtimeConfigDigest,
    providerId: provider.providerId,
    modelId: provider.modelId,
    endpointDigest,
    requestProfileDigest,
    // Filled per-artifact by `observeCaseContentDigests`.
    caseContentDigests: {},
    // B1 — the eligibility/provenance fields are NOT derivable from the checkout
    // + env alone: they need the committed frozen selection evidence. A raw
    // identity observation therefore carries the FAIL-CLOSED placeholder (an
    // empty map and an unobservable provenance digest), which can never equal a
    // bound value — `createProductionPreregRunner` overwrites them with the
    // independently re-derived values via `observeFrozenSelectionEvidence`.
    eligibilityDigests: {},
    selectionProvenanceDigest: UNOBSERVABLE,
    decisionPolicyDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    // A2/B2 — a VERSIONED per-model/per-endpoint price: a genuinely observable
    // `0` for the unbilled stub, an explicit snapshot bound for a known model on
    // the first-party endpoint, and `null` (unknown) for a proxy endpoint or an
    // unlisted model — which the money-bounded gate refuses as `PRICING_UNKNOWN`,
    // never a silent zero.
    usdMicrosPerCall: resolveUsdMicrosPerCall(provider.providerId, {
      modelId: provider.modelId,
      endpointBaseUrl: provider.endpointBaseUrl,
    }),
  };
}

/**
 * Re-derive each BOUND case's content digest from the real case files, using the
 * SAME canonical contract the builder uses (`catalogEntryFromCase`) and the SAME
 * path boundary the production selection uses (`resolveBenchmarkCaseDir`). A
 * case that cannot be located — an unsafe `suite`/`caseId` (separator, `..`,
 * absolute), the `holdout` suite, a symlink escaping `benchmarks/`, or simply a
 * missing directory — is OMITTED, never guessed, so the observed id set differs
 * from the bound set and the formal gate refuses.
 *
 * NOTE: only CONTENT is re-derived here. Independent re-derivation of
 * ELIGIBILITY is the separate A2 item and is NOT claimed by this function.
 */
export function observeCaseContentDigests(
  root: string,
  prereg: ToolCallEfficiencyPreregistrationV2,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of prereg.dataset.cases) {
    const dir = resolveBenchmarkCaseDir(root, c.suite, c.caseId);
    if (dir === null) {
      // Refused by the boundary (unsafe segment / holdout / escape / missing).
      process.stderr.write(`[degraded] prereg observer refused case ${c.suite}/${c.caseId}: not a readable benchmarks case directory\n`);
      continue;
    }
    try {
      const files = readCaseFiles(dir);
      out[c.caseId] = catalogEntryFromCase(
        {
          id: c.caseId,
          suite: c.suite,
          requestMd: files.requestMd,
          expectedMd: files.expectedMd,
          fixture: files.fixture,
        },
        { eligible: true, holdout: false, evidence: {} },
      ).contentDigest;
    } catch (err) {
      // Unreadable bytes are NOT an observation — leave the case omitted (the
      // observed id set then differs from the bound set and the gate refuses).
      // Reported, not swallowed: a silent skip would be indistinguishable from
      // "the case was never bound" (P14-6 requires observability).
      process.stderr.write(
        `[degraded] prereg observer could not digest case ${c.suite}/${c.caseId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }
  return out;
}

export interface ProductionPreregRunnerOptions {
  /** Checkout the identity is observed from; defaults to `process.cwd()`. */
  rootDir?: string;
  /** Environment the provider identity is observed from; defaults to the process env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * B1 — the frozen-selection observation, re-derived READ-ONLY from the
 * committed evidence, never echoed from the artifact under validation.
 *
 * `selectionFromFrozenEvidence` is the SAME production derivation `prereg build`
 * uses: it re-reads the frozen selection artifact at its fixed trusted path,
 * binds the taxonomy bytes by digest, re-derives each case's CONTENT from the
 * real `benchmarks/<suite>/<caseId>/` files and each case's ELIGIBILITY from the
 * taxonomy, and RECOMPUTES the selection's own provenance digest from its body.
 * A missing/edited/inconsistent evidence source THROWS (fail closed), so the
 * `observe` step refuses before any provider factory is touched.
 *
 * The returned `eligibilityDigests` are keyed by the FROZEN selection's case ids:
 * comparing that key set to the artifact's bound case set (`observationViolationsV2`)
 * is what makes a forged catalog / swapped eligibility a refusal.
 */
export interface FrozenSelectionObservation {
  caseIds: string[];
  eligibilityDigests: Record<string, string>;
  selectionProvenanceDigest: string;
}

export function observeFrozenSelectionEvidence(root: string): FrozenSelectionObservation {
  const frozen = selectionFromFrozenEvidence({ root });
  const eligibilityDigests: Record<string, string> = {};
  for (const entry of frozen.catalog) eligibilityDigests[entry.caseId] = entry.eligibilityDigest;
  return {
    caseIds: frozen.catalog.map((c) => c.caseId),
    eligibilityDigests,
    selectionProvenanceDigest: frozen.selection.selectionProvenanceDigest,
  };
}

/**
 * The production adapter the release CLI wires into `preregCommandDeps()`. It
 * performs NO I/O at construction — `observe`/`makeProvider` are the only
 * side-effecting calls, and `makeProvider` is invoked only after the gate admits.
 */
export function createProductionPreregRunner(opts: ProductionPreregRunnerOptions = {}): PreregRunnerAdapter {
  const rootDir = opts.rootDir ?? process.cwd();
  const env = opts.env ?? process.env;
  return {
    observe: async (prereg) => {
      // B1 — re-derive the selection provenance + eligibility from the frozen
      // evidence BEFORE returning the observation. If the frozen evidence is
      // absent/inconsistent this THROWS, so the gate refuses with zero provider
      // factory calls rather than certifying a self-declared catalog.
      const frozen = observeFrozenSelectionEvidence(rootDir);
      return {
        ...observeExecutionIdentity(rootDir, env),
        caseContentDigests: observeCaseContentDigests(rootDir, prereg),
        eligibilityDigests: frozen.eligibilityDigests,
        selectionProvenanceDigest: frozen.selectionProvenanceDigest,
      };
    },
    makeProvider: async (): Promise<ModelProvider> => (await resolveModelProvider()).provider,
    // A5 — the REAL executor. It fails closed (`ARM_CHECKOUT_MISSING` /
    // `ARM_BUILD_IDENTICAL` / `ARM_CASE_NOT_FOUND` / `ARM_EVIDENCE_DIR_MISSING`)
    // rather than fabricating a run result.
    runArm: createPreregArmExecutor({ rootDir, env }),
  };
}