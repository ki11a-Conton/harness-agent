import type { HarnessConfig } from "@ar/harness";
import type { ConfigExplainResult, ResolvedConfig } from "@ar/harness";
import { renderConfigValue } from "@ar/harness";
import type { CommandResult } from "./commands.js";

/**
 * P27-5 — `agent config explain [key]`.
 *
 * Renders the effective config with per-key origins and lifecycle
 * (P27-2/3/4). Values are redacted: API keys, auth headers and tokens never
 * appear in output.
 */

export interface ConfigCommandDeps {
  resolvedConfig: ResolvedConfig<HarnessConfig>;
}

export async function configExplainCmd(
  key: string | undefined,
  deps: ConfigCommandDeps,
): Promise<CommandResult> {
  const { explainConfig } = await import("@ar/harness");
  const result: ConfigExplainResult = explainConfig(deps.resolvedConfig, key);
  const lines: string[] = [`config fingerprint: ${result.fingerprint}`];
  if (key !== undefined) {
    lines.push(`key: ${key}`);
  }
  lines.push("");
  for (const entry of result.entries) {
    const source = entry.origin !== undefined ? entry.origin.source : "(default/absent)";
    const layerId = entry.origin !== undefined ? entry.origin.layerId : "";
    lines.push(
      `${entry.key} = ${renderConfigValue(entry.key, entry.value)}`,
      `  from ${source}${layerId !== "" ? ` (${layerId})` : ""}   [${entry.lifecycle}]`,
    );
    if (entry.doc !== undefined) {
      lines.push(`  doc: ${entry.doc}`);
    }
  }
  return { exitCode: 0, lines };
}

/**
 * E2-08 — `agent config effective <candidate>|baseline [--json]`.
 *
 * Read-only diagnostic: resolves the requested arm through the ArmFactory and
 * prints the ACTUAL runtime profile identity (champion level, candidate,
 * resolved config digest, strategy ids, features) — computed from the
 * constructed config, never from a docs file. No provider calls. --json emits
 * one parseable JSON document on stdout.
 */
export async function configEffectiveCmd(argv: string[]): Promise<CommandResult> {
  const wantJson = argv.includes("--json");
  const target = argv.find((a) => !a.startsWith("--")) ?? "baseline";
  const { getArmFactory, runtimeIdentityOf } = await import("@ar/evaluation");
  const factory = getArmFactory();
  let arm;
  try {
    arm = target === "baseline"
      ? factory.resolveBaseline()
      : factory.resolveCandidate(target);
  } catch (err) {
    const detail = `config effective: cannot resolve "${target}": ${err instanceof Error ? err.message : String(err)}`;
    return { exitCode: 1, lines: wantJson ? [JSON.stringify({ ok: false, detail })] : [detail] };
  }
  const identity = runtimeIdentityOf(arm);
  const payload = {
    schemaVersion: identity.schemaVersion,
    ok: true,
    target,
    championLevel: identity.championLevel,
    candidateId: identity.candidateId,
    resolvedConfigDigest: identity.resolvedConfigDigest,
    strategyIds: identity.strategyIds,
    featuresEnabled: identity.featuresEnabled,
    note: "identity computed from the ACTUAL resolved arm config (E2-08) — never from docs state; no provider calls",
  };
  if (wantJson) {
    return { exitCode: 0, lines: [JSON.stringify(payload, null, 2)] };
  }
  return {
    exitCode: 0,
    lines: [
      `config effective (E2-08):`,
      `  target: ${target}`,
      `  championLevel: ${identity.championLevel}`,
      `  candidateId: ${identity.candidateId ?? "(none — baseline)"}`,
      `  resolvedConfigDigest: ${identity.resolvedConfigDigest}`,
      `  strategyIds: ${identity.strategyIds.join(", ") || "(none)"}`,
      `  featuresEnabled: ${identity.featuresEnabled.join(", ") || "(none)"}`,
    ],
  };
}
