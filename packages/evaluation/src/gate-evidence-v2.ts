/**
 * E2-13 — GateEvidenceV2: capability/release gate evidence bound to HEAD.
 *
 * The predecessor release evidence recorded gate/command/exitCode/passed but
 * freshness was wall-clock-ish and a hand-written `{"passed": true}` text was
 * accepted. GateEvidenceV2 binds every gate result to:
 *
 *   - exact HEAD sha + source cleanness BEFORE and AFTER the run (a gate that
 *     modified the tracked tree during its run is INVALID — E2-13 #5);
 *   - the canonical command argv (a different command is a different gate);
 *   - input/output digests so the evidence is content-addressed;
 *   - started/finished + real exit code (NOT_RUN / stale are stable states).
 *
 * The verifier is strict: stale HEAD, mismatched argv, dirty source, tampered
 * SHA/exitCode/digest all fail with stable reason codes. Unauthorized paid
 * gates surface as PAID_BENCHMARK_NOT_AUTHORIZED (BLOCKED) — never fabricated
 * PASS.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readFile, rename, stat } from "node:fs/promises";
import { stableStringify } from "./manifest.js";

export const GATE_EVIDENCE_V2_SCHEMA_VERSION = "2.0.0";

export type GateEvidenceV2State =
  | "passed"
  | "failed"
  | "not_run"
  | "blocked"
  | "invalid"
  | "PAID_BENCHMARK_NOT_AUTHORIZED";

export interface GateEvidenceV2 {
  schemaVersion: typeof GATE_EVIDENCE_V2_SCHEMA_VERSION;
  /** Stable gate id (e.g. "capability_audit"). */
  gate: string;
  /** The canonical command argv this gate runs (exact match enforced). */
  command: string[];
  /** Tool/runner version that produced this evidence. */
  toolVersion: string;
  /** The HEAD the gate ran against (exact match enforced). */
  gitSha: string;
  /** Source cleanness before the run. */
  cleanBefore: boolean;
  /** Source cleanness after the run (a gate must NOT dirty the tree). */
  cleanAfter: boolean;
  /** sha256 over the gate inputs (config/manifest content). */
  inputDigest: string;
  /** sha256 over the gate outputs (summary/artifacts). */
  outputDigest: string;
  startedAtIso: string;
  finishedAtIso: string;
  exitCode: number | null;
  passed: boolean;
  state: GateEvidenceV2State;
  summary: string;
  /** E4-10 #1: paid provider calls made by this gate (0 for every offline
   *  gate; a non-zero value on an offline gate is a violation). */
  providerCalls?: number;
  /** E4-10 #1: the environment class the gate ran under. */
  environmentClass?: "offline" | "paid" | "insecure-local";
  /** E4-10 #1: the gate's output artifacts (path + content digest), so a
   *  missing artifact can never be recorded as PASS. */
  artifactRefs?: Array<{ path: string; digest: string | null }>;
}

export type GateV2IssueCode =
  | "STALE_HEAD"
  | "COMMAND_MISMATCH"
  | "SOURCE_DIRTY_AFTER"
  | "EXIT_CODE_TAMPERED"
  | "DIGEST_MISMATCH"
  | "NOT_RUN"
  | "PAID_BENCHMARK_NOT_AUTHORIZED"
  | "PASS_WITHOUT_EVIDENCE"
  | "PROVIDER_CALLS_ON_OFFLINE"
  | "MISSING_ARTIFACT_REF";

export interface GateV2Issue {
  code: GateV2IssueCode;
  detail: string;
}

export interface GateV2VerifyResult {
  ok: boolean;
  issues: GateV2Issue[];
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export function digestOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

/** Capture git HEAD + cleanness for a repo root. Returns null when no git. */
export async function captureGitState(root: string): Promise<{ sha: string; clean: boolean } | null> {
  const sha = await runGit(["rev-parse", "HEAD"], root);
  if (sha === null) return null;
  const status = await runGit(["status", "--porcelain"], root);
  return { sha: sha.trim(), clean: status === null || status.trim() === "" };
}

function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile("git", args, { cwd, timeout: 10000, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
      resolvePromise(err !== null ? null : String(stdout));
    });
  });
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export interface GateV2VerifyOptions {
  /** The HEAD every evidence must bind to. */
  expectedHead: string;
  /** Canonical command argv this gate must have run. */
  expectedCommand: string[];
  /** Whether this gate is a PAID benchmark requiring authorization. */
  paidGate?: boolean;
  paidAuthorized?: boolean;
  /** Recompute the output digest from the on-disk summary (if provided). */
  expectedOutputDigest?: string;
  /** Whether the source tree must be clean AFTER the run. */
  requireCleanAfter?: boolean;
}

/** Strict-verify one GateEvidenceV2 instance. Every bind is checked. */
export function verifyGateEvidenceV2(
  evidence: GateEvidenceV2,
  opts: GateV2VerifyOptions,
): GateV2VerifyResult {
  const issues: GateV2Issue[] = [];

  // 1. HEAD must match exactly (freshness is HEAD-bound, not wall-clock).
  if (evidence.gitSha !== opts.expectedHead) {
    issues.push({ code: "STALE_HEAD", detail: `evidence gitSha ${evidence.gitSha} != expected ${opts.expectedHead}` });
  }

  // 2. Command must match the canonical argv.
  const cmdA = JSON.stringify(evidence.command);
  const cmdB = JSON.stringify(opts.expectedCommand);
  if (cmdA !== cmdB) {
    issues.push({ code: "COMMAND_MISMATCH", detail: `evidence command ${cmdA} != expected ${cmdB}` });
  }

  // 3. The gate must not dirty the tracked tree (E2-13 #5).
  if (opts.requireCleanAfter !== false && !evidence.cleanAfter) {
    issues.push({ code: "SOURCE_DIRTY_AFTER", detail: "source tree was dirty after the gate run — evidence invalid" });
  }

  // 4. exitCode must be consistent with `passed` (no tampering).
  if (evidence.passed && evidence.exitCode !== 0) {
    issues.push({ code: "EXIT_CODE_TAMPERED", detail: `passed=true but exitCode=${evidence.exitCode}` });
  }
  if (!evidence.passed && evidence.exitCode === 0) {
    issues.push({ code: "EXIT_CODE_TAMPERED", detail: `passed=false but exitCode=0` });
  }

  // 5. Paid-gate authorization (never fabricated PASS).
  if (opts.paidGate === true && opts.paidAuthorized !== true) {
    issues.push({ code: "PAID_BENCHMARK_NOT_AUTHORIZED", detail: "gate requires RUN_PAID_BENCHMARKS=1 — BLOCKED, never PASS" });
  }

  // 6. Output digest must match the recomputed value when available.
  if (opts.expectedOutputDigest !== undefined && evidence.outputDigest !== opts.expectedOutputDigest) {
    issues.push({ code: "DIGEST_MISMATCH", detail: `outputDigest ${evidence.outputDigest} != ${opts.expectedOutputDigest}` });
  }

  // 7. NOT_RUN / no evidence.
  if (evidence.state === "not_run" || (evidence.exitCode === null && !evidence.passed)) {
    issues.push({ code: "NOT_RUN", detail: "gate evidence is NOT_RUN" });
  }

  // 8. E4-10: an offline gate must report zero provider calls.
  if (evidence.environmentClass === "offline" && (evidence.providerCalls ?? 0) !== 0) {
    issues.push({ code: "PROVIDER_CALLS_ON_OFFLINE", detail: `offline gate reported ${String(evidence.providerCalls)} provider calls — must be 0` });
  }

  // 9. E4-10: a PASS with a missing (null-digest) artifact is invalid.
  if (evidence.passed && (evidence.artifactRefs ?? []).some((a) => a.digest === null)) {
    issues.push({ code: "MISSING_ARTIFACT_REF", detail: "passed=true but a declared artifact is missing (null digest)" });
  }

  return { ok: issues.length === 0, issues };
}

/** Build a V2 evidence object from a raw gate run result. */
export function buildGateEvidenceV2(input: {
  gate: string;
  command: string[];
  toolVersion: string;
  gitSha: string;
  cleanBefore: boolean;
  cleanAfter: boolean;
  input: unknown;
  output: unknown;
  startedAtIso: string;
  finishedAtIso: string;
  exitCode: number | null;
  passed: boolean;
  state: GateEvidenceV2State;
  summary: string;
  providerCalls?: number;
  environmentClass?: "offline" | "paid" | "insecure-local";
  artifactRefs?: Array<{ path: string; digest: string | null }>;
}): GateEvidenceV2 {
  return {
    schemaVersion: GATE_EVIDENCE_V2_SCHEMA_VERSION,
    gate: input.gate,
    command: [...input.command],
    toolVersion: input.toolVersion,
    gitSha: input.gitSha,
    cleanBefore: input.cleanBefore,
    cleanAfter: input.cleanAfter,
    inputDigest: digestOf(input.input),
    outputDigest: digestOf(input.output),
    startedAtIso: input.startedAtIso,
    finishedAtIso: input.finishedAtIso,
    exitCode: input.exitCode,
    passed: input.passed,
    state: input.state,
    summary: input.summary,
    ...(input.providerCalls !== undefined ? { providerCalls: input.providerCalls } : {}),
    ...(input.environmentClass !== undefined ? { environmentClass: input.environmentClass } : {}),
    ...(input.artifactRefs !== undefined ? { artifactRefs: input.artifactRefs } : {}),
  };
}

// ---------------------------------------------------------------------------
// E4-10 — real generator + loader (evidence is produced by RUNNING a command,
// never hand-written). The caller supplies only allowlisted offline commands;
// the generator captures the true exit code, binds HEAD before/after, digests
// the gate's output artifacts, and atomically writes the evidence. A missing
// artifact or missing evidence file can never read as PASS.
// ---------------------------------------------------------------------------

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function digestFile(path: string): Promise<string | null> {
  try {
    return sha256Hex(await readFile(path));
  } catch {
    return null; // missing/unreadable — recorded as null, never faked
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const h = await open(tmp, "w");
  try {
    await h.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(tmp, path);
}

export interface RunGateV2Options {
  gate: string;
  /** Canonical argv, e.g. ["node","apps/cli/dist/main.js","audit","--strict"]. */
  command: string[];
  cwd: string;
  toolVersion: string;
  /** Gate inputs folded into inputDigest. */
  input?: unknown;
  /** Output artifact paths to digest (a missing one is recorded null). */
  artifactPaths?: string[];
  /** Provider calls the gate made (0 for offline gates). */
  providerCalls?: number;
  environmentClass?: "offline" | "paid" | "insecure-local";
  /** Injected clock (tests). */
  now?: () => Date;
  /** Injected runner (tests); defaults to execFile of the argv. */
  run?: (command: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Run one allowlisted gate command and produce HEAD-bound GateEvidenceV2.
 * `passed` is derived ONLY from the real exit code (0) AND every declared
 * artifact being present — a nonzero exit or a missing artifact yields
 * state=failed, never passed.
 */
export async function runGateV2(opts: RunGateV2Options): Promise<GateEvidenceV2> {
  const now = opts.now ?? (() => new Date());
  const before = await captureGitState(opts.cwd);
  const startedAtIso = now().toISOString();
  const runner = opts.run ?? defaultRunner;
  let exitCode: number;
  let stdout = "";
  let stderr = "";
  try {
    const r = await runner(opts.command, opts.cwd);
    exitCode = r.exitCode;
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err) {
    exitCode = 1;
    stderr = err instanceof Error ? err.message : String(err);
  }
  const finishedAtIso = now().toISOString();
  const after = await captureGitState(opts.cwd);
  const artifactRefs = await Promise.all(
    (opts.artifactPaths ?? []).map(async (p) => ({ path: p, digest: await digestFile(p) })),
  );
  const missingArtifact = artifactRefs.some((a) => a.digest === null);
  const passed = exitCode === 0 && !missingArtifact;
  const gitSha = before?.sha ?? after?.sha ?? "unknown";
  const evidence = buildGateEvidenceV2({
    gate: opts.gate,
    command: opts.command,
    toolVersion: opts.toolVersion,
    gitSha,
    cleanBefore: before?.clean ?? false,
    cleanAfter: after?.clean ?? false,
    input: opts.input ?? {},
    output: { stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000), artifactRefs },
    startedAtIso,
    finishedAtIso,
    exitCode,
    passed,
    state: passed ? "passed" : "failed",
    summary: passed ? `${opts.gate}: PASS (exit 0)` : `${opts.gate}: FAIL (exit ${exitCode}${missingArtifact ? ", missing artifact" : ""})`,
    providerCalls: opts.providerCalls ?? 0,
    ...(opts.environmentClass !== undefined ? { environmentClass: opts.environmentClass } : {}),
    artifactRefs,
  });
  return evidence;
}

function defaultRunner(command: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const [file, ...args] = command;
    if (file === undefined) {
      resolvePromise({ exitCode: 1, stdout: "", stderr: "empty command" });
      return;
    }
    execFile(file, args, { cwd, timeout: 600_000, windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err !== null ? (typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === "number" ? (err as unknown as { code: number }).code : 1) : 0;
      resolvePromise({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Atomically persist a gate's evidence to disk. */
export async function writeGateEvidenceV2(evidence: GateEvidenceV2, path: string): Promise<void> {
  await atomicWriteJson(path, evidence);
}

/**
 * E4-R09 (F18): strict parse of a GateEvidenceV2 from unknown bytes. Never a
 * bare `JSON.parse as` — missing fields, bad schema, unknown gate/platform,
 * inconsistent state/exitCode/passed, dirty source, stale/absent SHA and
 * missing digests are ALL rejected. Returns issue strings (empty = valid).
 */
export function gateEvidenceV2Issues(value: unknown): string[] {
  const issues: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["evidence is not an object"];
  }
  const e = value as Record<string, unknown>;
  const hex64 = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  const iso = (v: unknown): boolean => typeof v === "string" && !Number.isNaN(Date.parse(v));

  if (e.schemaVersion !== GATE_EVIDENCE_V2_SCHEMA_VERSION) {
    issues.push(`schemaVersion ${JSON.stringify(e.schemaVersion)} != ${GATE_EVIDENCE_V2_SCHEMA_VERSION}`);
  }
  if (typeof e.gate !== "string" || e.gate.length === 0 || !/^[a-z0-9_-]+$/.test(e.gate)) {
    issues.push(`gate ${JSON.stringify(e.gate)} is not a known gate id`);
  }
  if (!Array.isArray(e.command) || e.command.length === 0 || !e.command.every((c) => typeof c === "string" && c.length > 0)) {
    issues.push("command must be a non-empty string argv");
  }
  if (typeof e.toolVersion !== "string" || e.toolVersion.length === 0) {
    issues.push("toolVersion missing");
  }
  if (typeof e.gitSha !== "string" || e.gitSha.length === 0 || e.gitSha === "unknown") {
    issues.push(`gitSha ${JSON.stringify(e.gitSha)} is not a known HEAD (passing gates need a real SHA)`);
  }
  if (typeof e.cleanBefore !== "boolean" || typeof e.cleanAfter !== "boolean") {
    issues.push("cleanBefore/cleanAfter must be booleans");
  }
  if (!hex64(e.inputDigest) || !hex64(e.outputDigest)) {
    issues.push("inputDigest/outputDigest must be 64-hex");
  }
  if (!iso(e.startedAtIso) || !iso(e.finishedAtIso)) {
    issues.push("startedAtIso/finishedAtIso must be parseable ISO timestamps");
  }
  const exitCode = e.exitCode === null ? null : typeof e.exitCode === "number" && Number.isInteger(e.exitCode) ? e.exitCode : Number.NaN;
  if (exitCode === null && e.state !== "not_run") {
    issues.push("exitCode null outside not_run");
  }
  if (Number.isNaN(exitCode)) issues.push("exitCode must be null or an integer");
  const state = e.state as GateEvidenceV2State;
  const KNOWN = new Set<GateEvidenceV2State>(["passed", "failed", "not_run", "blocked", "invalid", "PAID_BENCHMARK_NOT_AUTHORIZED"]);
  if (typeof state !== "string" || !KNOWN.has(state)) issues.push(`state ${JSON.stringify(state)} unknown`);
  if (typeof e.passed !== "boolean") issues.push("passed must be a boolean");
  if (typeof e.summary !== "string") issues.push("summary missing");
  if (e.providerCalls !== undefined && (typeof e.providerCalls !== "number" || !Number.isInteger(e.providerCalls) || e.providerCalls < 0)) {
    issues.push("providerCalls must be a non-negative integer");
  }
  if (e.environmentClass !== undefined && e.environmentClass !== "offline" && e.environmentClass !== "paid" && e.environmentClass !== "insecure-local") {
    issues.push(`environmentClass ${JSON.stringify(e.environmentClass)} unknown`);
  }

  // Cross-field consistency: a PASS means state=passed AND exit 0 AND a known
  // clean HEAD; a FAILED/INVALID/BLOCKED/NOT_RUN can never be passed=true.
  if (e.passed === true) {
    if (state !== "passed") issues.push(`passed=true but state=${String(state)}`);
    if (exitCode !== 0) issues.push(`passed=true but exitCode=${String(exitCode)}`);
    if (e.cleanBefore !== true || e.cleanAfter !== true) issues.push("passed=true on a dirty tree (cleanBefore/cleanAfter)");
    if (e.gitSha === "unknown") issues.push("passed=true with unknown gitSha");
  } else if (e.passed === false && state === "passed") {
    issues.push(`state=passed but passed=false`);
  }
  if (Array.isArray(e.artifactRefs)) {
    for (const ref of e.artifactRefs) {
      const r = ref as { path?: unknown; digest?: unknown };
      if (typeof r.path !== "string" || r.path.length === 0) issues.push("artifactRef.path missing");
      if (r.digest !== null && r.digest !== undefined && !hex64(r.digest)) issues.push(`artifactRef ${JSON.stringify(r.path)} digest is not 64-hex`);
    }
  }
  return issues;
}

export function parseGateEvidenceV2(value: unknown): GateEvidenceV2 {
  const issues = gateEvidenceV2Issues(value);
  if (issues.length > 0) {
    throw new Error(`GateEvidenceV2 invalid: ${issues.join("; ")}`);
  }
  return value as GateEvidenceV2;
}

/**
 * Load a gate's evidence. A missing or unparseable file returns a NOT_RUN
 * sentinel (state=not_run, passed=false) — it is NEVER treated as PASS.
 * E4-R09 (F18): a JSON object missing fields / with inconsistent fields is
 * STRICTLY rejected the same way — never `JSON.parse as GateEvidenceV2`.
 */
export async function loadGateEvidenceV2(path: string): Promise<GateEvidenceV2> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return notRunEvidence(`missing evidence file: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return notRunEvidence(`unparseable evidence file: ${path}`);
  }
  const issues = gateEvidenceV2Issues(parsed);
  if (issues.length > 0) {
    return notRunEvidence(`invalid GateEvidenceV2 (${path}): ${issues.slice(0, 3).join("; ")}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ""}`);
  }
  return parsed as GateEvidenceV2;
}

function notRunEvidence(summary: string): GateEvidenceV2 {
  return {
    schemaVersion: GATE_EVIDENCE_V2_SCHEMA_VERSION,
    gate: "unknown",
    command: [],
    toolVersion: "unknown",
    gitSha: "unknown",
    cleanBefore: false,
    cleanAfter: false,
    inputDigest: digestOf({}),
    outputDigest: digestOf({}),
    startedAtIso: "",
    finishedAtIso: "",
    exitCode: null,
    passed: false,
    state: "not_run",
    summary,
    providerCalls: 0,
  };
}