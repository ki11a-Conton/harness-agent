import type { ApprovalStore, EventStore, MemoryStore, SessionStore } from "@ar/contracts";
import type { AgentRuntime } from "@ar/core";
import type { RpcContext } from "@ar/gateway";
import type { HarnessIntrospection, LearningCandidateStore } from "@ar/harness";
import type { SessionService } from "@ar/session";
import type { DoctorDeps } from "./doctor.js";
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
    runtime: AgentRuntime;
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
}
export interface CommandResult {
    exitCode: number;
    lines: string[];
}
export declare const USAGE = "usage: agent <command> [args]\n\ncommands:\n  run <cwd> <text>                  create a session, run a turn, print the structured outcome (plan \u00A7173)\n  resume <sessionId>                print session state\n  cancel <sessionId> <turnId>       cancel a running turn\n  approve <approvalId> <allow|deny> resolve a pending approval\n  agents                            list registered agents\n  tools                             list registered tools\n  skills                            list discovered skills\n  sessions                          list sessions\n  benchmark [flags]                 run the fixed benchmark suite and freeze a baseline (plan.md Phase 1)\n  trace <sessionId> <outputDir>     export an episode package (plan \u00A777)\n  doctor                            run environment checks (plan \u00A787)\n  mechanisms <path>                 validate mechanism manifests (P2-8)\n  experiment <config.json>          run a mechanism experiment (P2-9)\n  audit [--json] [--out <dir>]      generate CAPABILITY_MATRIX.md/.json from real wiring evidence (P0-1)\n  explain <sessionId> [--tool-call <id>]  why did the agent do this? observable evidence only (P9-3)\n  recover list                         startup recovery scan \u2014 unfinished sessions/approvals/asks/orphans (P12-3)\n  learn candidates|evaluate <id>|promote <id>|reevaluate\n                                    learning-candidate lifecycle \u2014 reflection queues, explicit promotion only (P2-7)";
/** Dispatch `agent <command> [args]`. argv excludes the program and "agent". */
export declare function runCommand(argv: string[], deps: CommandDeps): Promise<CommandResult>;
//# sourceMappingURL=commands.d.ts.map