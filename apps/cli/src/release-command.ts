/**
 * P36-1 — `agent release verify` / `agent release gate` CLI commands.
 *
 * P38.2-4/13: `release gate` is a repo-owned gate runner that executes the
 * canonical command from GATE_COMMANDS (single source of truth), captures the
 * real exit code (INV-P38.2-004), and writes evidence JSON to the P38.2-10
 * namespaced layout. `release verify` reads the same evidence layout.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommandResult } from "./commands.js";
import {
  GATE_COMMANDS,
  REQUIRED_GATES,
  aggregateGateInstances,
  computeReleaseVerdict,
  parseRawEvidence,
  renderReleaseVerdict,
  validateGateEvidenceInstance,
  type RawGateEvidence,
  type ReleaseGateResult,
  type ReleasePlatform,
  type ReleaseVerdict,
  type RequiredGateId,
  type ValidatedGateEvidence,
} from "./release-verify.js";

export interface ReleaseVerifyOptions {
  root?: string;
  /** Evidence directory (default `<root>/.ci/evidence`). */
  evidenceDir?: string;
  /** Override HEAD resolution (tests). */
  headSha?: string;
}

async function detectHead(root: string): Promise<string> {
  return new Promise((resolveSha, reject) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err !== null) {
        reject(new Error(`cannot resolve HEAD in ${root}: ${err.message}`));
        return;
      }
      resolveSha(String(stdout).trim());
    });
  });
}

/**
 * P38.3-5/6 — read raw evidence, validate EVERY instance against the exact
 * HEAD/command/gate/platform BEFORE aggregating, index by gate+platform, check
 * the required platform set, then aggregate per-gate verdicts.
 *
 * Forbidden flow: aggregate first → validate only the representative/first
 * evidence. A stale or malformed secondary platform must NOT be hidden by a
 * valid first instance — any invalid instance is recorded as blocked, never
 * silently dropped.
 */
async function readGateEvidence(dir: string, expectedHead: string): Promise<ReleaseGateResult[]> {
  const byId = new Map<RequiredGateId, ValidatedGateEvidence[]>();
  const structuralFailures: string[] = [];
  const collect = async (d: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(d, entry);
      let stat;
      try {
        stat = await import("node:fs/promises").then((m) => m.stat(path));
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await collect(path);
        continue;
      }
      if (!entry.endsWith(".json")) continue;

      // Level 1 — read + parse the raw record. A structural failure (non-JSON,
      // missing fields, unknown gate) cannot be attributed to a gate.
      let raw: RawGateEvidence;
      try {
        const text = await readFile(path, "utf8");
        raw = parseRawEvidence(text, path);
      } catch (err) {
        structuralFailures.push(err instanceof Error ? err.message : String(err));
        continue;
      }

      // Level 2 — validate the instance against the exact expected HEAD,
      // canonical command, gate, and platform. A semantic failure is attributed
      // to the gate it claims.
      try {
        const impliedPlatform = inferPlatformFromPath(d);
        if (raw.platform && impliedPlatform && raw.platform !== impliedPlatform) {
          throw new Error(
            `malformed gate evidence at ${path}: platform "${raw.platform}" contradicts directory "${impliedPlatform}"`,
          );
        }
        const platform = (raw.platform ?? impliedPlatform) as ReleasePlatform | undefined;
        if (platform === undefined) {
          throw new Error(`malformed gate evidence at ${path}: missing platform`);
        }
        const validated = validateGateEvidenceInstance({
          evidence: raw,
          expectedHead,
          expectedCommand: GATE_COMMANDS[raw.gate as RequiredGateId],
          expectedGate: raw.gate as RequiredGateId,
          expectedPlatform: platform,
          sourcePath: path,
        });
        const list = byId.get(validated.id) ?? [];
        list.push(validated);
        byId.set(validated.id, list);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const gateId = raw.gate as RequiredGateId;
        const impliedPlatform = inferPlatformFromPath(d);
        const blockedPlatform = (raw.platform || impliedPlatform || "linux") as ReleasePlatform;
        const list = byId.get(gateId) ?? [];
        list.push({
          id: gateId,
          platform: blockedPlatform,
          state: "blocked",
          headSha: expectedHead,
          command: GATE_COMMANDS[gateId],
          evidenceRef: path,
          reason: message,
        });
        byId.set(gateId, list);
      }
    }
  };
  await collect(dir);

  // Aggregate per-gate instances with platform-aware checks. Gates with only
  // blocked instances produce a blocked aggregated gate.
  const results: ReleaseGateResult[] = [];
  for (const [id, instances] of byId) {
    results.push(aggregateGateInstances({ id, instances, expectedHead }));
  }
  // Structural failures (unreadable files, unknown gate, non-JSON) are surfaced
  // as a blocked pseudo-gate so they never disappear silently.
  if (structuralFailures.length > 0) {
    results.push({
      id: "typecheck",
      state: "blocked",
      headSha: expectedHead,
      command: GATE_COMMANDS.typecheck,
      reason: `invalid evidence file(s): ${structuralFailures.join("; ")}`,
    });
  }
  return results;
}

const PLATFORM_DIR_NAMES: readonly string[] = ["linux", "windows", "darwin", "coverage"];

function inferPlatformFromPath(dir: string): ReleasePlatform | undefined {
  const base = dir.split(/[\\/]/).pop() ?? "";
  return (PLATFORM_DIR_NAMES as readonly string[]).includes(base)
    ? (base as ReleasePlatform)
    : undefined;
}

/** Resolve a verdict from evidence on disk (used by the CLI and tests). */
export async function resolveReleaseVerdict(opts: ReleaseVerifyOptions): Promise<{
  verdict: ReleaseVerdict;
  headSha: string;
}> {
  const root = resolve(opts.root ?? process.cwd());
  const headSha = opts.headSha ?? (await detectHead(root));
  const evidenceDir = resolve(opts.evidenceDir ?? join(root, ".ci", "evidence"));
  const gates = await readGateEvidence(evidenceDir, headSha);
  const verdict = computeReleaseVerdict({ headSha, gates });
  return { verdict, headSha };
}

/** `agent release verify [--json] [--evidence-dir <dir>]` */
export async function releaseVerifyCmd(rest: string[], cliOpts: ReleaseVerifyOptions = {}): Promise<CommandResult> {
  let json = false;
  let explicitEvidenceDir: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--evidence-dir") {
      explicitEvidenceDir = rest[i + 1];
      i += 1;
    } else {
      return { exitCode: 1, lines: [`agent release verify: unknown flag: ${arg ?? "(none)"}`, "", "usage: agent release verify [--json] [--evidence-dir <dir>]"] };
    }
  }
  try {
    const { verdict } = await resolveReleaseVerdict({ ...cliOpts, evidenceDir: explicitEvidenceDir ?? cliOpts.evidenceDir });
    if (json) {
      return { exitCode: verdict.ready ? 0 : 1, lines: [JSON.stringify(verdict, null, 2)] };
    }
    return { exitCode: verdict.ready ? 0 : 1, lines: renderReleaseVerdict(verdict) };
  } catch (err) {
    return { exitCode: 1, lines: [`agent release verify failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** P38.2-13 — execute the canonical gate command and write its evidence. */
export interface GateRunResult {
  gate: RequiredGateId;
  command: string;
  exitCode: number;
  evidencePath: string;
}

/** Detect the OS namespace used by the P38.2-10 evidence layout. */
export function gatePlatform(): "linux" | "windows" | "darwin" {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    default:
      return "linux";
  }
}

/** Run one required gate, capture the REAL exit code, and write evidence.
 *  INV-P38.2-004: the evidence is durable before the command returns; a red
 *  gate returns its own exit code (evidence already written, never skipped). */
export async function runGate(
  gate: RequiredGateId,
  opts: { root?: string; headSha?: string; evidenceDir?: string } = {},
): Promise<GateRunResult> {
  const root = resolve(opts.root ?? process.cwd());
  const headSha = opts.headSha ?? (await detectHead(root));
  const command = GATE_COMMANDS[gate];
  // P38.2-10: evidence is namespaced per platform under gates/<os>/.
  const evidenceDir = resolve(opts.evidenceDir ?? join(root, ".ci", "evidence", "gates", gatePlatform()));
  const evidencePath = join(evidenceDir, `${gate}.json`);
  await mkdir(evidenceDir, { recursive: true });

  // Real exit code capture — execFileSync never exits the process early, so a
  // red gate is ALWAYS captured and evidence is written before we return.
  let exitCode = 0;
  try {
    execFileSync(command, {
      cwd: root,
      shell: true,
      stdio: "inherit",
      env: { ...process.env, OPENAI_API_KEY: "" }, // gates must run without a paid key
      windowsHide: true,
    });
  } catch (err) {
    exitCode = typeof err === "object" && err !== null && "status" in err ? ((err as { status?: number }).status ?? 1) : 1;
  }

  const evidence = {
    schemaVersion: 1,
    kind: "gate",
    gate,
    headSha,
    command,
    exitCode,
    passed: exitCode === 0,
    platform: gatePlatform(),
    generatedAt: new Date().toISOString(),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return { gate, command, exitCode, evidencePath };
}

/** `agent release gate [--all | <gate>...] [--evidence-dir <dir>]` */
export async function releaseGateCmd(rest: string[], cliOpts: ReleaseVerifyOptions = {}): Promise<CommandResult> {
  const explicitEvidenceDir = (() => {
    const idx = rest.indexOf("--evidence-dir");
    return idx >= 0 ? rest[idx + 1] : undefined;
  })();
  // Strip --evidence-dir and its value so they never count as gate ids.
  const args = rest.filter((a) => a !== "--all" && a !== "--evidence-dir" && a !== explicitEvidenceDir);
  if (args.some((a) => a.startsWith("--"))) {
    return { exitCode: 1, lines: ["agent release gate: unknown flag", "", "usage: agent release gate [--all | <gate>...] [--evidence-dir <dir>]"] };
  }
  let gates: RequiredGateId[];
  if (rest.includes("--all")) {
    gates = [...REQUIRED_GATES];
  } else if (args.length === 0) {
    return { exitCode: 1, lines: ["agent release gate: specify a gate id or --all", "", "usage: agent release gate [--all | <gate>...] [--evidence-dir <dir>]"] };
  } else {
    const unknown = args.filter((a) => !(REQUIRED_GATES as readonly string[]).includes(a));
    if (unknown.length > 0) {
      return { exitCode: 1, lines: [`agent release gate: unknown gate id(s): ${unknown.join(", ")}`, "", `known gates: ${REQUIRED_GATES.join(", ")}`] };
    }
    gates = args as RequiredGateId[];
  }

  const lines: string[] = [];
  let worstExit = 0;
  for (const gate of gates) {
    const result = await runGate(gate, { root: cliOpts.root ?? process.cwd(), headSha: cliOpts.headSha, evidenceDir: explicitEvidenceDir });
    lines.push(`gate ${gate}: exitCode=${result.exitCode} ${result.exitCode === 0 ? "PASS" : "FAIL"} → ${result.evidencePath}`);
    if (result.exitCode !== 0) worstExit = 1;
  }
  lines.push("", "All attempted gates produced durable evidence (INV-P38.2-004).");
  return { exitCode: worstExit, lines };
}
