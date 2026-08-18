import type {
  AgentErrorInfo,
  Message,
  SessionId,
  SessionStore,
  TaskSpec,
  TurnId,
  Verifier,
  VerificationContext,
  VerificationResult,
} from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";

/**
 * VERIFY-001: runtime-side verification gate (independent integration segment).
 *
 * Responsibilities:
 * - Pull history via store.listMessages(sessionId) and render a compact
 *   transcript: one "[role] content" line per message, per-message truncation
 *   (messageTruncate) plus a hard overall cap (maxTranscriptChars).
 * - Assemble VerificationContext (sessionId / turnId / cwd / changedPaths /
 *   transcript / runStartedAt) and delegate to the wrapped Verifier.
 * - Fail closed: any exception escaping verifier.verify becomes a
 *   "blocked" gate with a synthetic review check carrying an
 *   INTERNAL_ERROR AgentErrorInfo; errors are never swallowed as passes.
 *
 * Design decision — no short-circuit on empty task.verification:
 * TaskVerifier (VS-001) returns a deterministic level-0 / passed=false result
 * for absent or empty specs, so delegating unconditionally keeps every turn on
 * the same code path (uniform coverage) instead of special-casing callers.
 */
export interface RuntimeVerifierOptions {
  cwd: string;
  runStartedAt: number;
  /** Paths the agent touched during the run (collected by the runtime). */
  changedPaths: string[];
  /** Workspace file inventory at run start (for deletion detection). */
  baselineFiles?: string[];
  /** Transcript render cap for the whole turn history. Default 16_000. */
  maxTranscriptChars?: number;
  /** Per-message content cap in the rendered transcript. Default 1_000. */
  messageTruncate?: number;
}

export type GateStatus = "passed" | "failed" | "blocked";

export interface VerificationGate {
  status: GateStatus;
  result: VerificationResult;
  /** Human-readable explanation; for failed/blocked this carries the cause. */
  reason: string;
}

export class RuntimeVerifier {
  constructor(private readonly verifier: Verifier) {}

  async verifyTurn(
    task: TaskSpec,
    sessionId: SessionId,
    turnId: TurnId | undefined,
    store: SessionStore,
    opts: RuntimeVerifierOptions,
  ): Promise<VerificationGate> {
    const maxTranscriptChars = opts.maxTranscriptChars ?? 16_000;
    const messageTruncate = opts.messageTruncate ?? 1_000;

    const messages = await store.listMessages(sessionId);
    const transcript = renderTranscript(messages, { maxChars: maxTranscriptChars, messageTruncate });

    const context: VerificationContext = {
      sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
      cwd: opts.cwd,
      changedPaths: opts.changedPaths,
      ...(opts.baselineFiles !== undefined ? { baselineFiles: opts.baselineFiles } : {}),
      transcript,
      runStartedAt: opts.runStartedAt,
    };

    const startedAt = Date.now();
    let result: VerificationResult;
    let blocked: AgentErrorInfo | undefined;

    try {
      result = await this.verifier.verify(task, context);
      // TaskVerifier fills startedAt/completedAt itself; fill defaults only
      // when the wrapped verifier omitted them (keeps VS-001 timestamps intact).
      if (!isFinite(result.startedAt)) result.startedAt = startedAt;
      if (!isFinite(result.completedAt)) result.completedAt = Date.now();
    } catch (err) {
      // Fail closed: the gate is "blocked", never a silent pass.
      const message = err instanceof AgentError ? err.info.message : err instanceof Error ? err.message : String(err);
      blocked = errorInfo("INTERNAL_ERROR", `verifier failed: ${message}`);
      result = {
        level: 0,
        passed: false,
        checks: [
          {
            id: "verifier:error",
            kind: "review",
            description: "verifier raised an internal error",
            passed: false,
            error: blocked,
          },
        ],
        evidence: [],
        startedAt,
        completedAt: Date.now(),
      };
    }

    if (blocked !== undefined) {
      return { status: "blocked", result, reason: buildReason(result) };
    }
    return { status: result.passed ? "passed" : "failed", result, reason: buildReason(result) };
  }
}

/** One "[role] content" line per message; per-line cap then overall cap. */
function renderTranscript(
  messages: Message[],
  opts: { maxChars: number; messageTruncate: number },
): string {
  const parts: string[] = [];
  let used = 0;
  for (const m of messages) {
    const line = `[${m.role}] ${truncate(m.content, opts.messageTruncate)}`;
    const separator = used > 0 ? 1 : 0;
    if (used + separator + line.length > opts.maxChars) {
      const remaining = opts.maxChars - used - separator;
      if (remaining > 0) parts.push(truncate(line, remaining));
      break;
    }
    used += separator + line.length;
    parts.push(line);
  }
  return parts.join("\n");
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** "<description>: <error message>" per failed check; fallback to level. */
function buildReason(result: VerificationResult): string {
  const failed = result.checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    return failed.map((c) => `${c.description}: ${c.error?.message ?? "check did not pass"}`).join("; ");
  }
  if (result.passed) return "all checks passed";
  return `verification failed at level ${result.level} (no failed check detail)`;
}