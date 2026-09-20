/**
 * E4-R97 — the FINALIZED authorization plan, built from REAL arm observations.
 *
 * Plan §R97 怎么做 (line 211-213) is the specification for this module:
 *
 *   - "现有 computeArmPlanDigest 是计划期自定义摘要，不能用作真实 CLI dry-run
 *     摘要替身。先无 key 检出、构建、加载实际案例，再由真实 dry-run 生成每臂执行
 *     计划。" — the plan-time custom digest is NOT a substitute for the real CLI
 *     dry-run digest. Each arm's execution-plan digest must come from running the
 *     REAL CLI `--dry-run` inside that arm's own checkout.
 *
 *   - "删掉'observed 值从 authorization 对应字段复制'作为真实性证明的路径。facts
 *     来自 git/build manifest、实际 case 文件、实际 provider 配置。" — DELETE the
 *     path where observed values are copied from the authorization's own fields.
 *     Facts must come from the git/build manifest, the actual case files and the
 *     actual provider configuration.
 *
 *   - "计划草案有缺失 build/tree fingerprint 或未验证 caps 时 NOT_READY/DRAFT；
 *     正式材料必须无需修改就能执行。构建后值变化就重新生成并重新审批，不能继续用
 *     旧 digest。" — a draft missing a build/tree fingerprint or with unverified
 *     caps is NOT_READY/DRAFT; finalized materials must be executable without
 *     modification.
 *
 * The distinction this module enforces is therefore structural, not cosmetic:
 *
 *   DRAFT      — built from the CURRENT checkout only. It has no per-arm
 *                observation, so its arm digests are UNKNOWN (`null`) and it can
 *                never be authorized. A draft exists to be inspected, not approved.
 *
 *   FINALIZED  — built from two REAL per-arm CLI dry-run observations. Every
 *                bound value is an OBSERVED value, so the digest the human
 *                approves is the digest the executor will re-derive.
 *
 * ---- E4-R98/R100 (plan §0.1 F5, "真实执行前必修") --------------------------
 *
 * Plan §R100 做什么 #1 is the specification for the second half of this module:
 *
 *   "分开计划期观测快照和执行期新观测；快照可用于审阅，不能充当当前事实."
 *   (Separate the plan-time observation SNAPSHOT from a FRESH execution-time
 *    observation; the snapshot may be REVIEWED, but it may never stand in for
 *    current fact.)
 *
 * Before R100 the module produced exactly ONE observation block
 * (`R97PlanResult.observation`) and the driver compared the R92 gate against
 * THAT. A plan could therefore authorize a build, an endpoint or case content
 * that had since changed — the artifact asserted what had been true at plan
 * time as though it were true at execution time. That is the defect F5 names:
 * "fake CLI 从 plan.observation 读取快照；runDriver 不重新观测 checkout."
 *
 * The split this module now enforces is therefore:
 *
 *   planObservation            — EVIDENCE OF WHAT WAS OBSERVED WHEN THE PLAN WAS
 *                                BUILT. It is an INPUT TO REVIEW, never a claim
 *                                about the world at execution time.
 *   checkExecutionObservationV1 — the EXECUTION-TIME check. It takes a FRESHLY
 *                                observed fact set and refuses, with a named and
 *                                machine-checkable code, every way the world can
 *                                have moved away from the approved envelope.
 *
 * Two further F5-adjacent invariants live here because the envelope is the only
 * artifact the human approves:
 *
 *   - plan §R100 怎么做: "验证冻结selection内容与digest，不能只读取 parsed.digest
 *     当真." The selection's canonical digest is RECOMPUTED over its payload and
 *     compared, so a post-freeze case-list edit is refused (`SELECTION_DIGEST_MISMATCH`)
 *     rather than believed.
 *   - plan §R100 怎么做: "除 driverVersion 标签外记录 driver构建/源hash；版本字符串
 *     不变而执行代码变化，应使旧计划失效." `driverVersion` is a LABEL that does not
 *     move when driver CODE changes, so a driver BUILD DIGEST over an explicitly
 *     enumerated artifact set is bound beside it.
 *   - plan §R100 怎么做: "mixed-suite 用显式 case inventory 保留真实 suite，不能悄悄
 *     将 stress 全重标 regression." The CLI's `--suite` is SINGLE-VALUED while the
 *     frozen selection spans `regression` + `stress`, so the envelope carries an
 *     explicit per-case inventory naming the TRUE suite.
 *
 * The canonical-digest helper below is a LOCAL implementation rather than an
 * import of `canonicalDigest` from `@ar/core`'s `r87-zero-call-replay-ab`. The
 * dependency direction is already `@ar/evaluation -> @ar/core`, so importing it
 * would not create a cycle today — but the R87 module's digest is bound to the
 * R87 selection's own schema, and this module must reproduce the R87 digest
 * EXACTLY for the committed evidence file to verify. Keeping an independent
 * implementation makes that agreement a checked property (the tests assert the
 * committed digest verifies) instead of an assumption about another module's
 * internals.
 *
 * The module never constructs a provider and never performs a network call.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBenchmarkCase } from "./baseline.js";
import { caseInputFingerprintV1 } from "./paired-execution-identity.js";
import {
  R92_AUTHORIZATION_SCHEMA,
  classifyR92Caps,
  computeR92AuthorizationDigestV1,
  r92AuthorizationIssuesV1,
  r92CapDeclarationIssues,
  r92CapViolations,
  type R92AuthorizationV1,
  type R92CapIntent,
  type R92GateFacts,
} from "./r92-authorization.js";

export const R97_PLAN_SCHEMA = "e4-r97-finalized-authorization-plan-v1";
export const R97_DRAFT_SCHEMA = "e4-r97-draft-authorization-plan-v1";

/** The frozen R87 selection: case choice and ORDER, frozen before execution. */
export const R97_SELECTION_PATH = "docs/evidence/e4-r87-case-selection.json";

/** The driver identity bound into the plan, so the plan names the code that
 *  would execute it. Bumped whenever the driver's behaviour changes. */
export const R97_DRIVER_VERSION = "e4-r97-campaign-driver-v1";

/**
 * The driver artifacts the BUILD DIGEST covers — an explicitly enumerated,
 * deliberately SMALL set, per plan §R100 怎么做:
 *
 *   "支持由清晰构建产物清单界定hash范围，不搞整个工作区不可控hash."
 *   (Bound the hash by a clear build-artifact list; do not hash the whole
 *    workspace uncontrollably.)
 *
 * What is hashed, and why exactly this:
 *
 *   scripts/e4/r97-campaign-driver.mjs       — the executor itself. This is the
 *                                              file that constructs the provider,
 *                                              calls the gate and writes results.
 *   packages/evaluation/src/r97-budget-ledger.ts
 *                                            — the cross-process campaign budget
 *                                              the executor reserves from.
 *   packages/evaluation/src/r97-execution-state.ts
 *                                            — the durable case×arm×repetition
 *                                              state the executor skips/completes
 *                                              against.
 *   packages/evaluation/src/r97-plan.ts      — the plan/envelope contract itself,
 *                                              because a change to the authorized
 *                                              shape changes what execution means.
 *
 * What is deliberately NOT hashed: the whole workspace (unstable — build output,
 * node_modules, editor state, generated evidence), and any file that does not
 * participate in executing this campaign. A `driverVersion` label alone cannot
 * detect a code change; this digest can.
 */
export const R97_DRIVER_ARTIFACTS: readonly string[] = [
  "scripts/e4/r97-campaign-driver.mjs",
  "packages/evaluation/src/r97-budget-ledger.ts",
  "packages/evaluation/src/r97-execution-state.ts",
  "packages/evaluation/src/r97-plan.ts",
] as const;

/** The schema label used to domain-separate the driver build digest, so a digest
 *  computed here can never collide with a digest over some other artifact list. */
export const R97_DRIVER_BUILD_SCHEMA = "e4-r97-driver-build-v1";

/**
 * Recompute the driver BUILD digest over `R97_DRIVER_ARTIFACTS`.
 *
 * Plan §R100 怎么做: "除 driverVersion 标签外记录 driver构建/源hash；版本字符串不变
 * 而执行代码变化，应使旧计划失效." A version LABEL is a human convention and does
 * not move when the code changes, so the approved digest was blind to a driver
 * rewrite. This digest is derived from the artifact BYTES.
 *
 * Fail-closed: a listed artifact that cannot be read is an ERROR, never skipped.
 * Skipping would silently shrink the covered set, which is exactly the property
 * the digest exists to guarantee.
 *
 * The digest is over `path\0sha256(content)` rows in LIST ORDER, so reordering
 * the list (a contract change, not a content change) also moves the digest.
 */
export async function computeDriverBuildDigestV1(repoRoot: string): Promise<string> {
  const rows: string[] = [];
  for (const rel of R97_DRIVER_ARTIFACTS) {
    let content: Buffer;
    try {
      content = await readFile(join(repoRoot, rel));
    } catch (err) {
      throw new Error(
        `E4-R97: driver build digest cannot cover ${rel}: ${err instanceof Error ? err.message : String(err)} — the covered artifact set must never shrink silently`,
      );
    }
    const sha = createHash("sha256").update(content).digest("hex");
    rows.push(`${rel}\u0000${sha}`);
  }
  return createHash("sha256")
    .update(`${R97_DRIVER_BUILD_SCHEMA}\n${rows.join("\n")}`)
    .digest("hex");
}

/** Plan status. Only FINALIZED may be presented for a human decision. */
export type R97PlanStatus = "DRAFT" | "FINALIZED_AUTHORIZATION_PLAN" | "NOT_READY";

/**
 * ONE arm's observation, produced by running the REAL CLI `--dry-run` inside
 * that arm's own checkout.
 *
 * Every field here is something the CLI PRINTED. Nothing is inferred from the
 * other arm, and nothing is copied from an authorization envelope — that is the
 * whole point of the type.
 */
export interface R97ArmObservation {
  arm: "baseline" | "candidate";
  /** The directory the dry-run ran in. Recorded so the observation is auditable. */
  checkoutDir: string;
  /** `sourceSha` as the CLI reported it (git HEAD of that checkout). */
  sourceSha: string;
  /**
   * `treeFingerprint` as the CLI reported it. `null` is the CLI's own honest
   * value for a PROVABLY CLEAN tree (see `probeSourceSnapshot`), so it is a
   * legitimate observation — but the caller must know which it is.
   */
  treeFingerprint: string | null;
  /** Whether that checkout was clean per the CLI's own probe. */
  clean: boolean;
  /** The CLI's `planDigest` — the REAL execution-plan digest for this arm. */
  planDigest: string;
  providerId: string;
  modelId: string;
  endpointIdentity: string | null;
  /**
   * The case ids the CLI actually planned. MEASURED: the real CLI prints BARE
   * directory names (`reg-16-cicd-step`), NOT the suite-prefixed ids the R87
   * selection uses (`regression/reg-16-cicd-step`). Both are recorded so the
   * mapping between them is explicit rather than assumed.
   */
  cliCaseIds: string[];
  /** The suite-prefixed frozen ids this observation covers, in the selection's
   *  order. Derived by mapping `cliCaseIds` onto the frozen selection. */
  caseIds: string[];
  /** Per-case input fingerprints, computed from the case files IN THIS ARM'S
   *  CHECKOUT. The CLI does not print fingerprints, so they are read from the
   *  arm's own source — an independent observation of the same build. */
  caseFingerprints: Record<string, string>;
  /** The CLI's effective model params, as bound into its digest. */
  effectiveModelParams: Record<string, unknown>;
  /** Total logical runs the CLI planned. */
  totalLogicalRuns: number;
  /** The suite the CLI planned under. */
  suite: string;
}

/**
 * Map the CLI's BARE case ids onto the frozen selection's suite-prefixed ids.
 *
 * The mapping is by last path segment, which is only sound when no two frozen
 * cases share a bare name — otherwise `regression/x` and `stress/x` are
 * indistinguishable in the CLI's output. That ambiguity is checked, not assumed:
 * an ambiguous selection is refused rather than silently mis-mapped.
 */
export function mapCliCaseIdsToSelection(
  cliCaseIds: readonly string[],
  selectionCaseIds: readonly string[],
): { caseIds: string[] | null; issue: string | null } {
  const bareOf = (id: string): string => id.split("/").pop() ?? id;
  const byBare = new Map<string, string[]>();
  for (const id of selectionCaseIds) {
    const b = bareOf(id);
    byBare.set(b, [...(byBare.get(b) ?? []), id]);
  }
  const ambiguous = [...byBare.entries()].filter(([, ids]) => ids.length > 1).map(([b]) => b);
  if (ambiguous.length > 0) {
    return {
      caseIds: null,
      issue: `the frozen selection has ambiguous bare case names (${ambiguous.join(", ")}) — the CLI prints bare names, so these cases cannot be distinguished`,
    };
  }
  const mapped: string[] = [];
  for (const cli of cliCaseIds) {
    const hit = byBare.get(cli);
    if (hit === undefined) return { caseIds: null, issue: `the CLI planned an unknown case "${cli}"` };
    mapped.push(hit[0]!);
  }
  return { caseIds: mapped, issue: null };
}

/** Parse ONE arm's CLI `--dry-run` JSON into an observation. Fails closed.
 *
 *  `caseFingerprints` is supplied by the CALLER, read from the case files in
 *  that arm's own checkout: MEASURED, the real CLI dry-run does NOT print a
 *  `caseFingerprints` object, so requiring one would reject every real
 *  observation. The fingerprints still come from an independent read of the
 *  arm's build rather than from the envelope — which is what plan §R97 line 212
 *  requires. */
export function parseR97ArmObservation(
  arm: "baseline" | "candidate",
  checkoutDir: string,
  raw: unknown,
  caseFingerprints: Record<string, string> = {},
): { observation: R97ArmObservation | null; issues: string[] } {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { observation: null, issues: [`arm ${arm}: the dry-run output is not a JSON object`] };
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== "string" || v === "") {
      issues.push(`arm ${arm}: dry-run field ${k} must be a non-empty string`);
      return "";
    }
    return v;
  };
  if (o["mode"] !== "dry-run") issues.push(`arm ${arm}: dry-run output declares mode ${String(o["mode"])}, not "dry-run"`);
  if (o["providerCalls"] !== 0) {
    // A dry-run that reports any provider call is not a dry-run.
    issues.push(`arm ${arm}: dry-run output reports providerCalls=${String(o["providerCalls"])}, expected 0`);
  }
  const sourceSha = str("sourceSha");
  const planDigest = str("planDigest");
  const providerId = str("providerId");
  const modelId = str("modelId");
  const cliCaseIds = Array.isArray(o["caseIds"]) ? (o["caseIds"] as unknown[]).filter((c): c is string => typeof c === "string") : [];
  if (cliCaseIds.length === 0) issues.push(`arm ${arm}: dry-run output carries no caseIds`);
  const tree = o["treeFingerprint"];
  const treeFingerprint = typeof tree === "string" && tree !== "" ? tree : null;
  const suite = typeof o["suite"] === "string" ? o["suite"] : "";
  if (suite === "") issues.push(`arm ${arm}: dry-run output carries no suite`);

  if (issues.length > 0) return { observation: null, issues };

  return {
    observation: {
      arm,
      checkoutDir,
      sourceSha,
      treeFingerprint,
      clean: treeFingerprint === null,
      planDigest,
      providerId,
      modelId,
      endpointIdentity: typeof o["endpointIdentity"] === "string" ? o["endpointIdentity"] : null,
      cliCaseIds,
      caseIds: cliCaseIds,
      caseFingerprints: { ...caseFingerprints },
      effectiveModelParams:
        typeof o["effectiveModelParams"] === "object" && o["effectiveModelParams"] !== null
          ? { ...(o["effectiveModelParams"] as Record<string, unknown>) }
          : {},
      totalLogicalRuns: typeof o["totalLogicalRuns"] === "number" ? o["totalLogicalRuns"] : 0,
      suite,
    },
    issues: [],
  };
}

/** The frozen selection, read from the committed evidence file. */
export interface R97FrozenSelection {
  caseIds: string[];
  digest: string;
  /** Content fingerprint per case, computed from the ACTUAL case files. */
  caseFingerprints: Record<string, string>;
  /**
   * The TRUE suite of every case, in `caseIds` order — E4-R100.
   *
   * Read from the selection's own per-case `suite` field, and re-checked against
   * the case id's prefix. Plan §R100 怎么做 is explicit that a mixed-suite frozen
   * list must not be silently relabelled:
   *
   *   "mixed-suite 用显式 case inventory 保留真实 suite，不能悄悄将 stress 全重标
   *    regression 再宣称完全相同实验."
   *
   * The CLI's `--suite` is SINGLE-VALUED, so the driver must pass ONE label for a
   * list that spans two suites. That adaptation is legitimate; claiming the
   * stress cases were regression cases is not. The true suite is therefore
   * recorded per case rather than inferred from the single CLI label.
   */
  caseSuites: Record<string, string>;
}

/** Recursively sort object keys → compact JSON → sha256 hex.
 *
 *  Algorithmically identical to `canonicalDigest` in `@ar/core`'s
 *  `r87-zero-call-replay-ab.ts`, and deliberately re-implemented locally (see
 *  the module header): the whole point of recomputing the frozen selection's
 *  digest is that the agreement between this module and the committed R87
 *  evidence file is a CHECKED property rather than an assumption about another
 *  package's internals. */
export function canonicalDigestV1(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeysV1(value))).digest("hex");
}

function sortKeysV1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysV1);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysV1((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** The closed set of selection-refusal codes, so a caller can assert on them. */
export const R97_SELECTION_CODES = [
  "SELECTION_UNREADABLE",
  "SELECTION_SCHEMA_MISMATCH",
  "SELECTION_PAYLOAD_INVALID",
  "SELECTION_DIGEST_MISMATCH",
  "SELECTION_SUITE_MISMATCH",
  "SELECTION_CASE_UNREADABLE",
] as const;

export type R97SelectionCode = (typeof R97_SELECTION_CODES)[number];

/** Refusal raised by `loadR97FrozenSelection`. It CARRIES its code so a caller
 *  (or a test) can assert WHICH invariant failed, rather than matching prose. */
export class R97SelectionRefusal extends Error {
  readonly code: R97SelectionCode;
  constructor(code: R97SelectionCode, detail: string) {
    super(`E4-R87/R100 selection refused (${code}): ${detail}`);
    this.name = "R97SelectionRefusal";
    this.code = code;
  }
}

/** The selection schema this module can verify. An unknown schema means the
 *  digest algorithm is not known to apply, so it is refused rather than
 *  "verified" against a payload this code does not understand. */
export const R97_SELECTION_SCHEMA = "e4-r87-case-selection-v1";

/**
 * Load and VERIFY the frozen selection.
 *
 * Plan §R100 怎么做: "验证冻结selection内容与digest，不能只读取 parsed.digest 当真."
 * (Verify the frozen selection's CONTENT against its digest; do not simply read
 * `parsed.digest` and take it as truth.)
 *
 * Before R100 this function read `parsed.digest` and carried it into the
 * envelope as `selectionDigest` without ever recomputing it, so editing the case
 * list and LEAVING the old digest produced a plan that claimed a frozen list it
 * no longer had — the digest was a comment, not a binding.
 *
 * The verification mirrors `verifySelectionDigest` in
 * `packages/core/src/runtime/r87-zero-call-replay-ab.ts`: the canonical digest is
 * recomputed over the payload with the `digest` field EXCLUDED and compared with
 * the committed value. A mismatch is a hard refusal, never a warning.
 *
 * Note the deliberate non-check for the case FILES: an unreadable case file is
 * also refused, because "the selection names a case that is not in the build"
 * would otherwise be silently compared as `undefined === undefined`.
 */
export async function loadR97FrozenSelection(repoRoot: string): Promise<R97FrozenSelection> {
  const path = join(repoRoot, R97_SELECTION_PATH);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new R97SelectionRefusal(
      "SELECTION_UNREADABLE",
      `cannot read ${R97_SELECTION_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new R97SelectionRefusal(
      "SELECTION_UNREADABLE",
      `${R97_SELECTION_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new R97SelectionRefusal("SELECTION_UNREADABLE", `${R97_SELECTION_PATH} must be a JSON object`);
  }
  const record = doc as Record<string, unknown>;

  // (1) The schema decides WHICH digest algorithm applies, so an unknown schema
  //     cannot be "verified" — it can only be refused.
  if (record["schemaVersion"] !== R97_SELECTION_SCHEMA) {
    throw new R97SelectionRefusal(
      "SELECTION_SCHEMA_MISMATCH",
      `selection schemaVersion is ${String(record["schemaVersion"])}, expected ${R97_SELECTION_SCHEMA}`,
    );
  }

  // (2) Recompute the canonical digest over the payload with `digest` excluded.
  const { digest: declaredDigest, ...payload } = record;
  if (typeof declaredDigest !== "string" || declaredDigest === "") {
    throw new R97SelectionRefusal("SELECTION_PAYLOAD_INVALID", "selection carries no `digest` field");
  }
  const recomputed = canonicalDigestV1(payload);
  if (recomputed !== declaredDigest) {
    throw new R97SelectionRefusal(
      "SELECTION_DIGEST_MISMATCH",
      `recomputed selection digest ${recomputed} != the committed digest ${declaredDigest} — the frozen case list was modified after it was bound`,
    );
  }

  // (3) The payload must be structurally what the recomputation assumed it was.
  const cases = record["cases"];
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new R97SelectionRefusal("SELECTION_PAYLOAD_INVALID", "selection `cases` must be a non-empty array");
  }

  const caseIds: string[] = [];
  const caseSuites: Record<string, string> = {};
  for (const entry of cases) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new R97SelectionRefusal("SELECTION_PAYLOAD_INVALID", "every selection case must be an object");
    }
    const c = entry as Record<string, unknown>;
    const id = c["id"];
    if (typeof id !== "string" || id === "") {
      throw new R97SelectionRefusal("SELECTION_PAYLOAD_INVALID", "every selection case must carry a non-empty string `id`");
    }
    if (caseIds.includes(id)) {
      throw new R97SelectionRefusal("SELECTION_PAYLOAD_INVALID", `selection lists case ${id} more than once`);
    }
    const suite = c["suite"];
    if (typeof suite !== "string" || suite === "") {
      throw new R97SelectionRefusal("SELECTION_PAYLOAD_INVALID", `selection case ${id} carries no \`suite\``);
    }
    // The declared suite must agree with the id's own prefix. The frozen file
    // states both, so a disagreement is a genuine ambiguity about which suite a
    // case belongs to — and getting that wrong is exactly the "stress silently
    // relabelled regression" failure plan §R100 forbids.
    const prefix = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
    if (prefix !== suite) {
      throw new R97SelectionRefusal(
        "SELECTION_SUITE_MISMATCH",
        `selection case ${id} declares suite "${suite}" but its id prefix is "${prefix}" — the true suite of a mixed-suite frozen list must be unambiguous`,
      );
    }
    caseIds.push(id);
    caseSuites[id] = suite;
  }

  const caseFingerprints: Record<string, string> = {};
  for (const id of caseIds) {
    let c;
    try {
      c = await loadBenchmarkCase(join(repoRoot, "benchmarks", id));
    } catch (err) {
      throw new R97SelectionRefusal(
        "SELECTION_CASE_UNREADABLE",
        `the frozen selection names case ${id} but its files could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    caseFingerprints[id] = caseInputFingerprintV1({
      requestMd: c.requestMd,
      expectedMd: c.expectedMd,
      fixture: c.fixture,
      verification: c.verification ?? null,
      requires: c.requires ?? null,
      schemaMode: c.schemaMode ?? null,
    });
  }

  return { caseIds, digest: declaredDigest, caseFingerprints, caseSuites };
}

export interface R97CapIntentInput {
  caseCount: number;
  campaignModelCalls: number;
  perCaseToolCalls: number;
  perCaseDurationMs: number;
  repetitions: number;
  armCount: number;
}

export function r97CapIntent(input: R97CapIntentInput): R92CapIntent {
  return {
    campaignModelCalls: input.campaignModelCalls,
    perCaseToolCalls: input.perCaseToolCalls,
    perCaseDurationMs: input.perCaseDurationMs,
    maxLogicalRuns: input.caseCount * input.repetitions * input.armCount,
    // Declared null: no layer can execute a token or USD hard cap, so declaring
    // one would be a textual claim. The unknowns are named instead.
    maxEstimatedTokens: null,
    maxEstimatedCostUsd: null,
    caseCount: input.caseCount,
    repetitions: input.repetitions,
    armCount: input.armCount,
    invocationMode: "single-invocation-over-frozen-list",
  };
}

/** One reason a plan cannot be finalized. */
export interface R97ReadinessIssue {
  code: string;
  detail: string;
}

/**
 * The readiness computation. Readiness is a property of the OBSERVATIONS, and it
 * is computed BEFORE any authorization is consulted — the R95 lesson applied to
 * the finalization step.
 */
export function r97ReadinessIssues(input: {
  selection: R97FrozenSelection;
  baseline: R97ArmObservation | null;
  candidate: R97ArmObservation | null;
  caps: ReturnType<typeof classifyR92Caps>;
  authorizationForCaps: R92AuthorizationV1;
  expectedProviderId: string;
  expectedModelId: string;
  expectedEndpointIdentity: string | null;
}): R97ReadinessIssue[] {
  const issues: R97ReadinessIssue[] = [];
  const { baseline, candidate, selection } = input;

  // (1) BOTH arms must have been OBSERVED. A draft has none.
  if (baseline === null) issues.push({ code: "ARM_NOT_OBSERVED", detail: 'arm "baseline" was never observed by a real CLI dry-run' });
  if (candidate === null) issues.push({ code: "ARM_NOT_OBSERVED", detail: 'arm "candidate" was never observed by a real CLI dry-run' });

  for (const obs of [baseline, candidate]) {
    if (obs === null) continue;
    // (2) The arm's real execution-plan digest must exist and be a real digest.
    if (!/^[0-9a-f]{64}$/.test(obs.planDigest)) {
      issues.push({ code: "ARM_PLAN_DIGEST_INVALID", detail: `arm "${obs.arm}" dry-run planDigest is not a 64-hex digest: ${obs.planDigest}` });
    }
    if (!/^[0-9a-f]{40}$/.test(obs.sourceSha)) {
      issues.push({ code: "ARM_SOURCE_SHA_INVALID", detail: `arm "${obs.arm}" sourceSha is not a 40-hex commit: ${obs.sourceSha}` });
    }
    // (3) The arm must have been a CLEAN checkout. A dirty arm means the build
    //     the digest describes is not the build that would run.
    if (!obs.clean) {
      issues.push({
        code: "ARM_CHECKOUT_DIRTY",
        detail: `arm "${obs.arm}" was observed with a non-clean tree (treeFingerprint ${String(obs.treeFingerprint)}) — a finalized plan must bind a reproducible build`,
      });
    }
    // (4) Identity must agree with the declared provider/model/endpoint.
    if (obs.providerId !== input.expectedProviderId || obs.modelId !== input.expectedModelId) {
      issues.push({
        code: "ARM_IDENTITY_MISMATCH",
        detail: `arm "${obs.arm}" observed ${obs.providerId}/${obs.modelId} but the plan declares ${input.expectedProviderId}/${input.expectedModelId}`,
      });
    }
    if (obs.endpointIdentity !== input.expectedEndpointIdentity) {
      issues.push({
        code: "ARM_ENDPOINT_MISMATCH",
        detail: `arm "${obs.arm}" observed endpoint ${String(obs.endpointIdentity)} but the plan declares ${String(input.expectedEndpointIdentity)}`,
      });
    }
    // (5) The arm must have planned EXACTLY the frozen case SET.
    //
    // MEASURED, and the reason this is a set comparison plus a separate
    // cross-arm order check: `loadBenchmarkCases` SORTS its directory entries
    // (`baseline.ts`: `.sort()`), so the CLI's `caseIds` are always in
    // alphabetical order and can never equal the R87 selection file's array
    // order (which is TARGET-first, then counterexamples). Demanding array
    // equality would reject every real observation.
    //
    // What the frozen selection actually requires (its own `armRule`) is that
    // "both arms run the same runner with ... the same case order". So the
    // contract is enforced as: the SET matches the selection exactly, AND both
    // arms observed the SAME order as each other. Both are checked below; the
    // cross-arm order check lives in section (7).
    if (obs.caseIds.length !== selection.caseIds.length) {
      issues.push({
        code: "CASE_SET_DRIFT",
        detail: `arm "${obs.arm}" planned ${obs.caseIds.length} case(s) but the frozen selection has ${selection.caseIds.length}`,
      });
    } else {
      const want = new Set(selection.caseIds);
      const missing = selection.caseIds.filter((id) => !obs.caseIds.includes(id));
      const extra = obs.caseIds.filter((id) => !want.has(id));
      if (missing.length > 0 || extra.length > 0) {
        issues.push({
          code: "CASE_SET_DRIFT",
          detail: `arm "${obs.arm}" planned a different case set than the frozen selection (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
        });
      }
    }
    // (6) The CLI's OWN fingerprints must match the fingerprints of the case
    //     files on disk. This is the anti-copy check: the plan cannot assert a
    //     fingerprint the executing checkout does not actually have.
    for (const id of selection.caseIds) {
      const observed = obs.caseFingerprints[id];
      if (observed === undefined) {
        issues.push({ code: "CASE_FINGERPRINT_MISSING", detail: `arm "${obs.arm}" did not fingerprint case ${id}` });
      } else if (observed !== selection.caseFingerprints[id]) {
        issues.push({
          code: "CASE_CONTENT_DRIFT",
          detail: `arm "${obs.arm}" case ${id} fingerprint ${observed} does not match the case source on disk (${String(selection.caseFingerprints[id])})`,
        });
      }
    }
  }

  // (7) The two arms must be TWO builds, not one build recorded twice.
  if (baseline !== null && candidate !== null) {
    if (baseline.sourceSha === candidate.sourceSha) {
      issues.push({
        code: "ARMS_NOT_DISTINCT",
        detail: `both arms observed sourceSha ${baseline.sourceSha} — a same-build switch must never be recorded as two historical checkouts`,
      });
    }
    if (baseline.planDigest === candidate.planDigest) {
      issues.push({
        code: "ARMS_NOT_DISTINCT",
        detail: "both arms produced the SAME execution-plan digest — one arm's plan is standing in for the other's",
      });
    }
    // The frozen selection's `armRule` requires "the same case order" in both
    // arms. The CLI sorts alphabetically, so this is an ORDER check between the
    // arms rather than against the selection file's array order.
    if (baseline.caseIds.length === candidate.caseIds.length) {
      const differs = baseline.caseIds.some((id, i) => id !== candidate.caseIds[i]);
      if (differs) {
        issues.push({
          code: "ARM_ORDER_MISMATCH",
          detail: "the two arms planned the frozen cases in DIFFERENT orders — the frozen selection requires the same order in both arms",
        });
      }
    }
  }

  // (8) Caps must be genuinely enforceable, using the SAME contract the R95 gate
  //     applies. A plan carrying an unenforceable cap is NOT_READY, not DRAFT.
  const declarationIssues = r92CapDeclarationIssues(input.caps, input.authorizationForCaps);
  for (const i of declarationIssues) issues.push({ code: "CAP_DECLARATION_INVALID", detail: i });
  for (const i of r92CapViolations(input.caps)) issues.push({ code: "CAP_NOT_ENFORCEABLE", detail: i });

  // (9) The plan must bind the EXECUTOR. The shared R92 schema keeps
  //     `driverVersion` optional so the R92 plan (whose driver did not exist yet)
  //     stays representable, so the requirement is enforced HERE, at the step
  //     that decides whether a plan may finalize. A plan that names no executor
  //     cannot be checked against the code that would run, and the driver refuses
  //     such a plan — so it must never reach FINALIZED_AUTHORIZATION_PLAN.
  const boundDriver = input.authorizationForCaps.driverVersion;
  if (typeof boundDriver !== "string" || boundDriver.trim().length === 0) {
    issues.push({
      code: "DRIVER_VERSION_UNBOUND",
      detail:
        "the authorization binds no driverVersion — a finalized plan must name the executor it authorizes, or the approval does not cover the code that would run",
    });
  }

  // (10) The plan must bind the executor's BUILD, not merely its version label.
  //      Plan §R100 怎么做: "除 driverVersion 标签外记录 driver构建/源hash；版本字符串
  //      不变而执行代码变化，应使旧计划失效." An envelope without it can never be
  //      checked against the code that would run, so it must not finalize.
  const boundDriverBuild = (input.authorizationForCaps as R97AuthorizationV1).driverBuildDigest;
  if (typeof boundDriverBuild !== "string" || !/^[0-9a-f]{64}$/.test(boundDriverBuild)) {
    issues.push({
      code: "DRIVER_BUILD_UNBOUND",
      detail: `the authorization binds no driver build digest (got ${String(boundDriverBuild)}) — a version label cannot detect a code change, so the approval would not cover the executor's bytes`,
    });
  }

  // (11) The honest mixed-suite inventory must be present and must agree with the
  //      frozen selection. Plan §R100 怎么做: "mixed-suite 用显式 case inventory 保留
  //      真实 suite，不能悄悄将 stress 全重标 regression 再宣称完全相同实验." A plan
  //      that omits it would let a report describe a two-suite campaign as a
  //      uniform regression experiment.
  const boundInventory = (input.authorizationForCaps as R97AuthorizationV1).caseInventory;
  if (!Array.isArray(boundInventory) || boundInventory.length === 0) {
    issues.push({
      code: "CASE_INVENTORY_UNBOUND",
      detail: "the authorization carries no case inventory — the frozen selection is mixed-suite, so each case's TRUE suite must be recorded rather than inferred from the single-valued CLI `--suite`",
    });
  } else {
    for (const caseId of input.authorizationForCaps.caseIds) {
      const entry = boundInventory.find((e) => e.caseId === caseId);
      if (entry === undefined) {
        issues.push({ code: "CASE_INVENTORY_DRIFT", detail: `the case inventory records no entry for approved case ${caseId}` });
        continue;
      }
      const want = selection.caseSuites[caseId];
      if (want !== undefined && entry.suite !== want) {
        issues.push({
          code: "CASE_INVENTORY_DRIFT",
          detail: `the case inventory labels ${caseId} as suite "${entry.suite}" but the frozen selection says "${want}" — a mixed-suite list must not be silently relabelled`,
        });
      }
    }
  }

  return issues;
}

export interface R97PlanBuildOptions {
  repoRoot: string;
  /** The two arms' REAL observations. `null` = not observed (a draft). */
  baseline: R97ArmObservation | null;
  candidate: R97ArmObservation | null;
  providerId: string;
  modelId: string;
  endpointIdentity: string | null;
  outputDir: string;
  /** Authorization lifetime in days from `createdAt`. */
  validityDays?: number;
  /** The trusted clock reading. Never copied from the plan. */
  now: string;
  /** Pinned `createdAt`, so the digest is reproducible for a fixed clock. */
  createdAt: string;
  campaignModelCalls: number;
  perCaseToolCalls?: number;
  perCaseDurationMs?: number;
}

export interface R97PlanResult {
  status: R97PlanStatus;
  schemaVersion: string;
  /** `null` for a draft: a draft has no authorization envelope to approve. */
  authorization: R97AuthorizationV1 | null;
  planDigest: string | null;
  /** Facts the executor's gate compares against, derived from OBSERVATIONS. */
  gateFacts: R92GateFacts;
  /**
   * THE PLAN-TIME OBSERVATION SNAPSHOT — E4-R100 / plan §0.1 F5.
   *
   * Plan §R100 做什么 #1: "分开计划期观测快照和执行期新观测；快照可用于审阅，不能充当
   * 当前事实." This field IS the plan-time snapshot. It is EVIDENCE OF WHAT WAS
   * OBSERVED WHEN THE PLAN WAS BUILT — it is **NOT** a claim about the world at
   * execution time, and it MUST NOT be compared against the authorization to
   * decide whether to run.
   *
   * Before R100 the driver did exactly that: it fed this block into the R92 gate
   * (`gateFactsFrom(plan.observation)`), so a plan authorized a build, endpoint
   * or case content that might no longer exist. The execution-time comparison is
   * now `checkExecutionObservationV1`, which takes a FRESHLY observed fact set
   * and refuses every drift with a named code.
   *
   * It remains on the artifact because:
   *   - `plan §R97 line 213` ("正式材料必须无需修改就能执行") requires the delivered
   *     artifact to be runnable as-is, and the driver reads `plan.observation`
   *     for the fake/offline path and for `now`;
   *   - a reviewer needs to see WHAT the approval was based on.
   *
   * It is deliberately OUTSIDE the authorization envelope and therefore NOT part
   * of `planDigest`: it is the INDEPENDENT side of the comparison. Putting it
   * inside the digest would make the check circular.
   *
   * `null` for a DRAFT (nothing was observed to record).
   */
  planObservation: R97PlanObservation | null;
  /**
   * BACK-COMPAT ALIAS of `planObservation`.
   *
   * `scripts/e4/r97-campaign-driver.mjs` reads `plan.observation` (and the
   * delivered `plan.json` artifacts on disk carry that key), so the old name
   * must keep working. The two properties are always the SAME object, which is
   * asserted by the test suite: a divergence between the review snapshot and the
   * driver's field would be precisely the "two sources of truth" defect F5
   * describes.
   */
  observation: R97PlanObservation | null;
  readinessIssues: R97ReadinessIssue[];
  /** True ONLY for a FINALIZED plan with zero readiness issues. */
  authorizable: boolean;
  approvalMarkdown: string;
  realScores: false;
  passRateClaim: false;
  /** The driver that would execute this plan. Bound so the plan names its code. */
  driverVersion: string;
  /**
   * The executor's BUILD digest (`R97_DRIVER_ARTIFACTS`), surfaced beside
   * `driverVersion` so a caller can compare it WITHOUT trusting the envelope it
   * is checking. `null` for a plan that did not finalize.
   */
  driverBuildDigest: string | null;
  /** The honest per-case suite inventory, surfaced for reporters. */
  caseInventory: R97CaseInventoryEntry[];
}

/**
 * The PLAN-TIME observation block, carried in the artifact a human reviews.
 *
 * Plan §R100 做什么 #1: "分开计划期观测快照和执行期新观测；快照可用于审阅，不能充当
 * 当前事实."
 *
 * READ THIS AS HISTORY, NOT AS CURRENT FACT. Every value below is evidence of
 * what was observed WHEN THE PLAN WAS BUILT. It is kept so a reviewer can see
 * what the approval was based on, and so the artifact is self-describing. It is
 * NOT a claim about the world at execution time, and nothing may compare the
 * authorization against it to decide whether to run: that comparison is
 * `checkExecutionObservationV1`'s job, against FRESHLY observed facts.
 *
 * Mirrors `gateFactsFrom(observation)` in `scripts/e4/r97-campaign-driver.mjs`,
 * which is the consumer; both sides must agree on this shape or the artifact is
 * not executable as written.
 */
export interface R97PlanObservation {
  now: string;
  executingSourceSha: string;
  armShas: { baseline: string; candidate: string };
  armDigests: { baseline: string; candidate: string };
  caseFingerprints: Record<string, string>;
  providerId: string;
  modelId: string;
  endpointIdentity: string | null;
}

/**
 * ONE case's entry in the envelope's case inventory — E4-R100.
 *
 * Plan §R100 怎么做: "mixed-suite 用显式 case inventory 保留真实 suite，不能悄悄将
 * stress 全重标 regression 再宣称完全相同实验."
 *
 * The frozen R87 selection spans TWO suites (6 `regression/*` + 2 `stress/*`)
 * while the CLI's `--suite` flag is SINGLE-VALUED (`agent benchmark: --suite must
 * be one of regression|holdout|adversarial|stress`). No single invocation can
 * plan the frozen list under two labels, so the driver must stage the whole list
 * into one `--cases` root and pass one suite label.
 *
 * That adaptation is legitimate and this module does not remove it. What it does
 * is make the ADAPTATION RECORDED AND DIGEST-COVERED: the envelope carries each
 * case's TRUE suite, so no report derived from this plan can claim the two
 * `stress/*` cases were regression cases, and editing the inventory to relabel
 * them moves `planDigest` and invalidates the approval.
 */
export interface R97CaseInventoryEntry {
  caseId: string;
  /** The TRUE suite, from the frozen selection — never the CLI's single label. */
  suite: string;
  /** The suite label the CLI actually planned the case under, when it differs
   *  from `suite` (the single-valued `--suite` adaptation). */
  plannedUnderSuite: string;
  /** True when `suite !== plannedUnderSuite`, i.e. this case is a known
   *  adaptation of the single-valued `--suite` flag. */
  relabelled: boolean;
}

/**
 * The R97 envelope: the shared R92 authorization PLUS the two bindings R100 adds.
 *
 * Both new fields ARE envelope fields, so `computeR92AuthorizationDigestV1`
 * (which hashes every own key of the object) covers them: editing the driver
 * build digest or relabelling a case in `caseInventory` moves `planDigest` and
 * invalidates the approval. That is the entire point of putting them here rather
 * than beside the plan.
 *
 * They are declared as an EXTENSION of `R92AuthorizationV1` rather than by
 * editing `r92-authorization.ts`, because the R92 envelope's field set is
 * deliberately CLOSED (`parseR92AuthorizationV1` refuses an unknown top-level
 * field, and `r95-authorization-strictness.test.ts` asserts that). Widening the
 * shared R92 schema would be a change to a different contract than the one this
 * task owns. `r92AuthorizationIssuesV1` does NOT whitelist fields, so the
 * extension validates cleanly through the existing readiness path.
 *
 * `driverBuildDigest` is OPTIONAL to keep the field back-compatible with an
 * envelope produced before R100 existed; `checkExecutionObservationV1` refuses
 * a missing value, so "absent" can never be read as "matches".
 */
export interface R97AuthorizationV1 extends R92AuthorizationV1 {
  /**
   * Digest over the explicitly enumerated executor artifacts
   * (`R97_DRIVER_ARTIFACTS`). Plan §R100 怎么做: "除 driverVersion 标签外记录 driver
   * 构建/源hash；版本字符串不变而执行代码变化，应使旧计划失效."
   */
  driverBuildDigest?: string;
  /**
   * The TRUE suite of every approved case — plan §R100 怎么做's "mixed-suite 用显式
   * case inventory 保留真实 suite". Digest-covered, so the honest record cannot be
   * edited after approval.
   */
  caseInventory?: R97CaseInventoryEntry[];
}

/**
 * The closed set of EXECUTION-TIME refusal codes — E4-R100.
 *
 * Kept as a runtime ARRAY (not only a type) so the set is CLOSED and a caller can
 * assert on it, and derived-by-type so the list and the type cannot drift apart.
 * Each code names ONE way the freshly observed world can disagree with the
 * approved envelope, which is what makes a refusal machine-checkable rather than
 * a prose match.
 */
export const R97_EXECUTION_CODES = [
  /** No approved envelope at all — nothing was authorized, so nothing may run. */
  "EXEC_OBS_NOT_AUTHORIZED",
  /** A plan that is not FINALIZED/authorizable is refused before observation. */
  "EXEC_OBS_PLAN_NOT_FINALIZED",
  /** The freshly expanded envelope digest != the approved `planDigest`. */
  "EXEC_OBS_PLAN_DIGEST_MISMATCH",
  /** An arm's git HEAD moved since the plan was built. */
  "EXEC_OBS_ARM_SHA_DRIFT",
  /** An arm's real CLI dry-run execution-plan digest changed. */
  "EXEC_OBS_ARM_PLAN_DIGEST_DRIFT",
  /** A case's input fingerprint changed. The offending case id is named. */
  "EXEC_OBS_CASE_DRIFT",
  /** A case in the approved list was not observed at all at execution time. */
  "EXEC_OBS_CASE_MISSING",
  /** A case was observed that the approval does not cover. */
  "EXEC_OBS_CASE_UNEXPECTED",
  /** The observed provider/model/endpoint identity differs from the approved one. */
  "EXEC_OBS_IDENTITY_DRIFT",
  /** The driver CODE changed (driver build digest), even if the version label did not. */
  "EXEC_OBS_DRIVER_BUILD_DRIFT",
  /** The plan's validity window has passed. */
  "EXEC_OBS_EXPIRED",
  /** The plan's validity window has not started. */
  "EXEC_OBS_NOT_YET_VALID",
  /** The execution clock is unreadable, so expiry cannot be decided. Fail closed. */
  "EXEC_OBS_TIME_INVALID",
  /** The per-case suite inventory disagrees with the frozen selection. */
  "EXEC_OBS_SUITE_INVENTORY_DRIFT",
] as const;

export type R97ExecutionCode = (typeof R97_EXECUTION_CODES)[number];

/**
 * What was observed at EXECUTION time, re-derived from the live world.
 *
 * Every field is supplied by the CALLER from a FRESH observation — a re-run CLI
 * dry-run in the arm's checkout, a re-read of the case files actually being
 * planned, a re-read of the driver's own bytes. Nothing here may be copied from
 * `R97PlanObservation`; a type that could be filled from the plan snapshot is
 * how "the snapshot is presented as current fact" happens by accident.
 */
export interface R97ExecutionObservationV1 {
  /** The trusted execution clock, ISO-8601. Never read from the plan. */
  now: string;
  /** Re-observed git HEAD per arm. `null` = the arm could not be observed. */
  armShas: { baseline: string | null; candidate: string | null };
  /** Re-derived real CLI dry-run execution-plan digest per arm. */
  armDigests: { baseline: string | null; candidate: string | null };
  /** Fingerprints recomputed from the case files the CLI actually planned. */
  caseFingerprints: Record<string, string>;
  /** Re-observed provider identity. */
  providerId: string;
  /** Re-observed model identity. */
  modelId: string;
  /** Re-normalized endpoint identity (`captureEndpointIdentity`). */
  endpointIdentity: string | null;
  /** The build digest of the driver that is about to execute. */
  driverBuildDigest: string;
  /** The plan digest as EXPANDED FROM THE ENVELOPE NOW — not the stored label. */
  expandedPlanDigest: string;
}

export interface R97ExecutionCheckInput {
  /**
   * The approved plan artifact. `authorization`/`planDigest` are what the HUMAN
   * approved; `planObservation` is the plan-time snapshot and is deliberately
   * NOT an input to the comparison.
   */
  plan: Pick<R97PlanResult, "authorization" | "planDigest" | "status" | "authorizable">;
  observed: R97ExecutionObservationV1;
}

export interface R97ExecutionCheckResult {
  ok: boolean;
  /** Named, machine-checkable refusal codes. Empty iff `ok` is true. */
  codes: string[];
  /** Human-readable detail per refusal, each naming the offending FIELD. */
  issues: string[];
}

/**
 * THE EXECUTION-TIME CHECK — E4-R100 / plan §0.1 F5.
 *
 * Plan §R100 做什么 #1: "分开计划期观测快照和执行期新观测；快照可用于审阅，不能充当
 * 当前事实." And §R100 怎么验收: "计划生成后修改实际case、构建文件、模型参数、endpoint、
 * driver字节，而保留旧observation：每项均在首个外部请求前失败." — after the plan is
 * built, change the actual cases / build files / model params / endpoint / driver
 * bytes while KEEPING the old observation: EACH must fail before the first
 * external request.
 *
 * The parameters are deliberately only the approved envelope and a FRESH
 * observation. `plan.planObservation` is NOT accepted, so there is no argument a
 * caller could pass that would make the check compare the envelope against
 * itself — the failure mode F5 names ("fake CLI 从 plan.observation 读取快照") is
 * made UNREPRESENTABLE rather than merely discouraged.
 *
 * Every refusal is isolated: one drifted field produces one code, so a caller
 * can act on (and a test can assert) the exact invariant that broke.
 */
export function checkExecutionObservationV1(input: R97ExecutionCheckInput): R97ExecutionCheckResult {
  const { plan, observed } = input;
  const codes: string[] = [];
  const issues: string[] = [];
  const fail = (code: R97ExecutionCode, detail: string): void => {
    codes.push(code);
    issues.push(detail);
  };

  // (1) There must BE an approved envelope. A DRAFT or NOT_READY plan carries
  //     none, and "no authorization" is not "authorization to do anything".
  const auth = plan.authorization;
  if (auth === null) {
    fail(
      "EXEC_OBS_NOT_AUTHORIZED",
      `the plan carries no authorization envelope (status ${plan.status}) — there is nothing approved to execute against`,
    );
    return { ok: false, codes, issues };
  }
  if (plan.planDigest === null) {
    fail(
      "EXEC_OBS_PLAN_NOT_FINALIZED",
      `the plan has no planDigest (status ${plan.status}) — an unfinalized plan must never be executed`,
    );
    return { ok: false, codes, issues };
  }

  // (2) THE DIGEST OF THE ENVELOPE AS IT IS NOW must equal the APPROVED value.
  //     Plan §R100 怎么做: "执行期 computeAuthorizationDigest(envelope) 必须等于已
  //     批准值及 plan.planDigest；…拒绝只改顶层digest的对象."
  //
  //     Recomputing from the envelope (rather than trusting `plan.planDigest`)
  //     is what refuses an object whose top-level digest was rewritten while the
  //     body stayed different — a top-level-only edit cannot pass, because the
  //     stored label and the expanded body must AGREE with each other AND with
  //     the freshly observed fact.
  const expanded = computeR92AuthorizationDigestV1(auth);
  if (observed.expandedPlanDigest !== plan.planDigest) {
    fail(
      "EXEC_OBS_PLAN_DIGEST_MISMATCH",
      `the freshly expanded envelope digest ${observed.expandedPlanDigest} != the approved planDigest ${plan.planDigest} — the authorization body or its digest label was modified after approval`,
    );
  }
  if (expanded !== plan.planDigest) {
    fail(
      "EXEC_OBS_PLAN_DIGEST_MISMATCH",
      `the envelope's own recomputed digest ${expanded} != the approved planDigest ${plan.planDigest} — the stored label does not describe the stored body`,
    );
  }
  if (observed.expandedPlanDigest !== expanded) {
    fail(
      "EXEC_OBS_PLAN_DIGEST_MISMATCH",
      `the reported expansion ${observed.expandedPlanDigest} != the envelope's recomputed digest ${expanded}`,
    );
  }

  // (3) The validity window, decided from the TRUSTED EXECUTION CLOCK.
  //     §R100 怎么做: "生产时间来自可信时钟" and "恢复时、下一次外部请求之前检查过期/
  //     取消；过期时持久化停止状态，不扩展授权."
  //     An unparseable clock is refused rather than treated as "inside the
  //     window"; that is the fail-closed direction.
  const nowMs = Date.parse(observed.now);
  const createdMs = Date.parse(auth.createdAt);
  const expiresMs = Date.parse(auth.expiresAt);
  if (!Number.isFinite(nowMs)) {
    fail(
      "EXEC_OBS_TIME_INVALID",
      `the execution clock \`now\` is not a parsable timestamp: ${observed.now}`,
    );
  } else if (!Number.isFinite(expiresMs)) {
    fail(
      "EXEC_OBS_TIME_INVALID",
      `the envelope \`expiresAt\` is not a parsable timestamp: ${auth.expiresAt}`,
    );
  } else if (!Number.isFinite(createdMs)) {
    fail(
      "EXEC_OBS_TIME_INVALID",
      `the envelope \`createdAt\` is not a parsable timestamp: ${auth.createdAt}`,
    );
  } else if (nowMs >= expiresMs) {
    fail(
      "EXEC_OBS_EXPIRED",
      `the plan's envelope \`expiresAt\` is ${auth.expiresAt}, which the execution clock ${observed.now} has passed — expiry is never extended by a restart`,
    );
  } else if (nowMs < createdMs) {
    fail(
      "EXEC_OBS_NOT_YET_VALID",
      `the plan's envelope \`createdAt\` is ${auth.createdAt}, which is after the execution clock ${observed.now} — the validity window has not started`,
    );
  }

  // (4) The driver BUILD digest. §R100 怎么做: "除 driverVersion 标签外记录 driver
  //     构建/源hash；版本字符串不变而执行代码变化，应使旧计划失效."
  if (observed.driverBuildDigest !== auth.driverBuildDigest) {
    fail(
      "EXEC_OBS_DRIVER_BUILD_DRIFT",
      `the executing driver build digest ${observed.driverBuildDigest} != the approved driverBuildDigest ${String(auth.driverBuildDigest)} — the driver CODE changed, so the old approval no longer covers the executor`,
    );
  }

  // (5) Each arm's SOURCE SHA, then its EXECUTION-PLAN digest.
  for (const arm of ["baseline", "candidate"] as const) {
    const approvedSha = auth.arms[arm].sha;
    const approvedPlan = auth.arms[arm].executionPlanDigest;
    const observedSha = observed.armShas[arm];
    const observedPlan = observed.armDigests[arm];

    if (observedSha === null) {
      fail(
        "EXEC_OBS_ARM_SHA_DRIFT",
        `arm "${arm}" was not observable at execution time (armShas.${arm} is null) — an unobserved arm is drift, never a skip`,
      );
    } else if (observedSha !== approvedSha) {
      fail(
        "EXEC_OBS_ARM_SHA_DRIFT",
        `arm "${arm}" sourceSha is ${observedSha} but the approval binds ${approvedSha}`,
      );
    }

    if (observedPlan === null) {
      fail(
        "EXEC_OBS_ARM_PLAN_DIGEST_DRIFT",
        `arm "${arm}" produced no execution-plan digest at execution time (armDigests.${arm} is null) — the arm's real dry-run must be re-run`,
      );
    } else if (observedPlan !== approvedPlan) {
      fail(
        "EXEC_OBS_ARM_PLAN_DIGEST_DRIFT",
        `arm "${arm}" executionPlanDigest is ${observedPlan} but the approval binds ${approvedPlan}`,
      );
    }
  }

  // (6) Per-case CONTENT fingerprints, in both directions. The counts are named
  //     separately from the content mismatch so a reordered/edited LIST is
  //     distinguished from edited CONTENT.
  const approvedCases = auth.caseIds;
  const approvedFps = auth.caseFingerprints;
  const observedFps = observed.caseFingerprints;
  for (const caseId of approvedCases) {
    const want = approvedFps[caseId];
    const got = observedFps[caseId];
    if (got === undefined) {
      fail(
        "EXEC_OBS_CASE_MISSING",
        `case ${caseId} is approved but was NOT observed at execution time — a missing case is never silently skipped`,
      );
    } else if (got !== want) {
      fail(
        "EXEC_OBS_CASE_DRIFT",
        `case ${caseId} fingerprint is ${got} but the approval binds ${String(want)} — the case CONTENT changed after approval`,
      );
    }
  }
  const approvedSet = new Set(approvedCases);
  for (const caseId of Object.keys(observedFps)) {
    if (!approvedSet.has(caseId)) {
      fail(
        "EXEC_OBS_CASE_UNEXPECTED",
        `case ${caseId} was observed at execution time but is NOT in the approved case list`,
      );
    }
  }

  // (7) Provider / model / endpoint identity.
  if (observed.providerId !== auth.providerId) {
    fail(
      "EXEC_OBS_IDENTITY_DRIFT",
      `observed providerId ${observed.providerId} != the approved providerId ${auth.providerId}`,
    );
  }
  if (observed.modelId !== auth.modelId) {
    fail(
      "EXEC_OBS_IDENTITY_DRIFT",
      `observed modelId ${observed.modelId} != the approved modelId ${auth.modelId}`,
    );
  }
  if (observed.endpointIdentity !== auth.endpointIdentity) {
    fail(
      "EXEC_OBS_IDENTITY_DRIFT",
      `observed endpointIdentity ${String(observed.endpointIdentity)} != the approved endpointIdentity ${String(auth.endpointIdentity)}`,
    );
  }

  // (8) The suite inventory must agree with the frozen selection, so a report can
  //     never relabel a `stress/*` case as `regression/*` (§R100 怎么做).
  const inventory = auth.caseInventory;
  if (!Array.isArray(inventory)) {
    fail(
      "EXEC_OBS_SUITE_INVENTORY_DRIFT",
      "the envelope carries no caseInventory — a mixed-suite frozen list must record each case's TRUE suite, never infer it from the single-valued CLI `--suite`",
    );
  } else {
    const byId = new Map(inventory.map((e) => [e.caseId, e]));
    for (const caseId of approvedCases) {
      const entry = byId.get(caseId);
      if (entry === undefined) {
        fail(
          "EXEC_OBS_SUITE_INVENTORY_DRIFT",
          `case ${caseId} is approved but appears in NO caseInventory entry — its true suite is unrecorded`,
        );
        continue;
      }
      const prefix = caseId.includes("/") ? caseId.slice(0, caseId.indexOf("/")) : "";
      if (entry.suite !== prefix) {
        fail(
          "EXEC_OBS_SUITE_INVENTORY_DRIFT",
          `case ${caseId} caseInventory declares suite "${entry.suite}" but the case id's own suite is "${prefix}" — the recorded suite must be the TRUE one`,
        );
      }
    }
    for (const entry of inventory) {
      if (!approvedSet.has(entry.caseId)) {
        fail(
          "EXEC_OBS_SUITE_INVENTORY_DRIFT",
          `caseInventory names case ${entry.caseId}, which is NOT in the approved case list`,
        );
      }
    }
  }

  return { ok: codes.length === 0, codes, issues };
}

/**
 * Build the plan. The status is DERIVED, never passed in:
 *
 *   - any readiness issue                -> NOT_READY
 *   - no arm observed at all             -> DRAFT
 *   - every observation complete         -> FINALIZED_AUTHORIZATION_PLAN
 *
 * `gateFacts` is built from the OBSERVATIONS. Plan §R97 line 212 forbids
 * deriving it from the authorization, so the previous implementation's
 * `authorization.arms.baseline.sha` reads are gone: an unobserved arm yields
 * `null` here, which the gate reports as ARM_BUILD_DRIFT rather than as a match.
 */
export async function buildR97AuthorizationPlan(opts: R97PlanBuildOptions): Promise<R97PlanResult> {
  const selection = await loadR97FrozenSelection(opts.repoRoot);
  const caseCount = selection.caseIds.length;
  const repetitions = 1;
  const armCount = 2;

  const intent = r97CapIntent({
    caseCount,
    campaignModelCalls: opts.campaignModelCalls,
    perCaseToolCalls: opts.perCaseToolCalls ?? 100,
    perCaseDurationMs: opts.perCaseDurationMs ?? 600_000,
    repetitions,
    armCount,
  });
  const caps = classifyR92Caps(intent);

  // The envelope is assembled so the CAP CONTRACT can be evaluated against a
  // real authorization. It is NOT returned unless the plan finalizes.
  const createdAt = opts.createdAt;
  const validityDays = opts.validityDays ?? 30;
  const expiresAt = new Date(Date.parse(createdAt) + validityDays * 86_400_000).toISOString();

  // The plan binds the order the ARM actually planned in, not the selection
  // file's array order. `loadBenchmarkCases` sorts alphabetically, so the two
  // genuinely differ; binding the arm's order is what makes the authorized list
  // the list that will run. The selection digest still covers case CHOICE, and
  // the frozen selection's own `armRule` is what requires the two arms to agree
  // on the order (checked in readiness section 7).
  const plannedOrder = opts.candidate?.caseIds ?? opts.baseline?.caseIds ?? selection.caseIds;

  const baselineSha = opts.baseline?.sourceSha ?? "";
  const candidateSha = opts.candidate?.sourceSha ?? "";

  // ---- E4-R100: the honest per-case SUITE INVENTORY -----------------------
  //
  // Plan §R100 怎么做: "mixed-suite 用显式 case inventory 保留真实 suite，不能悄悄将
  // stress 全重标 regression 再宣称完全相同实验."
  //
  // The frozen selection spans `regression` (6) and `stress` (2). The CLI's
  // `--suite` is SINGLE-VALUED, so the driver stages the whole list under ONE
  // label. Without this inventory the envelope would carry only that single
  // label, and the two `stress/*` cases would be indistinguishable from
  // regression cases in every report derived from the plan — i.e. the campaign
  // would be described as a uniform regression experiment that it is not.
  //
  // The TRUE suite therefore comes from the frozen selection and is carried
  // explicitly. `plannedUnderSuite` records the CLI's label honestly, so the
  // adaptation is VISIBLE instead of erased.
  const cliSuite = opts.candidate?.suite ?? opts.baseline?.suite ?? "";
  const caseInventory: R97CaseInventoryEntry[] = plannedOrder.map((caseId) => {
    const trueSuite = selection.caseSuites[caseId] ?? (caseId.includes("/") ? caseId.slice(0, caseId.indexOf("/")) : "");
    const plannedUnderSuite = cliSuite === "" ? trueSuite : cliSuite;
    return {
      caseId,
      suite: trueSuite,
      plannedUnderSuite,
      relabelled: trueSuite !== plannedUnderSuite,
    };
  });

  // ---- E4-R100: the driver BUILD digest, bound BESIDE the version label ----
  // Plan §R100 怎么做: "除 driverVersion 标签外记录 driver构建/源hash." A label a
  // human remembers to bump is not a binding; this digest is derived from the
  // executor's bytes, so a rewritten driver invalidates an old approval even when
  // nobody bumped `R97_DRIVER_VERSION`.
  const driverBuildDigest = await computeDriverBuildDigestV1(opts.repoRoot);

  const envelope: R97AuthorizationV1 = {
    schemaVersion: R92_AUTHORIZATION_SCHEMA,
    authorizationId: "e4-r97-finalized-dev-mechanism-ab-h2",
    createdAt,
    expiresAt,
    scopeStatement:
      `The R87-frozen ${caseCount} non-holdout development-set cases (3 H2 TARGET + 5 COUNTEREXAMPLE), for mechanism verification only: ` +
      "this establishes whether the H2 progress-aware gate changes these specific traces, and is NOT population-representative. " +
      "It supports no pass-rate claim about the harness overall.",
    selectionDigest: selection.digest,
    // The ARM's planned order, which is what will actually execute.
    caseIds: [...plannedOrder],
    // The fingerprints are the ones the ARM OBSERVED, not a plan-time guess.
    caseFingerprints: { ...(opts.candidate?.caseFingerprints ?? selection.caseFingerprints) },
    arms: {
      // Each arm's digest is the arm's REAL dry-run digest. `null` is impossible
      // here because a null-observed arm never finalizes; a DRAFT carries no
      // envelope at all, so no placeholder digest can ever be approved.
      baseline: { sha: baselineSha, executionPlanDigest: opts.baseline?.planDigest ?? "", buildMode: "isolated-checkout" },
      candidate: { sha: candidateSha, executionPlanDigest: opts.candidate?.planDigest ?? "", buildMode: "isolated-checkout" },
    },
    armIdentityMode: "isolated-checkout-build",
    fixScope: "single-fix-H2",
    fixScopeStatement:
      "Single-fix scope: the candidate revision differs from the baseline by the R86 H2 fix and nothing else functional. " +
      "The candidate must NOT be described as carrying later shim fixes, and no benefit may be attributed to H2 that the " +
      "two revisions do not isolate.",
    jointAttributionNote: null,
    invocationMode: "single-invocation-over-frozen-list",
    providerId: opts.providerId,
    modelId: opts.modelId,
    endpointIdentity: opts.endpointIdentity,
    effectiveModelParams: { ...(opts.candidate?.effectiveModelParams ?? {}) },
    repetitions,
    serialism: 1,
    caps,
    unknownCostItems: [
      "USD total: no per-token price is bound anywhere the runner can read, so the dollar cost of this campaign is UNPROVABLE in advance. The --max-estimated-cost-usd preflight constant bounds a planning estimate only.",
      "Token total: the preflight token check multiplies a fixed planning constant, so ACTUAL token consumption is not bounded by it. No runtime token cap exists in RunLimits.",
      "Physical HTTP attempts: the campaign budget bounds LOGICAL generate calls. A transport retry is a separate request that the logical cap does not count, so the physical request count is recorded separately and is not fully bounded in advance.",
      "Provider-side rate limits and any provider-enforced spend cap are outside the harness's control and are not claimed here.",
    ],
    outputDir: opts.outputDir,
    // The executor is bound INTO the envelope, so `planDigest` covers the driver
    // version and a rewritten driver invalidates an old approval (plan §R97
    // lines 214 and 229). The driver asserts equality with its own version
    // before it constructs a provider.
    driverVersion: R97_DRIVER_VERSION,
    // E4-R100: the executor's BUILD IDENTITY, beside the version label, and the
    // honest mixed-suite inventory. Both are envelope fields, so both are
    // covered by `planDigest`.
    driverBuildDigest,
    caseInventory,
    promotionEligible: false,
  };

  const readinessIssues = r97ReadinessIssues({
    selection,
    baseline: opts.baseline,
    candidate: opts.candidate,
    caps,
    authorizationForCaps: envelope,
    expectedProviderId: opts.providerId,
    expectedModelId: opts.modelId,
    expectedEndpointIdentity: opts.endpointIdentity,
  });

  // ---- Gate facts, built from OBSERVATIONS (never from the envelope) -------
  const gateFacts: R92GateFacts = {
    // The executor's clock, supplied by the caller. Never read from the plan.
    now: opts.now,
    executingSourceSha: candidateSha,
    observedArmBuilds: {
      baseline: { sha: opts.baseline?.sourceSha ?? null, executionPlanDigest: opts.baseline?.planDigest ?? null },
      candidate: { sha: opts.candidate?.sourceSha ?? null, executionPlanDigest: opts.candidate?.planDigest ?? null },
    },
    observedCaseFingerprints: { ...(opts.candidate?.caseFingerprints ?? {}) },
    observedProviderId: opts.candidate?.providerId ?? "",
    observedModelId: opts.candidate?.modelId ?? "",
    observedEndpointIdentity: opts.candidate?.endpointIdentity ?? null,
  };

  const bothObserved = opts.baseline !== null && opts.candidate !== null;
  const anyObserved = opts.baseline !== null || opts.candidate !== null;

  // Status is DERIVED, and the DRAFT/NOT_READY split is meaningful rather than
  // cosmetic:
  //
  //   DRAFT      — NOTHING has been observed yet, so there is no build to judge.
  //                This is a plan-in-progress: it names what must still be done.
  //   NOT_READY  — something WAS observed and it fails a readiness check, or the
  //                envelope is not executable as written. A human cannot fix this
  //                by approving it.
  //   FINALIZED  — both arms observed, every check passed, envelope valid.
  //
  // Plan §R97 line 213 groups the first two ("NOT_READY/DRAFT"); separating them
  // keeps the report honest about WHICH situation the reader is in.
  const envelopeIssues: R97ReadinessIssue[] = r92AuthorizationIssuesV1(envelope).map((detail) => ({
    code: "PLAN_INVALID",
    detail,
  }));
  const allIssues = [...readinessIssues, ...envelopeIssues];

  const status: R97PlanStatus = !anyObserved
    ? "DRAFT"
    : bothObserved && allIssues.length === 0
      ? "FINALIZED_AUTHORIZATION_PLAN"
      : "NOT_READY";
  const authorizable = status === "FINALIZED_AUTHORIZATION_PLAN";
  const planDigest = authorizable ? computeR92AuthorizationDigestV1(envelope) : null;

  // The PLAN-TIME SNAPSHOT (see `R97PlanResult.planObservation`). Built once and
  // exposed under BOTH names, so the review snapshot and the field the driver
  // reads can never describe different worlds.
  const planObservation: R97PlanObservation | null =
    opts.baseline === null || opts.candidate === null
      ? null
      : {
          now: opts.now,
          executingSourceSha: candidateSha,
          armShas: { baseline: baselineSha, candidate: candidateSha },
          armDigests: {
            baseline: opts.baseline.planDigest,
            candidate: opts.candidate.planDigest,
          },
          caseFingerprints: { ...opts.candidate.caseFingerprints },
          providerId: opts.candidate.providerId,
          modelId: opts.candidate.modelId,
          endpointIdentity: opts.candidate.endpointIdentity,
        };

  return {
    status,
    schemaVersion: authorizable ? R97_PLAN_SCHEMA : R97_DRAFT_SCHEMA,
    authorization: authorizable ? envelope : null,
    planDigest,
    gateFacts,
    // The plan-time observations, so the delivered artifact runs as-is. `null`
    // for a DRAFT: there is nothing observed to record, and a draft is not
    // executable anyway. This is HISTORY for review — the execution-time check
    // re-observes the world and never reads this block.
    planObservation,
    observation: planObservation,
    readinessIssues: allIssues,
    authorizable,
    driverBuildDigest: authorizable ? driverBuildDigest : null,
    caseInventory,
    approvalMarkdown: renderR97Markdown({
      status,
      envelope,
      planDigest,
      gateFacts,
      readinessIssues: allIssues,
      selection,
      intent,
      driverVersion: R97_DRIVER_VERSION,
      driverBuildDigest,
      caseInventory,
    }),
    realScores: false,
    passRateClaim: false,
    driverVersion: R97_DRIVER_VERSION,
  };
}

function renderR97Markdown(input: {
  status: R97PlanStatus;
  envelope: R97AuthorizationV1;
  planDigest: string | null;
  gateFacts: R92GateFacts;
  readinessIssues: R97ReadinessIssue[];
  selection: R97FrozenSelection;
  intent: R92CapIntent;
  driverVersion: string;
  driverBuildDigest: string;
  caseInventory: R97CaseInventoryEntry[];
}): string {
  const { status, envelope: a, planDigest, gateFacts, readinessIssues, selection, intent } = input;
  const L: string[] = [];
  L.push("# E4-R97 — finalized authorization plan for the real small A/B");
  L.push("");
  L.push(`**Status: ${status}**`);
  L.push("");
  if (status === "FINALIZED_AUTHORIZATION_PLAN") {
    L.push("This plan is **FINALIZED_AUTHORIZATION_PLAN — READY_FOR_AUTHORIZATION / NOT_RUN.** Nothing has been");
    L.push("executed. The run starts only after you approve the digest below, and the executor re-derives every bound");
    L.push("value before the first request.");
  } else if (status === "DRAFT") {
    L.push("This is a **DRAFT**. It carries no authorization envelope and **cannot be approved**: at least one arm has");
    L.push("not been observed by a real CLI dry-run, so no execution-plan digest exists to bind. Run the two-arm");
    L.push("observation to finalize it.");
  } else {
    L.push("This plan is **NOT_READY**. It cannot be approved as written, and no human decision can make it so. The");
    L.push("reasons are listed below; a plan that fails readiness is refused before any provider is constructed.");
  }
  L.push("");
  L.push("## What is being authorized");
  L.push("");
  L.push(`- Plan digest (approve THIS exact value): \`${planDigest ?? "<none — not finalizable>"}\``);
  L.push(`- Created: \`${a.createdAt}\`  ·  **Expires: \`${a.expiresAt}\`**`);
  L.push(`- Driver that would execute it: \`${input.driverVersion}\``);
  // E4-R100: a version LABEL does not move when the driver's CODE changes, so the
  // build digest is printed beside it. Plan §R100 怎么做: "除 driverVersion 标签外
  // 记录 driver构建/源hash."
  L.push(`- Driver build digest (approve THIS too — it covers the executor's bytes): \`${input.driverBuildDigest}\``);
  L.push(`- Output location: \`${a.outputDir}\``);
  L.push(`- Promotion-eligible: \`${String(a.promotionEligible)}\` (a dev-set mechanism run is not a promotion run)`);
  L.push("");
  L.push("## Readiness");
  L.push("");
  if (readinessIssues.length === 0) {
    L.push("Every readiness check passed: both arms were observed by a real CLI `--dry-run` in their own clean");
    L.push("checkout, and every bound value is an OBSERVED value.");
  } else {
    L.push("| Code | Detail |");
    L.push("| --- | --- |");
    for (const i of readinessIssues) L.push(`| ${i.code} | ${i.detail} |`);
  }
  L.push("");
  L.push("## The two arms — observed, not declared");
  L.push("");
  L.push("| Arm | Observed sourceSha | Real CLI dry-run plan digest |");
  L.push("| --- | --- | --- |");
  for (const key of ["baseline", "candidate"] as const) {
    const b = gateFacts.observedArmBuilds[key];
    L.push(`| ${key} | \`${b.sha ?? "<NOT OBSERVED>"}\` | \`${b.executionPlanDigest ?? "<NOT OBSERVED>"}\` |`);
  }
  L.push("");
  L.push("Both digests above come from running the real CLI `--dry-run` inside each arm's own checkout. They are NOT");
  L.push("plan-time substitutes: a plan-time digest cannot prove the build it describes.");
  L.push("");
  L.push("## Frozen case list (content frozen before any result)");
  L.push("");
  L.push(`Selection digest: \`${selection.digest}\` (covers case CHOICE only).`);
  L.push("");
  L.push("The list below is in the order the ARM planned, which is the order that will execute. `loadBenchmarkCases`");
  L.push("sorts alphabetically, so this order is the CLI's, not the selection file's array order; the selection's own");
  L.push("`armRule` requires only that BOTH arms use the same order, which readiness checks separately.");
  L.push("");
  L.push("| # | Case | TRUE suite | Planned under | Fingerprint observed by the arm |");
  L.push("| --- | --- | --- | --- | --- |");
  a.caseIds.forEach((id, i) => {
    const fp = gateFacts.observedCaseFingerprints[id];
    const entry = input.caseInventory.find((e) => e.caseId === id);
    const trueSuite = entry?.suite ?? "<UNRECORDED>";
    const planned = entry === undefined ? "<UNRECORDED>" : entry.relabelled ? `${entry.plannedUnderSuite} (ADAPTED)` : entry.plannedUnderSuite;
    L.push(`| ${i + 1} | \`${id}\` | **${trueSuite}** | ${planned} | \`${fp === undefined ? "<NOT OBSERVED>" : `${fp.slice(0, 16)}…`}\` |`);
  });
  L.push("");
  // E4-R100: the frozen selection is MIXED-SUITE. The CLI's `--suite` is
  // single-valued, so the driver plans the whole list under one label; the TRUE
  // suite is recorded here so no report can claim the stress cases were
  // regression cases (plan §R100 怎么做).
  const suitesPresent = [...new Set(input.caseInventory.map((e) => e.suite))].sort();
  L.push(`This frozen list is **mixed-suite**: ${suitesPresent.join(" + ")}. The CLI's \`--suite\` accepts ONE value, so`);
  L.push("the driver plans the whole list under a single label — that adaptation is recorded per case in the table above");
  L.push("(`Planned under`), and the **TRUE** suite column is the honest classification. This inventory is bound INTO the");
  L.push("envelope and is therefore covered by `planDigest`: relabelling a case moves the approved digest.");
  L.push("");
  L.push("## Provider / model / endpoint identity");
  L.push("");
  L.push(`- provider: \`${a.providerId}\`  ·  model: \`${a.modelId}\``);
  L.push(`- endpoint identity (normalized digest, never a raw URL): \`${String(a.endpointIdentity)}\``);
  L.push("");
  L.push("## Caps — what is enforceable vs what is only claimed");
  L.push("");
  L.push("| Cap | Scope | Value | Enforcement | Blocked |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const c of a.caps) {
    L.push(`| ${c.cap} | ${c.scope} | ${c.value === null ? "— (undeclared)" : String(c.value)} | ${c.enforcement} | ${c.blocked ? "**BLOCKED**" : "no"} |`);
  }
  L.push("");
  L.push(`- Global model-call budget: **${String(intent.campaignModelCalls)}** LOGICAL calls, held in a cross-process`);
  L.push("  ledger (`e4-r97-budget-ledger-v1`) that is reserved BEFORE each call and shared by both arms. A restart");
  L.push("  does NOT refresh the allowance, and an attempt whose outcome is unknown keeps its reservation.");
  L.push(`- Physical transport retries are recorded SEPARATELY from logical calls and are not bounded by the above.`);
  L.push(`- Time: per-case \`maxDurationMs = ${intent.perCaseDurationMs}\`. Tool calls: per-case \`maxToolCalls = ${intent.perCaseToolCalls}\`.`);
  L.push(`- Serialism: **1** (no concurrency). Repetitions: **${a.repetitions}**.`);
  L.push("");
  L.push("### Cost items that are UNKNOWN and therefore not capped");
  L.push("");
  for (const item of a.unknownCostItems) L.push(`- ${item}`);
  L.push("");
  L.push("## What this run will NOT do");
  L.push("");
  L.push("- It will not produce a pass-rate claim, and no pass-rate improvement is recorded while unauthorized.");
  L.push("- It will not re-run the 86 paid cases.");
  L.push("- It will not consume holdout cases again, even if this small A/B succeeds.");
  L.push("- CI all-green, synthetic mechanism improvement and real task pass-rate improvement are three different claims.");
  L.push("");
  L.push("## Fix scope");
  L.push("");
  L.push(a.fixScopeStatement);
  return L.join("\n");
}
