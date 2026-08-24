import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalId,
  ApprovalStore,
  EventStore,
  MemoryStore,
  Session,
  SessionId,
  SessionStore,
} from "@ar/contracts";
import { AgentError } from "@ar/contracts";
import type { TurnOutcome } from "@ar/core";
import type { RpcContext, AgentSummary } from "@ar/gateway";
import type { HarnessConfig, HarnessIntrospection, LearningCandidateStore, ResolvedConfig } from "@ar/harness";
import type { SessionService } from "@ar/session";
import type { DoctorDeps } from "./doctor.js";
import { runChecks } from "./doctor.js";
import { mechanismsCmd, validateMechanismManifest } from "./mechanisms.js";
import { experimentCmd } from "./experiment-command.js";
import { auditCmd } from "./audit.js";
import { renderDocsVerification, verifyDocs } from "./docs-verify.js";
import type { EvalMode } from "@ar/evaluation";
import { runChampionEval } from "./champion-eval.js";
import { renderProductionAudit, runProductionAudit } from "./production-audit.js";
import { collectReleaseArtifacts, renderReleaseArtifacts } from "./release-artifacts.js";
import { learnCmd } from "./learn-command.js";
import { explainCmd } from "./explain-command.js";
import { recoverListCmd } from "./recover-command.js";
import { configExplainCmd } from "./config-command.js";

/** Minimal RPC client surface (InMemoryTransport matches structurally). */
export interface RpcClient {
  request(method: string, params?: unknown, ctx?: RpcContext): Promise<unknown>;
}

/** Everything a command may touch; injectable for tests (CLI-001). */
export interface CommandDeps {
  /** The only route to the runtime (plan §161): session.* / agent.list /
   *  tool.list / skill.list / trace.get. */
  rpc: RpcClient;
  /** Direct store reads for commands with no RPC method (sessions, trace). */
  store: SessionStore;
  events: EventStore;
  sessionService: SessionService;
  approvalStore: ApprovalStore;
  doctor: DoctorDeps;
  /** Host wiring facts reported by the composition root (P0-1 audit). */
  introspection: HarnessIntrospection;
  /** P2-7: learning-candidate queue (reflection output, pre-promotion). */
  candidates?: LearningCandidateStore;
  /** P2-7: memory store the promotion writes into. */
  memoryStore?: MemoryStore;
  /** P12-3: durable ask-user store (pending asks recovery scan). */
  askUserStore?: import("@ar/contracts").AskUserStore;
  /** P12-3: durable checkpoint store (unfinished checkpoints recovery scan). */
  checkpointStore?: import("@ar/contracts").CheckpointStore;
  /** P27-2/5: the resolved config stack (layers + per-key origins +
   *  fingerprint) for `agent config explain`. */
  resolvedConfig?: ResolvedConfig<HarnessConfig>;
}

export interface CommandResult {
  exitCode: number;
  lines: string[];
}

export const USAGE = `usage: agent <command> [args]

commands:
  run <cwd> <text>                  create a session, run a turn, print the structured outcome (plan §173)
  resume <sessionId>                print session state
  cancel <sessionId> <turnId>       cancel a running turn
  approve <approvalId> <allow|deny> resolve a pending approval
  agents                            list registered agents
  tools                             list registered tools
  skills                            list discovered skills
  sessions                          list sessions
  benchmark [flags]                 run the fixed benchmark suite and freeze a baseline (plan.md Phase 1)
  trace <sessionId> <outputDir>     export an episode package (plan §77)
  doctor                            run environment checks (plan §87)
  mechanisms <path>                 validate mechanism manifests (P2-8)
  experiment <config.json>          run a mechanism experiment (P2-9)
  audit [--json] [--out <dir>]      generate CAPABILITY_MATRIX.md/.json from real wiring evidence (P0-1)
  docs:verify                       machine-verify doc facts (benchmark counts, packages, CI gates, matrix) (P20-3)
  explain <sessionId> [--tool-call <id>] [--tree]  why did the agent do this? observable evidence / trace tree (P9-3/P20-6)
  champion eval <baseline-runs.json> <candidate-runs.json> [--mode stub|real-model]
                                    paired evaluation of baseline vs candidate over the SAME cases (P21-3)
  production-audit                 P22-3 final production audit (silent catch / as never / path gates / retry / isolation)
  release artifacts [--out <dir>]  P22-4 collect release artifacts (reports/coverage/CI/benchmark/paired/matrix/manifest)
  recover list                         startup recovery scan — unfinished sessions/approvals/asks/orphans (P12-3)
  config explain [key]                explain effective config: per-key origin + lifecycle, no secrets (P27-5)
  learn candidates|evaluate <id>|promote <id>|reevaluate
                                    learning-candidate lifecycle — reflection queues, explicit promotion only (P2-7)`;

/** Dispatch `agent <command> [args]`. argv excludes the program and "agent". */
export async function runCommand(argv: string[], deps: CommandDeps): Promise<CommandResult> {
  const [command, ...rest] = argv;
  switch (command) {
    case "run":
      return runCmd(rest, deps);
    case "resume":
      return resumeCmd(rest, deps);
    case "cancel":
      return cancelCmd(rest, deps);
    case "approve":
      return approveCmd(rest, deps);
    case "agents":
      return agentsCmd(deps);
    case "tools":
      return toolsCmd(deps);
    case "skills":
      return skillsCmd(deps);
    case "sessions":
      return sessionsCmd(deps);
    case "benchmark":
      return benchmarkCmd(rest);
    case "trace":
      return traceCmd(rest, deps);
    case "doctor":
      return doctorCmd(deps);
    case "mechanisms":
      return mechanismsCmd(rest);
    case "experiment":
      return experimentCmd(rest);
    case "audit":
      return auditCmd(rest, deps);
    case "release": {
      if (rest[0] !== "artifacts") {
        return { exitCode: 1, lines: ["usage: agent release artifacts [--out <dir>]"] };
      }
      const outIdx = rest.indexOf("--out");
      const outDir = outIdx >= 0 ? rest[outIdx + 1] ?? ".ci/release-artifacts" : ".ci/release-artifacts";
      const result = await collectReleaseArtifacts({ root: process.cwd(), outDir });
      return { exitCode: result.ok ? 0 : 1, lines: renderReleaseArtifacts(result) };
    }
    case "production-audit": {
      const result = runProductionAudit({ root: process.cwd() });
      return { exitCode: result.ok ? 0 : 1, lines: renderProductionAudit(result) };
    }
    case "champion": {
      if (rest[0] !== "eval") {
        return { exitCode: 1, lines: ["usage: agent champion eval <baseline-runs.json> <candidate-runs.json> [--mode stub|real-model]"] };
      }
      const files = rest.slice(1).filter((a) => !a.startsWith("--"));
      const modeIdx = rest.indexOf("--mode");
      const mode: EvalMode = modeIdx >= 0 && rest[modeIdx + 1] === "real-model" ? "real-model" : "stub";
      if (files.length < 2) {
        return { exitCode: 1, lines: ["usage: agent champion eval <baseline-runs.json> <candidate-runs.json> [--mode stub|real-model]"] };
      }
      try {
        const { lines } = await runChampionEval({ baselinePath: files[0]!, candidatePath: files[1]!, mode });
        return { exitCode: 0, lines };
      } catch (err) {
        return { exitCode: 1, lines: [`champion eval failed: ${err instanceof Error ? err.message : String(err)}`] };
      }
    }
    case "docs:verify": {
      const result = await verifyDocs({ root: process.cwd() });
      return { exitCode: result.ok ? 0 : 1, lines: renderDocsVerification(result) };
    }
    case "explain": {
      const sessionId = rest[0] as SessionId | undefined;
      if (sessionId === undefined) {
        return { exitCode: 1, lines: ["usage: agent explain <sessionId> [--tool-call <id>]"] };
      }
      const toolIdx = rest.indexOf("--tool-call");
      const toolCallId = toolIdx >= 0 ? rest[toolIdx + 1] : undefined;
      // P20-6: `agent explain <sessionId> --tree` also renders the full trace tree.
      const showTree = rest.includes("--tree");
      return explainCmd(
        { sessionId, ...(toolCallId !== undefined ? { toolCallId } : {}), ...(showTree ? { tree: true } : {}) },
        deps.events,
      );
    }
    case "recover": {
      if (rest[0] !== "list") {
        return { exitCode: 1, lines: ["usage: agent recover list"] };
      }
      const result = await recoverListCmd({
        store: deps.store,
        approvalStore: deps.approvalStore,
        ...(deps.askUserStore !== undefined ? { askUserStore: deps.askUserStore } : {}),
        ...(deps.checkpointStore !== undefined ? { checkpointStore: deps.checkpointStore } : {}),
      });
      return { exitCode: result.exitCode, lines: result.lines };
    }
    case "learn":
      if (deps.candidates === undefined) {
        return { exitCode: 1, lines: ["learn: no learning pipeline wired (harness learning/memory is disabled)"] };
      }
      return learnCmd(rest, {
        candidates: deps.candidates,
        ...(deps.memoryStore !== undefined ? { memoryStore: deps.memoryStore } : {}),
      });
    case "config": {
      if (rest[0] !== "explain") {
        return { exitCode: 1, lines: ["usage: agent config explain [key]", "", USAGE] };
      }
      if (deps.resolvedConfig === undefined) {
        return { exitCode: 1, lines: ["config explain: no resolved config wired (host did not expose it)"] };
      }
      return configExplainCmd(rest[1], { resolvedConfig: deps.resolvedConfig });
    }
    default:
      return { exitCode: 1, lines: [`unknown command: ${command ?? "(none)"}`, "", USAGE] };
  }
}

async function runCmd(rest: string[], deps: CommandDeps): Promise<CommandResult> {
  const [cwd, text] = rest;
  if (cwd === undefined || text === undefined) {
    return { exitCode: 1, lines: ["agent run: expected <cwd> <text>", "", USAGE] };
  }
  try {
    const agents = (await deps.rpc.request("agent.list")) as AgentSummary[];
    if (agents.length === 0) {
      return { exitCode: 1, lines: ["agent run: no agents registered"] };
    }
    const session = (await deps.rpc.request("session.create", {
      agentId: agents[0]!.id,
      cwd,
    })) as Session;
    const { turnId } = (await deps.rpc.request("session.send", {
      sessionId: session.id,
      text,
    })) as { turnId: string };
    const outcome = (await deps.rpc.request("session.run", {
      sessionId: session.id,
      turnId,
    })) as TurnOutcome;

    const events = await deps.events.list(session.id);
    const messages = await deps.store.listMessages(session.id);
    const summary = [...messages]
      .reverse()
      .find((m) => m.role === "assistant")?.content ?? "(no assistant text)";
    const files = outcome.state?.filesChanged ?? [];
    const verification = verificationLine(events);
    const issues =
      outcome.status === "completed"
        ? "(none)"
        : `${outcome.status}${outcome.error !== undefined ? `: ${outcome.error.code} — ${outcome.error.message}` : ""}`;

    return {
      exitCode: outcome.status === "completed" ? 0 : 1,
      lines: [
        `run: session ${session.id} turn ${turnId}`,
        `status: ${outcome.status}`,
        `summary: ${summary}`,
        `files changed: ${files.length === 0 ? "(none)" : files.join(", ")}`,
        `tests: ${verification}`,
        `verification: ${verification}`,
        `remaining issues: ${issues}`,
        `tool calls: ${outcome.toolCalls}`,
        `iterations: ${outcome.iterations}`,
      ],
    };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent run", err)] };
  }
}

async function resumeCmd(rest: string[], deps: CommandDeps): Promise<CommandResult> {
  const [sessionId] = rest;
  if (sessionId === undefined) {
    return { exitCode: 1, lines: ["agent resume: expected <sessionId>", "", USAGE] };
  }
  try {
    const session = (await deps.rpc.request("session.resume", {
      sessionId,
    })) as Session;
    return {
      exitCode: 0,
      lines: [
        `session: ${session.id}`,
        `agent: ${session.agentId}`,
        `model: ${session.model.providerId}/${session.model.modelId}`,
        `status: ${session.status}`,
        `cwd: ${session.cwd}`,
        `created: ${new Date(session.createdAt).toISOString()}`,
        `updated: ${new Date(session.updatedAt).toISOString()}`,
      ],
    };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent resume", err)] };
  }
}

async function cancelCmd(rest: string[], deps: CommandDeps): Promise<CommandResult> {
  const [sessionId, turnId] = rest;
  if (sessionId === undefined || turnId === undefined) {
    return { exitCode: 1, lines: ["agent cancel: expected <sessionId> <turnId>", "", USAGE] };
  }
  try {
    const result = (await deps.rpc.request("session.cancel", {
      sessionId,
      turnId,
    })) as { status: string };
    return { exitCode: 0, lines: [`cancel: ${result.status}`] };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent cancel", err)] };
  }
}

async function approveCmd(rest: string[], deps: CommandDeps): Promise<CommandResult> {
  const [approvalId, value] = rest;
  if (approvalId === undefined || value === undefined) {
    return { exitCode: 1, lines: ["agent approve: expected <approvalId> <allow|deny>", "", USAGE] };
  }
  if (value !== "allow" && value !== "deny") {
    return { exitCode: 1, lines: [`agent approve: value must be allow or deny, got: ${value}`] };
  }
  try {
    const pending = deps.approvalStore
      .listPending()
      .find((request) => request.id === (approvalId as ApprovalId));
    const decision = (await deps.rpc.request("session.approve", {
      approvalId,
      value,
      decidedBy: "cli",
    })) as ApprovalDecision;
    const lines: string[] = [];
    if (pending !== undefined) {
      lines.push(`approval: ${pending.id}`, `action: ${pending.action}`, `target: ${pending.target}`, `reason: ${pending.reason}`);
    } else {
      lines.push(`approval: ${approvalId}`);
    }
    lines.push(`decision: ${decision.value} (decided by cli)`);
    return { exitCode: 0, lines };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent approve", err)] };
  }
}

async function agentsCmd(deps: CommandDeps): Promise<CommandResult> {
  try {
    const agents = (await deps.rpc.request("agent.list")) as AgentSummary[];
    return {
      exitCode: 0,
      lines: agents.length === 0
        ? ["(none)"]
        : agents.map((agent) => `agent ${agent.id}: ${agent.name} — ${agent.description} [${agent.mode}]`),
    };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent agents", err)] };
  }
}

async function toolsCmd(deps: CommandDeps): Promise<CommandResult> {
  try {
    const tools = (await deps.rpc.request("tool.list")) as { name: string; description: string }[];
    return {
      exitCode: 0,
      lines: tools.length === 0
        ? ["(none)"]
        : tools.map((tool) => `tool ${tool.name}: ${tool.description}`),
    };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent tools", err)] };
  }
}

async function skillsCmd(deps: CommandDeps): Promise<CommandResult> {
  try {
    const skills = (await deps.rpc.request("skill.list")) as {
      id: string;
      status: string;
      manifest: { name: string; version: string };
    }[];
    return {
      exitCode: 0,
      lines: skills.length === 0
        ? ["(none)"]
        : skills.map((skill) => `skill ${skill.id}: ${skill.manifest.name} v${skill.manifest.version} [${skill.status}]`),
    };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent skills", err)] };
  }
}

async function sessionsCmd(deps: CommandDeps): Promise<CommandResult> {
  try {
    const sessions = await deps.store.listSessions();
    return {
      exitCode: 0,
      lines: sessions.length === 0
        ? ["(none)"]
        : sessions.map((session) => `session ${session.id}: agent=${session.agentId} status=${session.status} cwd=${session.cwd}`),
    };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent sessions", err)] };
  }
}

async function benchmarkCmd(rest: string[]): Promise<CommandResult> {
  const { runBenchmarkCommand } = await import("./benchmark-command.js");
  return runBenchmarkCommand(rest);
}

async function traceCmd(rest: string[], deps: CommandDeps): Promise<CommandResult> {
  const [sessionId, outputDir] = rest;
  if (sessionId === undefined || outputDir === undefined) {
    return { exitCode: 1, lines: ["agent trace: expected <sessionId> <outputDir>", "", USAGE] };
  }
  try {
    const { exportEpisode } = await import("@ar/observability");
    const session = await deps.store.getSession(sessionId as SessionId);
    if (session === undefined) {
      return { exitCode: 1, lines: [`agent trace: unknown session: ${sessionId}`] };
    }
    // exportEpisode discovers its session from the store and requires exactly
    // one; project the store to the requested session so the CLI can trace
    // any session regardless of how many exist.
    const single: SessionStore = {
      ...deps.store,
      listSessions: async () => [session],
    };
    const pkg = await exportEpisode({
      events: deps.events,
      sessions: single,
      outputDir,
    });
    return {
      exitCode: 0,
      lines: [
        `trace: exported episode to ${pkg.outputDir} (${pkg.files.length} files)`,
        `trace: session ${pkg.sessionId}`,
        `trace: files: ${pkg.files.join(", ")}`,
      ],
    };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent trace", err)] };
  }
}

async function doctorCmd(deps: CommandDeps): Promise<CommandResult> {
  try {
    const checks = await runChecks(deps.doctor);
    const ok = checks.filter((c) => c.status === "OK").length;
    const warnings = checks.filter((c) => c.status === "WARNING").length;
    const errors = checks.filter((c) => c.status === "ERROR").length;
    return {
      exitCode: errors === 0 ? 0 : 1,
      lines: [
        ...checks.map((c) => `[${c.status}] ${c.name} — ${c.detail}`),
        `doctor: ${ok} ok, ${warnings} warning(s), ${errors} error(s)`,
      ],
    };
  } catch (err) {
    return { exitCode: 1, lines: [renderError("agent doctor", err)] };
  }
}

/** Verification status from the event trail (plan §173 "verification"). */
function verificationLine(events: AgentEvent[]): string {
  const last = [...events]
    .reverse()
    .find((e) => e.type === "verification.completed" || e.type === "verification.failed");
  if (last === undefined) return "no verification gate configured";
  if (last.type === "verification.completed") return "passed";
  return `failed: ${String(last.payload.error ?? "unknown reason")}`;
}

/** RPC errors carry only { code, message } (plan §161); render exactly that. */
function renderError(prefix: string, err: unknown): string {
  if (err instanceof AgentError) {
    return `${prefix} failed: ${err.info.code}: ${err.info.message}`;
  }
  return `${prefix} failed: ${err instanceof Error ? err.message : String(err)}`;
}
