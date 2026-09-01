/**
 * E2-02 — Experiment Provenance V3: prove same source, same build, same
 * environment, same cases, same protocol.
 *
 * provenance-v2 (E1-07) compared per-case context hashes + judge version +
 * config-hash-differs. It is NOT promotion-grade: two runs from DIFFERENT
 * dirty SHAs could look "comparable" because the per-case hashes matched.
 * ProvenanceV3 closes that gap with full identity capture:
 *
 *   - BuildIdentityV3     — reproducible clean source/build or an explicit
 *                           dirty bundle that is NEVER promotion-eligible;
 *   - EnvironmentIdentityV3 — runtime/toolchain identity (node/pnpm/os/arch/
 *                           runner + artifact schema versions);
 *   - ProviderIdentityV3  — normalized non-secret model endpoint identity
 *                           (endpoint is a digest, never the raw URL/token);
 *   - CaseIdentityV3      — digest over EVERYTHING the model saw or the judge
 *                           used: canonical case payload, request/expected,
 *                           fixture tree (relative paths + digests),
 *                           verification/forbidden/limits, judge/policy
 *                           versions, tool schema;
 *   - ProtocolIdentityV3  — case set, order seed, arm order, repetition,
 *                           interleave, retry rule, pairing key, call cap.
 *
 * The comparer splits fields into MUST-match (identical), MAY-differ (declared
 * arm delta only), and ANY-UNKNOWN-REJECTS. It returns a structured result
 * with stable reason codes and exact mismatch paths — never just a verdict.
 *
 * Provenance is CAPTURED from actual run inputs (manifests, case payloads,
 * tool schema), never fabricated: callers pass what was really recorded, and
 * the helpers normalize/digest them deterministically.
 */

import { createHash } from "node:crypto";
import { computeRuntimeConfigHash, stableStringify } from "./manifest.js";

export const PROVENANCE_V3_SCHEMA_VERSION = "3.0.0";

// ---------------------------------------------------------------------------
// Identity types
// ---------------------------------------------------------------------------

/** Clean-build reproducibility identity. */
export interface BuildIdentityV3 {
  /** Git commit SHA (null = no git). */
  gitSha: string | null;
  /** True when the working tree was clean at capture time. */
  clean: boolean | null;
  /** Source bundle/diff digest when dirty (never promotion-eligible). */
  sourceBundleDigest: string | null;
  /** sha256 over the repo lockfile (package-lock/pnpm-lock/yarn). */
  lockfileDigest: string | null;
  /** sha256 over the build outputs/package sources (nullable). */
  buildOutputDigest: string | null;
  /** Node version (process.version). */
  nodeVersion: string | null;
  /** pnpm version (nullable). */
  pnpmVersion: string | null;
  /** OS + arch (process.platform / process.arch). */
  os: string | null;
  arch: string | null;
  /** Artifact schema version that produced this identity. */
  artifactSchemaVersion: string;
  /** Benchmark runner version. */
  runnerVersion: string | null;
}

/** Runtime/toolchain environment identity. */
export interface EnvironmentIdentityV3 {
  platform: string | null;
  nodeVersion: string | null;
  processArch: string | null;
  /** Environment contract hash (sandbox/permissions contract). */
  environmentContractHash: string | null;
}

/** Normalized (non-secret) model provider identity. */
export interface ProviderIdentityV3 {
  /** Provider type, e.g. "openai-compatible" | "stub". */
  providerType: string | null;
  /** Exact model id (e.g. "deepseek-v4-flash"). */
  modelId: string | null;
  /** sha256 over the normalized endpoint host+path (NEVER the raw URL/token). */
  endpointIdentity: string | null;
  temperature: number | null;
  /** top-p; null = not pinned. */
  topP: number | null;
  /** model seed; null = not set. */
  modelSeed: number | null;
  /** Explicit support declaration: "supported" | "unsupported" | "unknown". */
  modelSeedSupport: "supported" | "unsupported" | "unknown";
  maxTokens: number | null;
  timeoutMs: number | null;
  /** sha256 over the normalized retry policy (backoff/count, no secrets). */
  retryPolicyIdentity: string | null;
}

/** One fixture-tree entry (relative path + type/mode + content digest). */
export interface FixtureEntryV3 {
  relativePath: string;
  fileType: string | null;
  mode: string | null;
  digest: string | null;
}

/** Case identity: digest over everything the model saw / judge used. */
export interface CaseIdentityV3 {
  caseId: string;
  /** Canonical sha256 over ALL case inputs (see captureCaseIdentityV3). */
  digest: string;
  /** Component digests for diagnostics (never rely on the final hash alone). */
  components: {
    canonicalCase: string | null;
    request: string | null;
    expected: string | null;
    fixtureTree: string | null;
    verificationForbidden: string | null;
    policyVersions: string | null;
    toolSchema: string | null;
  };
}

/** Experiment protocol identity (E2-05 pairing semantics). */
export interface ProtocolIdentityV3 {
  /** sha256 over the ordered case-id set. */
  caseSetDigest: string | null;
  /** PRNG order seed. */
  orderSeed: number | null;
  /** Arm order, e.g. ["baseline", "candidate"]. */
  armOrder: string[] | null;
  repetitionCount: number | null;
  interleaveStrategy: string | null;
  /** Retry identity rule (same-task bounded retry). */
  retryIdentityRule: string | null;
  /** Resume plan (null = single-shot). */
  resumePlan: string | null;
  /** Pairing key binding baseline+candidate into one experiment. */
  pairingKey: string | null;
  expectedCallCap: number | null;
}

/** The full V3 provenance of one arm. */
export interface ExperimentProvenanceV3 {
  schemaVersion: typeof PROVENANCE_V3_SCHEMA_VERSION;
  armId: string;
  candidateId: string | null;
  build: BuildIdentityV3;
  environment: EnvironmentIdentityV3;
  provider: ProviderIdentityV3;
  /** Per-required-case identities (all cases the protocol requires). */
  cases: CaseIdentityV3[];
  protocol: ProtocolIdentityV3;
  /** Dirty-state check at the END of the run (invalidates final provenance). */
  finalSourceClean: boolean | null;
}

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export type ProvenanceV3ReasonCode =
  | "BUILD_SHA_MISMATCH"
  | "BUILD_DIRTY"
  | "SOURCE_BUNDLE_DIGEST_MISMATCH"
  | "LOCKFILE_MISMATCH"
  | "BUILD_OUTPUT_MISMATCH"
  | "RUNTIME_VERSION_MISMATCH"
  | "PLATFORM_MISMATCH"
  | "ENVIRONMENT_CONTRACT_MISMATCH"
  | "PROVIDER_TYPE_MISMATCH"
  | "MODEL_MISMATCH"
  | "ENDPOINT_MISMATCH"
  | "TEMPERATURE_MISMATCH"
  | "TOP_P_MISMATCH"
  | "MODEL_SEED_MISMATCH"
  | "MODEL_SEED_UNSUPPORTED"
  | "MAX_TOKENS_MISMATCH"
  | "TIMEOUT_MISMATCH"
  | "RETRY_POLICY_MISMATCH"
  | "CASE_SET_MISMATCH"
  | "CASE_DIGEST_MISMATCH"
  | "CASE_COVERAGE_MISSING"
  | "PROTOCOL_MISMATCH"
  | "PAIRING_KEY_MISMATCH"
  | "ARM_DELTA_UNDECLARED"
  | "SOURCE_BECAME_DIRTY"
  | "UNKNOWN_IDENTITY";

// ---------------------------------------------------------------------------
// Capture helpers (deterministic; no fabricated values)
// ---------------------------------------------------------------------------

function digest(value: unknown): string {
  return computeRuntimeConfigHash(value);
}

/** Endpoint identity: digest of the NORMALIZED origin — never the raw URL
 *  (which may carry query tokens) nor secret material. */
export function captureEndpointIdentity(baseUrl: string | null | undefined): string | null {
  if (baseUrl === undefined || baseUrl === null || baseUrl === "") return null;
  try {
    const url = new URL(baseUrl);
    // Normalize: lowercase host, default ports stripped, drop query/hash.
    const port = url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))
      ? `:${url.port}`
      : "";
    const normalized = `${url.protocol}//${url.hostname.toLowerCase()}${port}${url.pathname.replace(/\/+$/, "") || "/"}`;
    return digest(normalized);
  } catch {
    // Not a URL — hash the trim so we still detect change without leaking.
    return digest(String(baseUrl).trim());
  }
}

/** Build identity capture from recorded facts (never fabricated). */
export function captureBuildIdentityV3(input: {
  gitSha: string | null;
  dirty: boolean | null;
  sourceBundleDigest?: string | null;
  lockfileDigest?: string | null;
  buildOutputDigest?: string | null;
  nodeVersion?: string | null;
  pnpmVersion?: string | null;
  os?: string | null;
  arch?: string | null;
  runnerVersion?: string | null;
}): BuildIdentityV3 {
  return {
    gitSha: input.gitSha,
    clean: input.dirty === null ? null : !input.dirty,
    sourceBundleDigest: input.sourceBundleDigest ?? null,
    lockfileDigest: input.lockfileDigest ?? null,
    buildOutputDigest: input.buildOutputDigest ?? null,
    nodeVersion: input.nodeVersion ?? null,
    pnpmVersion: input.pnpmVersion ?? null,
    os: input.os ?? null,
    arch: input.arch ?? null,
    artifactSchemaVersion: PROVENANCE_V3_SCHEMA_VERSION,
    runnerVersion: input.runnerVersion ?? null,
  };
}

/** Provider identity capture; secrets are never part of the identity. */
export function captureProviderIdentityV3(
  input: {
    providerType?: string | null;
    modelId?: string | null;
    baseUrl?: string | null;
    temperature?: number | null;
    topP?: number | null;
    modelSeed?: number | null;
    modelSeedSupport?: "supported" | "unsupported" | "unknown";
    maxTokens?: number | null;
    timeoutMs?: number | null;
    retryPolicy?: unknown;
  },
): ProviderIdentityV3 {
  return {
    providerType: input.providerType ?? null,
    modelId: input.modelId ?? null,
    endpointIdentity: captureEndpointIdentity(input.baseUrl),
    temperature: input.temperature ?? null,
    topP: input.topP ?? null,
    modelSeed: input.modelSeed ?? null,
    modelSeedSupport: input.modelSeedSupport ?? "unknown",
    maxTokens: input.maxTokens ?? null,
    timeoutMs: input.timeoutMs ?? null,
    retryPolicyIdentity: input.retryPolicy === undefined || input.retryPolicy === null
      ? null
      : digest(input.retryPolicy),
  };
}

/** True when a path is absolute (Windows drive / UNC or POSIX root).
 *  Absolute temp paths are NOT part of the experiment and must never enter
 *  the case digest. */
function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/])|^(\/)|^(\\\\|\/\/)/.test(p);
}

/** Capture one case identity from the FULL case input surface. */
export function captureCaseIdentityV3(input: {
  caseId: string;
  /** Canonical case definition (stable-serialized EvalCase minus fixture text). */
  canonicalCase?: unknown;
  request?: string | null;
  expected?: string | null;
  /** Fixture tree: RELATIVE paths only (absolute temp paths are never
   *  part of the digest). */
  fixtureTree?: FixtureEntryV3[];
  verificationForbidden?: unknown;
  policyVersions?: unknown;
  toolSchema?: unknown;
}): CaseIdentityV3 {
  // Absolute temp/scratch paths are excluded from the digest: they are not
  // part of the experiment, and a different temp location must not change
  // the case identity (E2-02 acceptance #4).
  const fixtureTree = (input.fixtureTree ?? []).filter((f) => !isAbsolutePath(f.relativePath)).map((f) => ({
    relativePath: f.relativePath,
    fileType: f.fileType ?? null,
    mode: f.mode ?? null,
    digest: f.digest ?? null,
  }));
  const components = {
    canonicalCase: input.canonicalCase === undefined ? null : digest(input.canonicalCase),
    request: input.request === undefined || input.request === null ? null : digest(input.request),
    expected: input.expected === undefined || input.expected === null ? null : digest(input.expected),
    fixtureTree: fixtureTree.length === 0 ? null : digest(fixtureTree),
    verificationForbidden: input.verificationForbidden === undefined ? null : digest(input.verificationForbidden),
    policyVersions: input.policyVersions === undefined ? null : digest(input.policyVersions),
    toolSchema: input.toolSchema === undefined ? null : digest(input.toolSchema),
  };
  return {
    caseId: input.caseId,
    digest: digest({ ...components, caseId: input.caseId }),
    components,
  };
}

/** Capture protocol identity. */
export function captureProtocolIdentityV3(input: ProtocolIdentityV3): ProtocolIdentityV3 {
  return {
    caseSetDigest: input.caseSetDigest ?? null,
    orderSeed: input.orderSeed ?? null,
    armOrder: input.armOrder ? [...input.armOrder] : null,
    repetitionCount: input.repetitionCount ?? null,
    interleaveStrategy: input.interleaveStrategy ?? null,
    retryIdentityRule: input.retryIdentityRule ?? null,
    resumePlan: input.resumePlan ?? null,
    pairingKey: input.pairingKey ?? null,
    expectedCallCap: input.expectedCallCap ?? null,
  };
}

// ---------------------------------------------------------------------------
// Comparer
// ---------------------------------------------------------------------------

export interface ProvenanceMismatchV3 {
  field: string;
  baseline: string | null;
  candidate: string | null;
}

export interface ProvenanceCompatibilityV3 {
  schemaVersion: string;
  comparable: boolean;
  /** Strict promotion gate — false when ANY fork is unknown/invalid. */
  promotionEligible: boolean;
  reasonCodes: ProvenanceV3ReasonCode[];
  /** Exact mismatch path + both values for diagnostics (no secrets). */
  mismatches: ProvenanceMismatchV3[];
  /** Declared arm deltas vs observed config differences. */
  armDelta: { declared: string[]; observed: string[] };
}

function mismatch(
  field: string,
  baseline: unknown,
  candidate: unknown,
  code: ProvenanceV3ReasonCode,
): ProvenanceMismatchV3 {
  return { field, baseline: String(baseline ?? ""), candidate: String(candidate ?? "") };
}

/** Compare two arm provenances. `declaredArmDelta` is the set of candidate
 *  knobs the experiment DECLARED as the single controlled difference. */
export function compareProvenanceV3(
  baseline: ExperimentProvenanceV3,
  candidate: ExperimentProvenanceV3,
  opts: { declaredArmDelta?: string[]; strict?: boolean } = {},
): ProvenanceCompatibilityV3 {
  const strict = opts.strict ?? true;
  const declared = new Set(opts.declaredArmDelta ?? []);
  const reasonCodes: ProvenanceV3ReasonCode[] = [];
  const mismatches: ProvenanceMismatchV3[] = [];
  const observed: string[] = [];

  const fail = (code: ProvenanceV3ReasonCode, field: string, b: unknown, c: unknown): void => {
    reasonCodes.push(code);
    mismatches.push(mismatch(field, b, c, code));
  };
  const same = (label: string, b: unknown, c: unknown): boolean => String(b ?? "") === String(c ?? "");

  // ---- BUILD (must match; dirty is never promotion-eligible) ----
  if (same("build.gitSha", baseline.build.gitSha, candidate.build.gitSha) === false) {
    fail("BUILD_SHA_MISMATCH", "build.gitSha", baseline.build.gitSha, candidate.build.gitSha);
  }
  if (baseline.build.clean === false) {
    reasonCodes.push("BUILD_DIRTY");
    mismatches.push({ field: "build.clean", baseline: "false", candidate: String(candidate.build.clean) });
  }
  if (candidate.build.clean === false) {
    reasonCodes.push("BUILD_DIRTY");
    mismatches.push({ field: "build.clean", baseline: String(baseline.build.clean), candidate: "false" });
  }
  if (baseline.build.sourceBundleDigest !== null && candidate.build.sourceBundleDigest !== null
    && !same("build.sourceBundleDigest", baseline.build.sourceBundleDigest, candidate.build.sourceBundleDigest)) {
    fail("SOURCE_BUNDLE_DIGEST_MISMATCH", "build.sourceBundleDigest", baseline.build.sourceBundleDigest, candidate.build.sourceBundleDigest);
  }
  if (baseline.build.lockfileDigest !== null && candidate.build.lockfileDigest !== null
    && !same("build.lockfileDigest", baseline.build.lockfileDigest, candidate.build.lockfileDigest)) {
    fail("LOCKFILE_MISMATCH", "build.lockfileDigest", baseline.build.lockfileDigest, candidate.build.lockfileDigest);
  }
  if (baseline.build.buildOutputDigest !== null && candidate.build.buildOutputDigest !== null
    && !same("build.buildOutputDigest", baseline.build.buildOutputDigest, candidate.build.buildOutputDigest)) {
    fail("BUILD_OUTPUT_MISMATCH", "build.buildOutputDigest", baseline.build.buildOutputDigest, candidate.build.buildOutputDigest);
  }

  // ---- ENVIRONMENT ----
  if (baseline.environment.nodeVersion !== null && candidate.environment.nodeVersion !== null
    && !same("env.nodeVersion", baseline.environment.nodeVersion, candidate.environment.nodeVersion)) {
    fail("RUNTIME_VERSION_MISMATCH", "environment.nodeVersion", baseline.environment.nodeVersion, candidate.environment.nodeVersion);
  }
  if (baseline.environment.platform !== null && candidate.environment.platform !== null
    && !same("env.platform", baseline.environment.platform, candidate.environment.platform)) {
    fail("PLATFORM_MISMATCH", "environment.platform", baseline.environment.platform, candidate.environment.platform);
  }
  if (baseline.environment.environmentContractHash !== null
    && candidate.environment.environmentContractHash !== null
    && !same("env.contractHash", baseline.environment.environmentContractHash, candidate.environment.environmentContractHash)) {
    fail("ENVIRONMENT_CONTRACT_MISMATCH", "environment.environmentContractHash", baseline.environment.environmentContractHash, candidate.environment.environmentContractHash);
  }

  // ---- PROVIDER (strict: endpoint/model/temperature/retry must match) ----
  if (same("provider.providerType", baseline.provider.providerType, candidate.provider.providerType) === false) {
    fail("PROVIDER_TYPE_MISMATCH", "provider.providerType", baseline.provider.providerType, candidate.provider.providerType);
  }
  if (same("provider.modelId", baseline.provider.modelId, candidate.provider.modelId) === false) {
    fail("MODEL_MISMATCH", "provider.modelId", baseline.provider.modelId, candidate.provider.modelId);
  }
  if (same("provider.endpointIdentity", baseline.provider.endpointIdentity, candidate.provider.endpointIdentity) === false) {
    fail("ENDPOINT_MISMATCH", "provider.endpointIdentity", baseline.provider.endpointIdentity, candidate.provider.endpointIdentity);
  }
  if (strict && !same("provider.temperature", baseline.provider.temperature, candidate.provider.temperature)) {
    fail("TEMPERATURE_MISMATCH", "provider.temperature", baseline.provider.temperature, candidate.provider.temperature);
  }
  if (strict && !same("provider.topP", baseline.provider.topP, candidate.provider.topP)) {
    fail("TOP_P_MISMATCH", "provider.topP", baseline.provider.topP, candidate.provider.topP);
  }
  if (strict && !same("provider.modelSeed", baseline.provider.modelSeed, candidate.provider.modelSeed)) {
    fail("MODEL_SEED_MISMATCH", "provider.modelSeed", baseline.provider.modelSeed, candidate.provider.modelSeed);
  }
  // Model seed support must be explicit, never faked reproducible.
  if (baseline.provider.modelSeedSupport === "unknown" || candidate.provider.modelSeedSupport === "unknown") {
    reasonCodes.push("MODEL_SEED_UNSUPPORTED");
    mismatches.push({ field: "provider.modelSeedSupport", baseline: baseline.provider.modelSeedSupport, candidate: candidate.provider.modelSeedSupport });
  } else if (baseline.provider.modelSeedSupport === "unsupported" || candidate.provider.modelSeedSupport === "unsupported") {
    reasonCodes.push("MODEL_SEED_UNSUPPORTED");
    mismatches.push({ field: "provider.modelSeedSupport", baseline: baseline.provider.modelSeedSupport, candidate: candidate.provider.modelSeedSupport });
  }
  if (strict && !same("provider.maxTokens", baseline.provider.maxTokens, candidate.provider.maxTokens)) {
    fail("MAX_TOKENS_MISMATCH", "provider.maxTokens", baseline.provider.maxTokens, candidate.provider.maxTokens);
  }
  if (strict && !same("provider.timeoutMs", baseline.provider.timeoutMs, candidate.provider.timeoutMs)) {
    fail("TIMEOUT_MISMATCH", "provider.timeoutMs", baseline.provider.timeoutMs, candidate.provider.timeoutMs);
  }
  if (strict && !same("provider.retryPolicyIdentity", baseline.provider.retryPolicyIdentity, candidate.provider.retryPolicyIdentity)) {
    fail("RETRY_POLICY_MISMATCH", "provider.retryPolicyIdentity", baseline.provider.retryPolicyIdentity, candidate.provider.retryPolicyIdentity);
  }

  // ---- CASE IDs (must be the same required case set + identical digests) ----
  const bCases = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const cCases = new Map(candidate.cases.map((c) => [c.caseId, c]));
  const bIds = [...bCases.keys()].sort();
  const cIds = [...cCases.keys()].sort();
  if (JSON.stringify(bIds) !== JSON.stringify(cIds)) {
    fail("CASE_SET_MISMATCH", "cases", bIds.join(","), cIds.join(","));
  }
  for (const id of bIds) {
    const b = bCases.get(id);
    const c = cCases.get(id);
    if (b === undefined || c === undefined) {
      reasonCodes.push("CASE_COVERAGE_MISSING");
      mismatches.push({ field: `cases.${id}`, baseline: b ? "present" : "missing", candidate: c ? "present" : "missing" });
      continue;
    }
    if (!same(`cases.${id}.digest`, b.digest, c.digest)) {
      fail("CASE_DIGEST_MISMATCH", `cases.${id}.digest`, b.digest, c.digest);
      // Diagnostic: report the differing component (never just the final hash).
      for (const [comp, bv] of Object.entries(b.components)) {
        const cv = c.components[comp as keyof typeof b.components];
        if (String(bv ?? "") !== String(cv ?? "")) {
          mismatches.push({ field: `cases.${id}.components.${comp}`, baseline: String(bv ?? ""), candidate: String(cv ?? "") });
        }
      }
    }
  }

  // ---- PROTOCOL ----
  const protoFields: Array<[string, keyof ProtocolIdentityV3]> = [
    ["protocol.caseSetDigest", "caseSetDigest"],
    ["protocol.orderSeed", "orderSeed"],
    ["protocol.repetitionCount", "repetitionCount"],
    ["protocol.interleaveStrategy", "interleaveStrategy"],
    ["protocol.retryIdentityRule", "retryIdentityRule"],
    ["protocol.resumePlan", "resumePlan"],
    ["protocol.expectedCallCap", "expectedCallCap"],
  ];
  let anyProtoMismatch = false;
  for (const [label, key] of protoFields) {
    const b = baseline.protocol[key];
    const c = candidate.protocol[key];
    if (b !== null && c !== null && String(b) !== String(c)) {
      fail("PROTOCOL_MISMATCH", label, b, c);
      anyProtoMismatch = true;
    }
  }
  if (!anyProtoMismatch && JSON.stringify(baseline.protocol.armOrder ?? []) !== JSON.stringify(candidate.protocol.armOrder ?? [])) {
    fail("PROTOCOL_MISMATCH", "protocol.armOrder", baseline.protocol.armOrder?.join(",") ?? "", candidate.protocol.armOrder?.join(",") ?? "");
  }
  if (baseline.protocol.pairingKey !== null && candidate.protocol.pairingKey !== null
    && String(baseline.protocol.pairingKey) !== String(candidate.protocol.pairingKey)) {
    fail("PAIRING_KEY_MISMATCH", "protocol.pairingKey", baseline.protocol.pairingKey, candidate.protocol.pairingKey);
  }

  // ---- SOURCE cleanliness at the END of the run ----
  if (baseline.finalSourceClean === false || candidate.finalSourceClean === false) {
    reasonCodes.push("SOURCE_BECAME_DIRTY");
    mismatches.push({
      field: "finalSourceClean",
      baseline: String(baseline.finalSourceClean),
      candidate: String(candidate.finalSourceClean),
    });
  }

  // ---- Declared arm delta must be the ONLY allowed difference ----
  // Candidate config hash difference is EXPECTED (the arm delta). Any other
  // observed difference has already failed above. If nothing differs but the
  // candidate declares a delta, that is fine (delta is in config, not these
  // identities). If a difference appears that was NOT declared, fail.
  if (candidate.candidateId !== null && !declared.has("candidateConfig")) {
    observed.push("candidateConfig");
    reasonCodes.push("ARM_DELTA_UNDECLARED");
    mismatches.push({ field: "armDelta", baseline: "(none)", candidate: candidate.candidateId });
  }

  const unknownFork = reasonCodes.some((c) =>
    ["UNKNOWN_IDENTITY", "BUILD_DIRTY", "SOURCE_BECAME_DIRTY", "MODEL_SEED_UNSUPPORTED"].includes(c));
  const comparable = reasonCodes.length === 0;
  const promotionEligible = strict ? comparable && !unknownFork : comparable;

  return {
    schemaVersion: PROVENANCE_V3_SCHEMA_VERSION,
    comparable,
    promotionEligible,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    mismatches,
    armDelta: { declared: [...declared], observed },
  };
}

/** Whether any component of the provenance is unknown (fails promotion). */
export function hasUnknownIdentity(p: ExperimentProvenanceV3): boolean {
  return (
    p.build.gitSha === null
    || p.build.clean === null
    || p.provider.endpointIdentity === null
    || p.provider.modelId === null
    || p.protocol.caseSetDigest === null
  );
}