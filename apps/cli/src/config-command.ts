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
