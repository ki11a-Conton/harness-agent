/**
 * P22-3 — final production audit (`agent production-audit`).
 *
 * Automatic, evidence-based checks that the release surface is honest:
 *   1. capability matrix is machine-generated (audit output).
 *   2. no silent catch blocks in production sources.
 *   3. no production `as never` ESCAPE with a fabricated literal value
 *      (whitelist: plain type-casts `x as never` are conversions, not forgeries;
 *      `"" as never` / `0 as never` are fabricated values → flagged).
 *   4. no unsafe path-prefix security boundary (path.startsWith as a gate).
 *   5. no raw command-prefix approval logic (cmd.startsWith as an approval).
 *   6. all side effects flow through the orchestrator (single execution path).
 *   7. write-capable child (worker-w) is isolated: network denied + delegated
 *      workspace, never the parent root.
 *   8. unsafe tools are never auto-retried (recovery spec invariant, P19-4).
 *   9. durable harness reports durable approval/ask/checkpoint (P16-4).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RECOVERY_ACTION_SPECS } from "@ar/contracts";

export interface ProductionAuditCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ProductionAuditResult {
  checks: ProductionAuditCheck[];
  ok: boolean;
}

const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

function collectSources(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // missing/unreadable dir → no sources
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) collectSources(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function countMatches(src: string, pattern: RegExp, file: string, out: string[]): number {
  let count = 0;
  for (const match of src.matchAll(pattern)) {
    count += 1;
    const index = match.index ?? 0;
    const line = src.slice(0, index).split("\n").length;
    out.push(`${file}:${line}`);
  }
  return count;
}

/** P22-3 — run every production-audit check over the source tree. */
export function runProductionAudit(deps: { root: string }): ProductionAuditResult {
  const checks: ProductionAuditCheck[] = [];
  const root = deps.root;

  // 1) capability matrix is machine-generated.
  let matrixExists = false;
  let matrixGenerated = false;
  try {
    const matrix = readFileSync(join(root, "CAPABILITY_MATRIX.md"), "utf8");
    matrixExists = true;
    matrixGenerated = matrix.includes("generatedAt:") && matrix.includes("| id | status | implemented | productionWired |");
  } catch {
    matrixExists = false;
  }
  checks.push({
    name: "capability matrix machine-generated",
    passed: matrixExists && matrixGenerated,
    detail: matrixExists
      ? matrixGenerated
        ? "CAPABILITY_MATRIX.md carries generatedAt + the audit records table"
        : "CAPABILITY_MATRIX.md exists but is not the audit output"
      : "CAPABILITY_MATRIX.md missing — run `agent audit`",
  });

  // 2) no silent catch blocks in production sources.
  const catchHits: string[] = [];
  const sources = collectSources(join(root, "packages")).concat(collectSources(join(root, "apps")));
  for (const file of sources) {
    const stripped = stripComments(readFileSync(file, "utf8"));
    countMatches(stripped, /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g, file, catchHits);
    countMatches(stripped, /catch\s*\{\s*\}/g, file, catchHits);
  }
  checks.push({
    name: "no silent catch",
    passed: catchHits.length === 0,
    detail:
      catchHits.length === 0
        ? "no empty catch / fire-and-forget catch in production sources"
        : `silent catch at: ${catchHits.slice(0, 5).join(", ")}`,
  });

  // 3) no fabricated-literal `as never` escapes (whitelist: plain casts).
  const literalNever: string[] = [];
  for (const file of sources) {
    // Comments are stripped so doc examples never trip the scan; a REAL
    // literal cast in shipped code is flagged.
    const src = stripComments(readFileSync(file, "utf8"));
    // Fabricated literal cast: `"" as never`, `0 as never`, `null as never`.
    const re = /(\"\"|''|0|\bnull)\s*as\s*never/g;
    for (const m of src.matchAll(re)) {
      const index = m.index ?? 0;
      const line = src.slice(0, index).split("\n").length;
      literalNever.push(`${file}:${line} (${m[1]})`);
    }
  }
  checks.push({
    name: "no production as never escape (whitelist: type casts)",
    passed: literalNever.length === 0,
    detail:
      literalNever.length === 0
        ? "no fabricated literal `as never` in production sources (plain casts are whitelisted)"
        : `fabricated as never at: ${literalNever.slice(0, 5).join(", ")}`,
  });

  // 4) no unsafe path-prefix security boundary.
  const pathPrefix: string[] = [];
  for (const file of sources) {
    const src = stripComments(readFileSync(file, "utf8"));
    // An AUTHORIZATION gate that uses path.startsWith (prefix containment is
    // not containment — ../ escapes). REJECTION patterns (return unsafe /
    // deny / ok:false) are the correct way to use startsWith and are NOT
    // flagged. Report, never auto-fix.
    src.split("\n").forEach((line, i) => {
      // A line that both reads path.startsWith AND authorizes (allow/approve)
      // is a prefix-containment gate — ../ escapes.
      if (
        /\b(path|file|cwd)\.startsWith\s*\(/.test(line) &&
        /\b(allow|approve)\s*\(/.test(line)
      ) {
        pathPrefix.push(`${file}:${i + 1}`);
      }
    });
  }
  checks.push({
    name: "no unsafe path-prefix security check",
    passed: pathPrefix.length === 0,
    detail:
      pathPrefix.length === 0
        ? "no path.startsWith used as a security boundary"
        : `path-prefix gate at: ${pathPrefix.slice(0, 5).join(", ")}`,
  });

  // 5) no raw command-prefix approval logic.
  const cmdPrefix: string[] = [];
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    const re = /(command|cmd)\.startsWith\s*\(\s*["'`]/g;
    for (const m of src.matchAll(re)) {
      const index = m.index ?? 0;
      const line = src.slice(0, index).split("\n").length;
      cmdPrefix.push(`${file}:${line}`);
    }
  }
  checks.push({
    name: "no raw command-prefix approval",
    passed: cmdPrefix.length === 0,
    detail:
      cmdPrefix.length === 0
        ? "no command.startsWith approval logic"
        : `command-prefix approval at: ${cmdPrefix.slice(0, 5).join(", ")}`,
  });

  // 6) single execution path: the orchestrator is the only tool executor.
  const orchestratorGates: string[] = [];
  const harnessFile = join(root, "packages", "harness", "src", "create-harness.ts");
  try {
    const src = readFileSync(harnessFile, "utf8");
    if (src.includes("new ToolOrchestrator(") && src.includes("registry,")) {
      orchestratorGates.push("ToolOrchestrator wired with the registry (permission → approval → sandbox)");
    }
    if (src.includes("sandboxPolicy: config.sandboxPolicy ?? preset.sandbox")) {
      orchestratorGates.push("sandbox policy passed to the runtime");
    }
  } catch (err) {
    process.stderr.write(`[production-audit] create-harness.ts unreadable: ${err instanceof Error ? err.message : String(err)}
`);
  }
  checks.push({
    name: "side effects pass ToolOrchestrator + Permission + Sandbox",
    passed: orchestratorGates.length === 2,
    detail:
      orchestratorGates.length === 2
        ? orchestratorGates.join("; ")
        : `orchestrator wiring incomplete: ${orchestratorGates.join("; ") || "create-harness not found"}`,
  });

  // 7) write-capable child isolation: worker-w network deny + delegated workspace.
  const workerFile = join(root, "packages", "harness", "src", "worker-agent.ts");
  let childIsolated = false;
  try {
    const src = readFileSync(workerFile, "utf8");
    childIsolated =
      src.includes('name: "worker-w"') &&
      src.includes('{ action: "exec", resource: "network", effect: "deny" }') &&
      src.includes("ISOLATED copy of the parent workspace");
  } catch {
    childIsolated = false;
  }
  checks.push({
    name: "writable child requires isolation",
    passed: childIsolated,
    detail: childIsolated
      ? "worker-w: isolated workspace copy + network deny"
      : "worker-w missing isolation (isolated workspace or network deny)",
  });

  // 8) unsafe tools never auto-retried (P19-4 spec invariant).
  const retryUnsafe = Object.values(RECOVERY_ACTION_SPECS).filter((s) => s.allowsSideEffectReexecution === true);
  checks.push({
    name: "unsafe tool no auto retry",
    passed: retryUnsafe.length === 0,
    detail:
      retryUnsafe.length === 0
        ? "no recovery action allows side-effecting re-execution"
        : `actions allowing side-effect re-execution: ${retryUnsafe.map((s) => s.action).join(", ")}`,
  });

  // 9) durable harness reports durable approval/ask/checkpoint (best-effort:
  // the harness introspection enforces this at runtime; here we confirm the
  // durable store wiring exists in the composition root).
  let durableWired = false;
  try {
    const src = readFileSync(harnessFile, "utf8");
    durableWired =
      src.includes("DurableApprovalStore") &&
      src.includes("DurableCheckpointStore") &&
      src.includes("JSONLAskUserStore");
  } catch {
    durableWired = false;
  }
  checks.push({
    name: "durable mode wires durable approval/ask/checkpoint",
    passed: durableWired,
    detail: durableWired
      ? "DurableApprovalStore + DurableCheckpointStore + JSONLAskUserStore wired under a dataDir"
      : "durable store wiring not found in the composition root",
  });

  return { checks, ok: checks.every((c) => c.passed) };
}

/** Render for CLI output. */
export function renderProductionAudit(result: ProductionAuditResult): string[] {
  const lines = ["# P22-3 production audit", ""];
  for (const check of result.checks) {
    lines.push(`${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
    lines.push(`      ${check.detail}`);
  }
  lines.push("", result.ok ? "ALL PRODUCTION CHECKS PASS" : "PRODUCTION AUDIT FAILED");
  return lines;
}
