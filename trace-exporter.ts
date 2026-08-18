import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentEvent,
  EventStore,
  Session,
  SessionId,
  SessionStatus,
  SessionStore,
  TaskSpec,
  Verifier,
  VerificationContext,
  VerificationResult,
} from "@ar/contracts";
import { computeMetrics, type RunMetrics } from "./metrics.js";

/**
 * Episode trace export, per AGENT_ARCHITECTURE_PLAN v2.0 §77.
 *
 * Reads an event stream + session record through their contracts interfaces
 * (never the JSONL implementations) and writes a self-contained episode
 * package: task.json, session.json, events.jsonl, context.json,
 * tool-calls.jsonl, permissions.jsonl, artifacts.json, verification.json,
 * metrics.json, summary.json.
 *
 * The export target is discovered from the session store: exactly one
 * session is required (0 or >1 throws). An empty event stream is valid and
 * produces a complete, parseable package.
 */

/** §77 file set, in canonical order. */
export const EPISODE_FILES = [
  "task.json",
  "session.json",
  "events.jsonl",
  "context.json",
  "tool-calls.jsonl",
  "permissions.jsonl",
  "artifacts.json",
  "verification.json",
  "metrics.json",
  "summary.json",
] as const;

/** §168 repository snapshot embedded in summary.json. */
export interface RepoSnapshot {
  node: string;
  git: {
    available: boolean;
    branch?: string;
    commit?: string;
    dirty?: boolean;
    changedFiles?: string[];
  };
}

export interface ArtifactEntry {
  path: string;
  kind?: string;
  description?: string;
  at: number;
}

export interface EpisodeSummary {
  sessionId: SessionId;
  status: SessionStatus;
  taskId?: string;
  startedAt: number;
  endedAt: number;
  turnCount: number;
  toolCallCount: number;
  artifactCount: number;
  artifacts: string[];
  verification: { source: "verifier" | "events" | "none"; passed?: boolean };
  metrics: RunMetrics;
  repoSnapshot: RepoSnapshot;
  files: readonly string[];
}

export interface EpisodePackage {
  outputDir: string;
  files: readonly string[];
  sessionId: SessionId;
  events: AgentEvent[];
  metrics: RunMetrics;
  summary: EpisodeSummary;
}

export interface ExportEpisodeDeps {
  events: EventStore;
  sessions: SessionStore;
  task?: TaskSpec;
  verifier?: Verifier;
  outputDir: string;
}

const TOOL_CALL_EVENT_TYPES = new Set(["tool.requested", "tool.completed", "tool.failed"]);
const PERMISSION_EVENT_TYPES = new Set([
  "tool.permission_requested",
  "tool.permission_resolved",
  "human.approval",
  "human.correction",
  "human.message",
  "human.cancel",
  "human.override",
]);

function stringOf(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function compactPayload(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  if (text.length <= 400) return text;
  return `${text.slice(0, 397)}...`;
}

/** Compact transcript for VerificationContext (§42-style evidence support). */
function renderTranscript(events: AgentEvent[]): string {
  return events
    .map((event) => `${event.timestamp} ${event.type} ${compactPayload(event.payload)}`)
    .join("\n");
}

/** Extract one §77 tool-call record from a tool.* event. */
function toolCallRecord(event: AgentEvent): Record<string, unknown> {
  const payload = event.payload;
  const record: Record<string, unknown> = {
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    toolCallId: payload.toolCallId,
    tool: payload.tool ?? payload.name,
  };
  if (event.turnId !== undefined) record.turnId = event.turnId;
  for (const key of [
    "args",
    "status",
    "durationMs",
    "evidence",
    "outputPreview",
    "error",
  ] as const) {
    if (payload[key] !== undefined) record[key] = payload[key];
  }
  return record;
}

/** Extract one §77 permission record from a permission/human event. */
function permissionRecord(event: AgentEvent): Record<string, unknown> {
  const payload = event.payload;
  const record: Record<string, unknown> = {
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
  };
  if (event.turnId !== undefined) record.turnId = event.turnId;
  for (const key of ["toolCallId", "tool", "effect", "reason", "approvalId"] as const) {
    if (payload[key] !== undefined) record[key] = payload[key];
  }
  const remaining = { ...payload };
  for (const key of ["toolCallId", "tool", "effect", "reason", "approvalId"] as const) {
    delete remaining[key];
  }
  if (Object.keys(remaining).length > 0) record.payload = remaining;
  return record;
}

/**
 * Artifacts = file/diff evidence sources captured on tool.completed events
 * plus payload.artifacts string arrays. Deduplicated by path (first wins).
 */
function collectArtifacts(events: AgentEvent[]): ArtifactEntry[] {
  const byPath = new Map<string, ArtifactEntry>();
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const push = (entry: ArtifactEntry): void => {
      if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
    };
    const evidence = event.payload.evidence;
    if (Array.isArray(evidence)) {
      for (const item of evidence) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        const source = stringOf(record, ["source"]);
        if (source === undefined) continue;
        const entry: ArtifactEntry = {
          path: source,
          at: event.timestamp,
        };
        const kind = stringOf(record, ["type"]);
        if (kind !== undefined) entry.kind = kind;
        const description = stringOf(record, ["description"]);
        if (description !== undefined) entry.description = description;
        push(entry);
      }
    }
    const extra = event.payload.artifacts;
    if (Array.isArray(extra)) {
      for (const item of extra) {
        if (typeof item !== "string" || item.length === 0) continue;
        push({ path: item, at: event.timestamp });
      }
    }
  }
  return [...byPath.values()];
}

async function buildVerification(
  task: TaskSpec | undefined,
  verifier: Verifier | undefined,
  session: Session,
  events: AgentEvent[],
  artifacts: ArtifactEntry[],
): Promise<{ source: "verifier" | "events" | "none"; passed?: boolean } & Record<string, unknown>> {
  if (task !== undefined && verifier !== undefined) {
    const changedPaths = artifacts.map((artifact) => artifact.path);
    const context: VerificationContext = {
      sessionId: session.id,
      cwd: session.cwd,
      changedPaths,
      transcript: renderTranscript(events),
      runStartedAt:
        events.length > 0 ? events[0]!.timestamp : session.createdAt,
    };
    const result: VerificationResult = await verifier.verify(task, context);
    return { source: "verifier", ...result };
  }
  const verificationEvents = events.filter(
    (event) =>
      event.type === "verification.completed" || event.type === "verification.failed",
  );
  const last = verificationEvents[verificationEvents.length - 1];
  if (last === undefined) return { source: "none" };
  return { source: "events", type: last.type, ...last.payload };
}

function runGit(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) return undefined;
  return typeof result.stdout === "string" ? result.stdout.trim() : undefined;
}

/** §168 repository snapshot; git capture failures degrade to available: false. */
function captureRepoSnapshot(cwd: string): RepoSnapshot {
  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(cwd, ["rev-parse", "HEAD"]);
  if (branch === undefined || commit === undefined) {
    return { node: process.versions.node, git: { available: false } };
  }
  const porcelain = runGit(cwd, ["status", "--porcelain"]) ?? "";
  const changed = runGit(cwd, ["diff", "--name-only", "HEAD"]) ?? "";
  return {
    node: process.versions.node,
    git: {
      available: true,
      branch,
      commit,
      dirty: porcelain.length > 0,
      changedFiles: changed.length > 0 ? changed.split("\n") : [],
    },
  };
}

/** Export a complete episode package (§77) for the single session in the store. */
export async function exportEpisode(deps: ExportEpisodeDeps): Promise<EpisodePackage> {
  const sessions = await deps.sessions.listSessions();
  if (sessions.length === 0) {
    throw new Error("observability: no session to export");
  }
  if (sessions.length > 1) {
    throw new Error(
      `observability: expected exactly one session, found ${sessions.length}`,
    );
  }
  const session = sessions[0]!;
  const events = await deps.events.list(session.id);
  const metrics = computeMetrics(events);
  const artifacts = collectArtifacts(events);
  const repoSnapshot = captureRepoSnapshot(session.cwd);

  await mkdir(deps.outputDir, { recursive: true });
  const write = async (
    name: string,
    content: string,
  ): Promise<void> => {
    await writeFile(join(deps.outputDir, name), content, "utf8");
  };
  const writeJson = (name: string, data: unknown): Promise<void> =>
    write(name, `${JSON.stringify(data)}\n`);

  await writeJson("task.json", deps.task ?? {});
  await writeJson("session.json", session);
  await write("events.jsonl", events.map((event) => JSON.stringify(event)).join("\n"));
  await writeJson("context.json", {
    builds: events.filter((event) => event.type === "context.built"),
    compactions: events.filter((event) => event.type === "context.compacted"),
  });
  await write(
    "tool-calls.jsonl",
    events
      .filter((event) => TOOL_CALL_EVENT_TYPES.has(event.type))
      .map((event) => JSON.stringify(toolCallRecord(event)))
      .join("\n"),
  );
  await write(
    "permissions.jsonl",
    events
      .filter((event) => PERMISSION_EVENT_TYPES.has(event.type))
      .map((event) => JSON.stringify(permissionRecord(event)))
      .join("\n"),
  );
  await writeJson("artifacts.json", { artifacts });
  await writeJson("metrics.json", metrics);

  const verification = await buildVerification(
    deps.task,
    deps.verifier,
    session,
    events,
    artifacts,
  );
  await writeJson("verification.json", verification);

  const summary: EpisodeSummary = {
    sessionId: session.id,
    status: session.status,
    ...(deps.task !== undefined ? { taskId: deps.task.id } : {}),
    startedAt: events.length > 0 ? events[0]!.timestamp : session.createdAt,
    endedAt: events.length > 0 ? events[events.length - 1]!.timestamp : session.updatedAt,
    turnCount: metrics.turn_count,
    toolCallCount: metrics.tool_call_count,
    artifactCount: artifacts.length,
    artifacts: artifacts.map((artifact) => artifact.path),
    verification: {
      source: verification.source,
      ...(typeof verification.passed === "boolean"
        ? { passed: verification.passed }
        : {}),
    },
    metrics,
    repoSnapshot,
    files: EPISODE_FILES,
  };
  await writeJson("summary.json", summary);

  return {
    outputDir: deps.outputDir,
    files: EPISODE_FILES,
    sessionId: session.id,
    events,
    metrics,
    summary,
  };
}
