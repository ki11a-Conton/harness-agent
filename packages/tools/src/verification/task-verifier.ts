import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AgentErrorInfo,
  SessionId,
  TaskSpec,
  VerificationContext,
  VerificationResult,
  VerificationSpec,
  Verifier,
} from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { matchGlob } from "@ar/security";
import { ProcessExecutor } from "../process/executor.js";

export interface TaskVerifierDeps {
  executor?: ProcessExecutor;
  /** P8-2: per-step evidence callback (verification.step_started /
   *  verification.step_completed in the runtime). Receives the stable step
   *  ref so subagent testsRun and reports can reference it, plus the session
   *  id so the host can attribute the event without another lookup. */
  onStep?: (event: {
    ref: string;
    phase: "started" | "completed";
    kind: string;
    description: string;
    passed?: boolean;
    detail?: string;
    sessionId?: SessionId;
  }) => void;
}

/**
 * TaskVerifier (VS-001): executes the verification specs of a TaskSpec.
 *
 * - command    → runs the command; pass = exit code 0 (uses ProcessExecutor)
 * - artifact   → pass = file exists (and, for mustChange, appeared in changedPaths)
 * - requirement→ cannot be verified automatically; fails closed until a model
 *                reviewer is wired (documented limitation, no fake passes).
 *
 * The verifier is a pure service: no permission/sandbox short-circuits here;
 * commands are expected to arrive pre-authorized from the agent runtime.
 */
export class TaskVerifier implements Verifier {
  private readonly executor: ProcessExecutor;

  private readonly onStep?: TaskVerifierDeps["onStep"];

  constructor(deps: TaskVerifierDeps = {}) {
    this.executor = deps.executor ?? new ProcessExecutor();
    this.onStep = deps.onStep;
  }

  /** cwd-relative POSIX-style path for glob matching. */
  private rel = (p: string, cwd: string): string =>
    relative(cwd, isAbsolute(p) ? p : resolve(cwd, p)).split(sep).join("/");

  async verify(task: TaskSpec, context: VerificationContext): Promise<VerificationResult> {
    const startedAt = Date.now();
    const specs = task.verification ?? [];
    const checks = await Promise.all(specs.map((spec) => this.runCheck(spec, context)));
    const passed = checks.length > 0 && checks.every((c) => c.passed);

    return {
      level: checks.length === 0 ? 0 : passed ? 3 : 1,
      passed,
      checks,
      evidence: checks.filter((c) => c.evidence !== undefined).map((c) => c.evidence!),
      startedAt,
      completedAt: Date.now(),
    };
  }

  private async runCheck(spec: VerificationSpec, context: VerificationContext) {
    // P8-2: every step is observable with a stable ref; started fires before
    // the work, completed carries the outcome. Subagent testsRun references
    // these refs.
    const ref = `verification.step:${spec.kind}:${"command" in spec ? spec.command : "path" in spec ? spec.path : "statement" in spec ? spec.statement : "?"}`;
    this.onStep?.({
      ref,
      phase: "started",
      kind: spec.kind,
      description: spec.description ?? spec.kind,
      sessionId: context.sessionId,
    });
    const check = await (() => {
      switch (spec.kind) {
        case "command":
          return this.checkCommand(spec, context);
        case "artifact":
          return this.checkArtifact(spec, context);
        case "requirement":
          return this.checkRequirement(spec);
        case "diff":
          return this.checkDiff(spec, context);
      }
    })();
    this.onStep?.({
      ref,
      phase: "completed",
      kind: spec.kind,
      description: spec.description ?? spec.kind,
      passed: check.passed,
      detail: check.evidence?.description,
      sessionId: context.sessionId,
    });
    return check;
  }

  /** P1-14: diff check — expected change set vs. unexpected destructive edits.
   *  Paths are matched the same way artifact checks match (cwd-relative,
   *  normalized, case-insensitive on case-insensitive filesystems). */
  private checkDiff(
    spec: Extract<VerificationSpec, { kind: "diff" }>,
    context: VerificationContext,
  ): VerificationResult["checks"][number] {
    const description = spec.description ?? "diff: expected change set";
    const rel = (p: string): string => (isAbsolute(p) ? p : resolve(context.cwd, p));
    const touched = new Set(context.changedPaths.map((p) => normalize(rel(p))));
    const missing = (spec.expectedPaths ?? []).filter((p) => !touched.has(normalize(rel(p))));
    const unexpected = (spec.mustNotChange ?? []).filter((p) => touched.has(normalize(rel(p))));
    const reasons: string[] = [];
    if (missing.length > 0) reasons.push(`expected changes not made: ${missing.join(", ")}`);
    if (unexpected.length > 0) reasons.push(`unexpected/destructive changes: ${unexpected.join(", ")}`);
    // P1-16: content-aware diff checks.
    if (spec.maxFiles !== undefined && context.changedPaths.length > spec.maxFiles) {
      reasons.push(`too many files changed (${context.changedPaths.length} > ${spec.maxFiles}) — possible accidental rewrite`);
    }
    const forbiddenHits = (spec.forbidPatterns ?? []).flatMap((pattern) =>
      context.changedPaths.filter((p) => matchGlob(pattern, this.rel(p, context.cwd))),
    );
    if (forbiddenHits.length > 0) {
      reasons.push(`forbidden paths changed (generated junk / format explosion): ${[...new Set(forbiddenHits)].join(", ")}`);
    }
    if (spec.forbidDeletions === true || Array.isArray(spec.forbidDeletions)) {
      const baseline = context.baselineFiles ?? [];
      const guarded = Array.isArray(spec.forbidDeletions) ? spec.forbidDeletions : baseline;
      const deleted = guarded.filter((p) => {
        try {
          realpathSync(rel(p));
          return false;
        } catch {
          return !existsSync(rel(p));
        }
      });
      if (deleted.length > 0) reasons.push(`unexpected file deletion: ${deleted.join(", ")}`);
    }
    const ok = reasons.length === 0;
    const detail =
      ok
        ? `change set matches expectation (${(spec.expectedPaths ?? []).length} expected, ${(spec.mustNotChange ?? []).length} forbidden)`
        : reasons.join("; ");
    return {
      id: `diff:${description.slice(0, 60)}`,
      kind: "diff",
      description,
      passed: ok,
      evidence: {
        type: "diff",
        description: detail,
        source: context.cwd,
        timestamp: Date.now(),
      },
      ...(!ok
        ? { error: this.err("VERIFICATION_FAILED", `diff check failed: ${detail}`) }
        : {}),
    };
  }

  private async checkCommand(
    spec: Extract<VerificationSpec, { kind: "command" }>,
    context: VerificationContext,
  ): Promise<VerificationResult["checks"][number]> {
    const description = spec.description ?? `command: ${spec.command}`;
    try {
      // P8-1: args are shell-quoted so planned commands with spaces/braces
      // (e.g. `node -e "process.exit(0)"` split by the plan builder) survive
      // the /bin/sh -c assembly. POSIX single-quote escaping; cmd.exe stays
      // best-effort (verification commands are normally plain tool invocations).
      const argString = (spec.args ?? []).map(shellQuote).join(" ");
      const command = argString.length > 0 ? `${spec.command} ${argString}` : spec.command;
      const outcome = await this.executor.run({
        command,
        cwd: context.cwd,
        timeoutMs: 120_000,
        maxOutputBytes: 1_048_576,
      });
      return {
        id: `command:${spec.command}`,
        kind: "command",
        description,
        passed: outcome.status === "success",
        evidence: {
          type: "test",
          description: `exit code ${outcome.exitCode} in ${outcome.durationMs}ms`,
          source: spec.command,
          timestamp: Date.now(),
        },
        ...(outcome.status === "success"
          ? {}
          : { error: this.err("VERIFICATION_FAILED", `${spec.command}: ${outcome.error ?? `exit ${outcome.exitCode}`}`) }),
      };
    } catch (err) {
      return {
        id: `command:${spec.command}`,
        kind: "command",
        description,
        passed: false,
        error: this.err("VERIFICATION_FAILED", err instanceof Error ? err.message : String(err)),
      };
    }
  }

  private checkArtifact(
    spec: Extract<VerificationSpec, { kind: "artifact" }>,
    context: VerificationContext,
  ): VerificationResult["checks"][number] {
    const description = spec.description ?? `artifact: ${spec.path}`;
    const abs = isAbsolute(spec.path) ? spec.path : resolve(context.cwd, spec.path);
    let exists = false;
    try {
      realpathSync(abs);
      exists = true;
    } catch {
      exists = existsSync(abs);
    }
    const touched = changedPathsContain(context.changedPaths, abs, context.cwd);
    const ok = exists && (spec.mustChange !== true || touched);
    let error: AgentErrorInfo | undefined;
    if (!ok) {
      error = this.err("VERIFICATION_FAILED", `artifact ${spec.path} ${!exists ? "does not exist" : "was not changed"}`);
    }
    return {
      id: `artifact:${spec.path}`,
      kind: "artifact",
      description,
      passed: ok,
      evidence: {
        type: "file",
        description: ok ? `found ${abs}` : `missing ${abs}`,
        source: abs,
        timestamp: Date.now(),
      },
      ...(error !== undefined ? { error } : {}),
    };
  }

  private checkRequirement(
    spec: Extract<VerificationSpec, { kind: "requirement" }>,
  ): VerificationResult["checks"][number] {
    return {
      id: `requirement:${spec.statement.slice(0, 60)}`,
      kind: "requirement",
      description: spec.description ?? `requirement: ${spec.statement}`,
      passed: false,
      error: this.err("VERIFICATION_FAILED", "requirement checks require a model reviewer (not yet wired); failing closed"),
    };
  }

  private err(code: "VERIFICATION_FAILED", message: string): AgentErrorInfo {
    return errorInfo(code, message);
  }
}

function changedPathsContain(changedPaths: string[], abs: string, cwd: string): boolean {
  const normAbs = normalize(abs);
  return changedPaths.some((p) => {
    const candidate = normalize(isAbsolute(p) ? p : resolve(cwd, p));
    return candidate === normAbs;
  });
}

function normalize(p: string): string {
  return p.split(sep).join("/").toLowerCase();
}

/** POSIX single-quote escaping (best-effort on cmd.exe). */
function shellQuote(arg: string): string {
  if (!/[\s'"\\$`(){};*?[\]<>|&!]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}