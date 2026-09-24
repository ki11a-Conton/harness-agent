/**
 * P21-6 — rollback switch and champion manifest.
 *
 * Every mechanism promoted into the Champion MUST be individually
 * disableable, and the manifest must say HOW. `CHAMPION_MANIFEST.json` is the
 * single machine-readable answer to "what did we promote, when, with what
 * evidence, and how do I turn it off". The rollback config is derived from
 * the P21-2 candidate matrix (the candidate's OWN disabled config), so
 * "default on but cannot find the switch" is structurally impossible.
 */

import { candidateOf } from "./candidate-matrix.js";

export type SecurityStatus = "clean" | "attention" | "blocked";

export interface BenchmarkDelta {
  /** Net passed-case delta (candidate - baseline); 0 when not measured. */
  netPassedDelta: number;
  tokensDelta: number;
  /** Verified-completion-rate delta (candidate - baseline). */
  verifiedDelta: number;
}

export interface ChampionManifestEntry {
  /** P21-2 candidate id (the single-variable switch name). */
  feature: string;
  /** ISO timestamp of the promotion. */
  promotedAt: string;
  /** Evidence report reference (P21-3 paired eval output / claim). */
  evidenceReport: string;
  /** P21-3 benchmark delta that justified the promotion. */
  benchmarkDelta: BenchmarkDelta;
  securityStatus: SecurityStatus;
  /** True when the feature can be rolled back individually (always true —
   *  the rollbackConfig below is the concrete switch). */
  rollback: boolean;
  /** THE concrete config that disables this feature (from P21-2). */
  rollbackConfig: Record<string, unknown>;
}

export interface ChampionManifest {
  schemaVersion: 1;
  updatedAt: string;
  /** Every promoted mechanism, one entry per feature. */
  entries: ChampionManifestEntry[];
}

export interface ChampionManifestEntryInput {
  feature: string;
  promotedAt: string;
  evidenceReport: string;
  benchmarkDelta: BenchmarkDelta;
  securityStatus?: SecurityStatus;
}

/**
 * P21-6 — build the manifest. FAIL-CLOSED: an unknown feature cannot be
 * promoted (no rollback switch would exist for it).
 */
export function buildChampionManifest(
  inputs: ChampionManifestEntryInput[],
  updatedAt = new Date().toISOString(),
): ChampionManifest {
  const entries: ChampionManifestEntry[] = inputs.map((input) => {
    const candidate = candidateOf(input.feature);
    if (candidate === undefined) {
      throw new TypeError(
        `champion manifest: unknown feature "${input.feature}" — a promoted feature must exist in the P21-2 candidate matrix so a rollback switch exists`,
      );
    }
    return {
      feature: input.feature,
      promotedAt: input.promotedAt,
      evidenceReport: input.evidenceReport,
      benchmarkDelta: input.benchmarkDelta,
      securityStatus: input.securityStatus ?? "clean",
      // Rollback is ALWAYS available — the disabled config is the switch.
      rollback: true,
      rollbackConfig: candidate.disabled,
    };
  });
  return { schemaVersion: 1, updatedAt, entries };
}

/**
 * P21-6 — answer "how do I turn feature X off" mechanically. Returns the
 * config fragment to apply on top of the champion profile; undefined when the
 * feature was never promoted (nothing to roll back).
 */
export function rollbackSwitchOf(
  manifest: ChampionManifest,
  feature: string,
): Record<string, unknown> | undefined {
  const entry = manifest.entries.find((e) => e.feature === feature);
  return entry?.rollbackConfig;
}

/** Every promoted feature has a real rollback switch (the invariant). */
export function assertAllPromotedFeaturesRollbackable(manifest: ChampionManifest): void {
  for (const entry of manifest.entries) {
    if (!entry.rollback || entry.rollbackConfig === undefined) {
      throw new Error(`champion manifest: ${entry.feature} is not individually rollbackable`);
    }
  }
}

/** Render the manifest as text for CLI/report output. */
export function renderChampionManifest(manifest: ChampionManifest): string[] {
  const lines = ["# CHAMPION_MANIFEST", `- schemaVersion: ${manifest.schemaVersion}`, `- updatedAt: ${manifest.updatedAt}`, ""];
  if (manifest.entries.length === 0) {
    lines.push("(no mechanisms promoted yet)");
    return lines;
  }
  lines.push("| feature | promotedAt | security | Δpassed | Δtokens | Δverified | rollback |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const e of manifest.entries) {
    const d = e.benchmarkDelta;
    lines.push(
      `| ${e.feature} | ${e.promotedAt} | ${e.securityStatus} | ${d.netPassedDelta > 0 ? "+" : ""}${d.netPassedDelta} | ${d.tokensDelta > 0 ? "+" : ""}${d.tokensDelta} | ${d.verifiedDelta >= 0 ? "+" : ""}${d.verifiedDelta.toFixed(3)} | ${e.rollback ? `off via ${JSON.stringify(e.rollbackConfig)}` : "NO"} |`,
    );
  }
  lines.push("", "every promoted feature is individually rollbackable (no 'default-on and can't turn off')");
  return lines;
}
