/**
 * E4-07 — the ONE champion application path used by both CLI and Web.
 *
 * `champion promote` only records `applicationPending`. A champion becomes
 * `applied` exclusively here, at real process startup:
 *
 *   read champion state
 *   -> resolve the champion profile (pending-application allowed for a claim)
 *   -> build the harness config the champion prescribes
 *   -> run the REAL createHarness
 *   -> project the harness's FINAL resolved config (values AND per-key origins)
 *   -> verify every champion-controlled key was actually supplied by the
 *      runtime layer and equals the target (a default fallback or an
 *      environment override is NOT application of the champion)
 *   -> CAS-write the AppliedProof, or record an explicit application failure
 *      and fall back to the frozen baseline harness.
 *
 * Nothing here trusts the state file's own `applied` flag: an `applied` state
 * is re-verified against the live config on every startup, and a proof from a
 * previous generation can never authorize the current one.
 */

import { createHarness, type Harness, type HarnessConfig } from "@ar/harness";
import {
  APPLIED_PROOF_SCHEMA_VERSION,
  buildAppliedProofV1,
  championApplicationTargetDigestV1,
  championLifecycleStatus,
  evaluateChampionApplicationV1,
  markChampionApplicationFailed,
  markChampionApplied,
  resolveChampionHarness,
  verifyAppliedProofV1,
  type AppliedProofV1,
  type ChampionFieldCheckV1,
  type ChampionState,
} from "@ar/evaluation";
import {
  championStateDigest,
  readChampionStateFile,
  writeChampionStateFileCas,
} from "./champion-state-file.js";

export interface ChampionStartupOutcome {
  /** The harness the process should actually run. */
  harness: Harness;
  status:
    | "baseline"           // no champion above C0 — plain production harness
    | "applied"            // champion applied and proven by this startup
    | "alreadyApplied"     // champion already proven; live config re-verified
    | "applicationFailed"  // config did not match — fell back to the baseline
    | "profileRejected"    // state invalid/quarantined — baseline, claim kept
    | "stateUnreadable";   // no usable state file — baseline
  reason: string | null;
  proof: AppliedProofV1 | null;
}

/** E4-R05 (F12): the budget-aware completion guidance the champion application
 *  installs as `completionGuidance` — the SAME behavior text the benchmark uses,
 *  so the promoted candidate really runs what was evaluated. */
export const CHAMPION_BUDGET_AWARE_GUIDANCE =
  "When you are close to the configured budget, prioritize running the verification command and confirming the task is complete. Avoid spending the remaining budget on speculative work when verification would pass.";

/**
 * E4-R05 (F12): mechanisms a champion may require and whether the production
 * startup can actually install them TODAY. Only mechanisms with a real install
 * point may be applied; anything else rejects the candidate startup outright —
 * a flags-only PROVEN is never written.
 */
export function championMechanismInstallPlan(championConfig: {
  memory?: { enabled?: boolean };
  budgetAwareCompletion?: boolean;
  toolSelector?: unknown;
  contextBudget?: unknown;
  recovery?: unknown;
}): { ok: boolean; reason?: string; supported: Record<string, boolean> } {
  const supported: Record<string, boolean> = { memory: false, budgetAware: false };
  if (championConfig.memory?.enabled === true || championConfig.memory?.enabled === false) {
    // memory is installed by the wrapper (enabled true/false both project).
    supported.memory = true;
  }
  if (championConfig.budgetAwareCompletion === true) {
    supported.budgetAware = true;
  }
  const unsupported: string[] = [];
  if (championConfig.toolSelector !== undefined) unsupported.push("toolSelector (deferred-schema)");
  if (championConfig.contextBudget !== undefined) unsupported.push("contextBudget (adaptive)");
  if (championConfig.recovery !== undefined && championConfig.recovery !== null) unsupported.push("recoveryPlanner");
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: `champion candidate requires mechanisms with no production install point: ${unsupported.join(", ")} — refusing flags-only PROVEN`,
      supported,
    };
  }
  return { ok: true, supported };
}

/** The champion-controlled surface projected from a real resolved config. */
export function projectChampionFieldChecks(
  championFlags: Record<string, boolean>,
  championMemoryEnabled: boolean | undefined,
  championBudgetAware: boolean,
  resolved: HarnessConfig,
  origins: ReadonlyMap<string, { source: string }>,
): ChampionFieldCheckV1[] {
  const checks: ChampionFieldCheckV1[] = [];
  const resolvedFlags = (resolved.featureFlags ?? {}) as Record<string, boolean>;
  for (const key of Object.keys(championFlags).sort()) {
    const dot = `featureFlags.${key}`;
    checks.push({
      key: dot,
      intended: championFlags[key],
      actual: resolvedFlags[key],
      origin: origins.get(dot)?.source ?? "none",
    });
  }
  if (championMemoryEnabled !== undefined) {
    const actual = (resolved.memory as { enabled?: boolean } | undefined)?.enabled;
    checks.push({
      key: "memory.enabled",
      intended: championMemoryEnabled,
      actual,
      origin: origins.get("memory.enabled")?.source ?? "none",
    });
  }
  // E4-R05 (F12): budget-aware completion must be INSTALLED (the config carries
  // the guidance) and come from the champion application — a fallback or an
  // environment override is not application.
  if (championBudgetAware) {
    checks.push({
      key: "completionGuidance",
      intended: CHAMPION_BUDGET_AWARE_GUIDANCE,
      actual: resolved.completionGuidance ?? null,
      origin: origins.get("completionGuidance")?.source ?? "none",
    });
  }
  return checks;
}

export interface CreateHarnessWithChampionOptions {
  /** Which production entrypoint is starting (both share this function). */
  runtimeEntrypoint: "cli" | "web";
  /** The app's own base harness config (cwd, provider, model, dataDir, ...). */
  baseConfig: HarnessConfig;
  /** Source/build sha recorded in the proof. */
  sourceSha?: string | null;
  /** Process / startup identifier (defaults to pid + start time). */
  processId?: string;
  /** Injectable for tests; defaults to the real createHarness. */
  createHarnessFn?: (config: HarnessConfig) => Promise<Harness>;
  /** Injectable clock (proof appliedAt). */
  now?: () => Date;
  /** Injectable champion state file path (tests must not touch repo state). */
  stateFilePath?: string;
}

/**
 * Start the real harness with the champion applied — or fall back to the
 * frozen baseline. Never claims `applied` without a verified live config.
 */
export async function createHarnessWithChampion(
  opts: CreateHarnessWithChampionOptions,
): Promise<ChampionStartupOutcome> {
  const create = opts.createHarnessFn ?? createHarness;
  const now = (opts.now ?? (() => new Date()))();
  const processId = opts.processId ?? `pid-${process.pid}-${now.getTime()}`;
  const base = opts.baseConfig;

  const read = await readChampionStateFile(opts.stateFilePath);
  if (read instanceof Error) {
    return { harness: await create(base), status: "stateUnreadable", reason: read.message, proof: null };
  }
  const state: ChampionState = read;
  if (state.level === "C0") {
    return { harness: await create(base), status: "baseline", reason: null, proof: null };
  }
  const candidateId = state.candidateId;
  if (candidateId === null) {
    return { harness: await create(base), status: "profileRejected", reason: `state is ${state.level} with no candidate`, proof: null };
  }

  const lifecycle = championLifecycleStatus(state);
  const resolved = resolveChampionHarness(
    { level: state.level, candidateId, validity: state.validity, applied: state.applied },
    { level: state.level, candidateId },
    {
      ...(base.dataDir !== undefined ? { dataDir: base.dataDir } : {}),
      // A promotion claim must be resolvable so the runtime can PROVE it;
      // production profile loading elsewhere stays fail-closed without this.
      allowPendingApplication: lifecycle === "APPLICATION_PENDING" || lifecycle === "APPLICATION_FAILED",
    },
  );
  if (!resolved.ok || resolved.harnessConfig === undefined) {
    return {
      harness: await create(base),
      status: "profileRejected",
      reason: resolved.reason ?? "champion profile could not be resolved",
      proof: null,
    };
  }

  const championConfig = resolved.harnessConfig;
  const championFlags = championConfig.featureFlags;
  const championMemory = championConfig.memory?.enabled;
  const championBudgetAware = championConfig.budgetAwareCompletion === true;

  // E4-R05 (F12): a champion whose required mechanisms have no real install
  // point is REFUSED here — never applied with flags-only PROVEN.
  const installPlan = championMechanismInstallPlan(championConfig);
  if (!installPlan.ok) {
    await recordFailure(state, installPlan.reason ?? "unsupported mechanisms", [], [], now, opts.runtimeEntrypoint, processId, opts.stateFilePath);
    return {
      harness: await createHarness(base),
      status: "profileRejected",
      reason: installPlan.reason ?? "unsupported mechanisms",
      proof: null,
    };
  }

  // Build the harness config the champion prescribes on top of the app's base.
  const championHarnessConfig: HarnessConfig = {
    ...base,
    profile: "champion",
    featureFlags: { ...(base.featureFlags ?? {}), ...championFlags },
    ...(championMemory === true
      ? { memory: { ...(base.memory ?? {}), enabled: true, ...(base.dataDir !== undefined ? { dbPath: `${base.dataDir}/memory` } : {}) } }
      : championMemory === false
        ? { memory: { ...(base.memory ?? {}), enabled: false } }
        : {}),
    // E4-R05 (F12): budget-aware completion is INSTALLED, not a flag — the
    // harness main agent appends this guidance to the system prompt.
    ...(championBudgetAware ? { completionGuidance: CHAMPION_BUDGET_AWARE_GUIDANCE } : {}),
  };

  let harness: Harness;
  let checks: ChampionFieldCheckV1[];
  try {
    harness = await create(championHarnessConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordFailure(state, `createHarness failed: ${message}`, [], [], now, opts.runtimeEntrypoint, processId, opts.stateFilePath);
    return { harness: await createHarness(base), status: "applicationFailed", reason: message, proof: null };
  }
  checks = projectChampionFieldChecks(
    championFlags,
    championMemory,
    championBudgetAware,
    harness.resolvedConfig.value,
    harness.resolvedConfig.origins,
  );

  const evaluation = evaluateChampionApplicationV1({ checks });
  if (!evaluation.ok) {
    // The live config is not the champion's. Do NOT run it and do NOT claim
    // applied: record the failure and fall back to the frozen baseline.
    await harness.close();
    await recordFailure(state, evaluation.reason ?? "application verification failed", evaluation.mismatchedKeys, evaluation.overriddenKeys, now, opts.runtimeEntrypoint, processId, opts.stateFilePath, evaluation);
    return {
      harness: await createHarness(base),
      status: "applicationFailed",
      reason: evaluation.reason ?? "verification failed",
      proof: null,
    };
  }

  const generation = championApplicationTargetDigestV1(state);
  const existing = state.appliedProof;
  if (
    state.applied &&
    existing !== undefined &&
    verifyAppliedProofV1(existing, {
      stateDigest: generation,
      level: state.level,
      candidateId,
      targetConfigHash: evaluation.targetConfigHash,
    }).ok
  ) {
    // Restart of an already-applied champion: live config verified, nothing to
    // write (idempotent).
    return { harness, status: "alreadyApplied", reason: null, proof: existing };
  }

  const proof = buildAppliedProofV1({
    schemaVersion: APPLIED_PROOF_SCHEMA_VERSION,
    stateDigest: generation,
    level: state.level,
    candidateId,
    targetConfigHash: evaluation.targetConfigHash,
    appliedConfigHash: evaluation.appliedConfigHash,
    runtimeEntrypoint: opts.runtimeEntrypoint,
    sourceSha: opts.sourceSha ?? null,
    processId,
    appliedAt: now.toISOString(),
  });

  const next = markChampionApplied(state, proof);
  const cas = await writeChampionStateFileCas(next, championStateDigest(state), opts.stateFilePath);
  if (!cas.ok) {
    // E4-R05 (F13): LOST THE RACE — another process advanced the state while
    // this one built generation A's harness. NEVER return A: close it (no
    // timers/stores keep serving) and run the frozen baseline instead.
    await harness.close().catch((closeErr: unknown) => {
      process.stderr.write(`[degraded] champion-application stale-harness close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}\n`);
    });
    return {
      harness: await createHarness(base),
      status: "applicationFailed",
      reason: "champion state changed concurrently; applied proof not written (CAS rejected); stale champion harness closed",
      proof: null,
    };
  }
  return { harness, status: "applied", reason: null, proof };
}

async function recordFailure(
  state: ChampionState,
  reason: string,
  mismatchedKeys: string[],
  overriddenKeys: string[],
  now: Date,
  runtimeEntrypoint: "cli" | "web",
  processId: string,
  stateFilePath?: string,
  evaluation?: { targetConfigHash: string; appliedConfigHash: string },
): Promise<void> {
  const failed = markChampionApplicationFailed(state, {
    schemaVersion: APPLIED_PROOF_SCHEMA_VERSION,
    failedAt: now.toISOString(),
    runtimeEntrypoint,
    processId,
    reason,
    mismatchedKeys,
    overriddenKeys,
    targetConfigHash: evaluation?.targetConfigHash ?? "",
    appliedConfigHash: evaluation?.appliedConfigHash ?? "",
  });
  // Best-effort: a failure record must never block starting the baseline.
  await writeChampionStateFileCas(failed, championStateDigest(state), stateFilePath);
}
