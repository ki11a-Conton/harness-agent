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
 * For identity the build CANNOT independently establish (`runtimeConfigDigest`,
 * `requestProfileDigest`, and the declared `usdMicrosPerCall`), it reports
 * `UNOBSERVABLE` / `null` rather than guessing. Because those never equal a
 * bound value, the formal gate REFUSES (`PREREGISTRATION_IDENTITY_DRIFT`, or
 * `PRICING_UNKNOWN` for an unknown price on a money-bounded campaign) with
 * `providerFactoryCalls = 0`. "Cannot certify" is expressed as a refusal, which
 * is exactly the fail-closed contract — never as a fabricated match.
 *
 * EXECUTION (`runArm`) is NOT wired here. No production paired-arm executor
 * exists for the v2 API, so this adapter REFUSES to fabricate a run result. That
 * is deliberate: a placeholder `{status:"passed"}` would be the "self-reported
 * outcome" defect (F2) this chain exists to prevent. Admission happens before
 * `runArm`, so a real operator still gets the full preflight; execution fails
 * closed with a stable reason code until a real executor is provided.
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
  toolCallEfficiencyGuidanceDigest,
  type PreregisteredArmRunner,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";
import { stableStringify } from "@ar/evaluation";
import { REAL_PROVIDER_ID, STUB_PROVIDER_ID, resolveModelProvider } from "./provider.js";
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
  const baseUrl = env["OPENAI_BASE_URL"];
  const apiKey = env["OPENAI_API_KEY"];
  const model = env["OPENAI_MODEL"];
  const providerConfigured = (model !== undefined && model !== "") || (apiKey !== undefined && apiKey !== "");
  return {
    // A non-40-hex (or unreadable) HEAD can never equal a bound sha → refusal.
    candidateSourceSha: head !== null && /^[0-9a-f]{40}$/.test(head) ? head : "",
    // `porcelain === null` (git unreadable) is NOT clean → refusal.
    cleanTree: porcelain === "",
    baselineArmDigest: armDigest(env["R97_ARM_BASELINE_DIR"]),
    candidateArmDigest: armDigest(env["R97_ARM_CANDIDATE_DIR"]),
    guidanceDigest: toolCallEfficiencyGuidanceDigest(),
    contractDigest: sha256Hex(stableStringify(mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2))),
    // No independent production source for the runtime-config digest.
    runtimeConfigDigest: UNOBSERVABLE,
    providerId: providerConfigured ? REAL_PROVIDER_ID : STUB_PROVIDER_ID,
    modelId: model ?? "",
    endpointDigest:
      captureEndpointIdentity(baseUrl !== undefined && baseUrl !== "" ? baseUrl : null) ?? UNOBSERVABLE,
    // No independent production source for the request-profile digest.
    requestProfileDigest: UNOBSERVABLE,
    // Filled per-artifact by `observeCaseContentDigests`.
    caseContentDigests: {},
    decisionPolicyDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    // No declared price source in this build → `null` (= unknown). On a
    // money-bounded campaign the gate refuses with `PRICING_UNKNOWN`.
    usdMicrosPerCall: null,
  };
}

/** Read a fixture directory into a deterministic `relative path -> text` map. */
function readFixture(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isDir(dir)) return out;
  const walk = (rel: string): void => {
    const abs = rel === "" ? dir : join(dir, rel);
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const childAbs = join(dir, childRel);
      if (isDir(childAbs)) walk(childRel);
      else out[childRel] = readFileSync(childAbs, "utf8");
    }
  };
  walk("");
  return out;
}

/** Locate a real benchmark case directory, or `null` when it is not present. */
function locateCaseDir(root: string, suite: string, caseId: string): string | null {
  for (const candidate of [join(root, "benchmarks", suite, caseId), join(root, "benchmarks", caseId)]) {
    if (isDir(candidate)) return candidate;
  }
  return null;
}

/**
 * Re-derive each BOUND case's content digest from the real case files, using the
 * SAME canonical contract the builder uses (`catalogEntryFromCase`). A case that
 * cannot be located is OMITTED — never guessed — so the observed id set differs
 * from the bound one and the gate refuses.
 */
export function observeCaseContentDigests(
  root: string,
  prereg: ToolCallEfficiencyPreregistrationV2,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of prereg.dataset.cases) {
    const dir = locateCaseDir(root, c.suite, c.caseId);
    if (dir === null) continue;
    try {
      out[c.caseId] = catalogEntryFromCase(
        {
          id: c.caseId,
          suite: c.suite,
          requestMd: readFileSync(join(dir, "request.md"), "utf8"),
          expectedMd: readFileSync(join(dir, "expected.md"), "utf8"),
          fixture: readFixture(join(dir, "fixture")),
        },
        { eligible: true, holdout: false, evidence: {} },
      ).contentDigest;
    } catch {
      // Unreadable bytes are NOT an observation — leave the case omitted.
    }
  }
  return out;
}

/** A `runArm` that refuses to invent an outcome, with a stable reason code. */
async function runArmNotWired(): Promise<never> {
  const err = new Error(
    `${ARM_EXECUTOR_NOT_WIRED}: no production paired-arm executor is wired for this build — refusing to fabricate a run result (a placeholder outcome would defeat the evidence requirement this chain exists to enforce)`,
  );
  (err as { code?: string }).code = ARM_EXECUTOR_NOT_WIRED;
  throw err;
}

export interface ProductionPreregRunnerOptions {
  /** Checkout the identity is observed from; defaults to `process.cwd()`. */
  rootDir?: string;
  /** Environment the provider identity is observed from; defaults to the process env. */
  env?: NodeJS.ProcessEnv;
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
    observe: async (prereg) => ({
      ...observeExecutionIdentity(rootDir, env),
      caseContentDigests: observeCaseContentDigests(rootDir, prereg),
    }),
    makeProvider: async (): Promise<ModelProvider> => (await resolveModelProvider()).provider,
    runArm: runArmNotWired as PreregisteredArmRunner,
  };
}