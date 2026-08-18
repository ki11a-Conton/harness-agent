import { randomUUID } from "node:crypto";

declare const brand: unique symbol;

type Branded<S extends string> = string & { readonly [brand]: S };

export type SessionId = Branded<"SessionId">;
export type TurnId = Branded<"TurnId">;
export type MessageId = Branded<"MessageId">;
export type ToolCallId = Branded<"ToolCallId">;
export type ApprovalId = Branded<"ApprovalId">;
export type EventId = Branded<"EventId">;
export type RunId = Branded<"RunId">;
export type CheckpointId = Branded<"CheckpointId">;
export type MemoryId = Branded<"MemoryId">;
export type SkillId = Branded<"SkillId">;
export type AgentId = Branded<"AgentId">;
export type JobId = Branded<"JobId">;
export type ProcessId = Branded<"ProcessId">;
export type TraceId = Branded<"TraceId">;
export type PromptId = Branded<"PromptId">;
export type ArtifactId = Branded<"ArtifactId">;

const PREFIXES: Record<string, string> = {
  session: "session_",
  turn: "turn_",
  message: "message_",
  toolcall: "toolcall_",
  approval: "approval_",
  event: "event_",
  run: "run_",
  checkpoint: "checkpoint_",
  memory: "memory_",
  skill: "skill_",
  agent: "agent_",
  job: "job_",
  process: "proc_",
  trace: "trace_",
  prompt: "prompt_",
  artifact: "artifact_",
};

function make<S extends string>(prefix: string): Branded<S> {
  return `${PREFIXES[prefix] ?? `${prefix}_`}${randomUUID()}` as Branded<S>;
}

export function newSessionId(): SessionId {
  return make("session");
}
export function newTurnId(): TurnId {
  return make("turn");
}
export function newMessageId(): MessageId {
  return make("message");
}
export function newToolCallId(): ToolCallId {
  return make("toolcall");
}
export function newApprovalId(): ApprovalId {
  return make("approval");
}
export function newEventId(): EventId {
  return make("event");
}
export function newRunId(): RunId {
  return make("run");
}
export function newCheckpointId(): CheckpointId {
  return make("checkpoint");
}
export function newMemoryId(): MemoryId {
  return make("memory");
}
export function newSkillId(): SkillId {
  return make("skill");
}
export function newAgentId(): AgentId {
  return make("agent");
}
export function newJobId(): JobId {
  return make("job");
}
export function newProcessId(): ProcessId {
  return make("process");
}
export function newTraceId(): TraceId {
  return make("trace");
}
export function newPromptId(): PromptId {
  return make("prompt");
}
export function newArtifactId(): ArtifactId {
  return make("artifact");
}

export function isId(prefix: string, value: string): boolean {
  return value.startsWith(`${prefix}_`);
}