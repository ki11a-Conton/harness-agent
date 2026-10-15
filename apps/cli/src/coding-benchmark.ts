import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createHarness, type HarnessConfig } from "@ar/harness";
import { EvalRunner, type EvalCase, type EvalOutcome } from "@ar/evaluation";

export interface CodingOracleResult { passed: boolean; checks: readonly { name: string; passed: boolean; detail?: string }[] }
export interface CodingBenchmarkOptions {
  caseDef: EvalCase;
  /** Caller supplies the same pre-admitted provider, limits, sandbox and
   * tool budgets as the existing paired runner. No provider is fabricated. */
  config: HarnessConfig;
  oracleFiles: readonly { path: string; sha256: string }[];
  /** Independent trusted host oracle. It must not trust agent prose. */
  judge: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<CodingOracleResult>;
}

async function checkOracles(root: string, files: CodingBenchmarkOptions["oracleFiles"]): Promise<boolean> {
  if (!files.length) return false;
  try {
    const canonicalRoot = await realpath(root);
    for (const file of files) {
      const path = resolve(root, file.path), rel = relative(resolve(root), path);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
      const canonical = await realpath(path);
      if (!canonical) return false;
      const canonicalRel = relative(canonicalRoot, canonical);
      if (isAbsolute(canonicalRel) || canonicalRel === ".." || canonicalRel.startsWith("../") || canonicalRel.startsWith("..\\")) return false;
      const parts = rel.split(/[\\/]/);
      for (let index = 1; index < parts.length; index++) {
        const parent = await lstat(resolve(root, ...parts.slice(0, index)));
        if (!parent?.isDirectory() || parent.isSymbolicLink()) return false;
      }
      const info = await lstat(path);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) return false;
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) return false;
    }
    return true;
  } catch {
    // Any filesystem/permission/identity failure denies oracle admission.
    return false;
  }
}

/** Adapter to the existing EvalRunner/EvalOutcome pipeline, not another score
 * format. Judge and oracle integrity are required even if the model says done.
 * Formal promotion admission remains the caller's existing paired-eval path. */
export async function runCodingBenchmarkCase(options: CodingBenchmarkOptions): Promise<{ outcome: EvalOutcome; oracle: CodingOracleResult; configFingerprint: string }> {
  if (options.config.profile !== "benchmark") throw new TypeError("coding benchmark requires the benchmark profile");
  if (!await checkOracles(options.config.cwd, options.oracleFiles)) throw new Error("CODING_ORACLE_INTEGRITY: unqualified or modified oracle files");
  const harness = await createHarness(options.config);
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: options.config.cwd });
    const outcome = await new EvalRunner().run(options.caseDef, { runtime: harness.runtime, sessionId: session.id, events: harness.events });
    let oracle: CodingOracleResult;
    const intact = await checkOracles(options.config.cwd, options.oracleFiles);
    if (!intact) oracle = { passed: false, checks: [{ name: "oracle-integrity", passed: false, detail: "Agent modified or replaced a fixed oracle" }] };
    else {
      try { oracle = await options.judge(harness); }
      catch { oracle = { passed: false, checks: [{ name: "independent-oracle", passed: false, detail: "Trusted oracle failed to execute" }] }; }
      if (!await checkOracles(options.config.cwd, options.oracleFiles)) oracle = { passed: false, checks: [{ name: "oracle-integrity", passed: false }] };
    }
    const passed = oracle.passed === true && oracle.checks.length > 0 && oracle.checks.every(check => check.passed === true);
    return { outcome: passed ? outcome : { ...outcome, status: "failed", violations: [...outcome.violations, "independent coding oracle failed"], reason: "Independent oracle did not verify the final code" }, oracle,
      configFingerprint: harness.resolvedConfig.fingerprint };
  } finally { await harness.close(); }
}
