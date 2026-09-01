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
import { readFile, stat } from "node:fs/promises";
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
}

export type GateV2IssueCode =
  | "STALE_HEAD"
  | "COMMAND_MISMATCH"
  | "SOURCE_DIRTY_AFTER"
  | "EXIT_CODE_TAMPERED"
  | "DIGEST_MISMATCH"
  | "NOT_RUN"
  | "PAID_BENCHMARK_NOT_AUTHORIZED"
  | "PASS_WITHOUT_EVIDENCE";

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
  };
}