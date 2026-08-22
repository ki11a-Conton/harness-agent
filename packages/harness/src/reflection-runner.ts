// P2-5/P2-6: post-turn reflection runner. After every terminal turn outcome
// the harness invokes this: it reads the turn's event stream, runs the
// deterministic rule-based Reflector (no LLM — plan.md P2-5), appends the
// reflection outputs to a JSONL journal, and funnels the procedural candidates
// through the memory write gate into the learning candidate queue (P2-6).
// Promotion is never automatic (P2-7): candidates wait for an explicit
// `agent learn` command.

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ErrorCode,
  EventStore,
  EventType,
  ReflectionOutput,
  SessionId,
  TurnId,
} from "@ar/contracts";
import {
  assessDerivability,
  DEFAULT_MEMORY_WRITE_POLICY,
  Reflector,
  evaluateCandidate,
  type MemoryWritePolicy,
} from "@ar/memory";
import { newEventId, isNodeErrorCode } from "@ar/contracts";
import type { LearningCandidate, LearningCandidateKind } from "@ar/learning";
import type { LearningCandidateStore } from "./candidate-store.js";

export interface PostTurnReflectorDeps {
  events: EventStore;
  candidateStore: LearningCandidateStore;
  /** Reflection journal directory (dataDir). */
  dataDir: string;
  writePolicy?: MemoryWritePolicy;
  now?: () => number;
  /** Deterministic id factory; defaults to a randomUUID-based generator. */
  newCandidateId?: () => string;
}

export interface ReflectionRunInput {
  sessionId: SessionId;
  turnId: TurnId;
  /** Structured outcome view (decoupled from @ar/core's TurnOutcome). */
  outcome: { status: string; state?: { goal?: string } };
}

export interface ReflectionRunResult {
  /** Reflection outputs appended to the journal. */
  outputs: number;
  /** Candidates queued into the learning candidate store (write-gate passed). */
  candidates: number;
}

export interface ReflectionJournalRecord {
  schemaVersion: number;
  sessionId: SessionId;
  turnId: TurnId;
  outcome: string;
  at: number;
  reflection: ReflectionOutput;
}

const REFLECTION_SCHEMA_VERSION = 1;
export const REFLECTION_FILE_NAME = "reflection-outputs.jsonl";

/** P2-5: deterministic post-turn reflection. Reads the session event stream,
 *  reflects over failures, journals the outputs, and queues write-gate-passing
 *  procedural candidates (P2-6). Errors are contained per step — a reflection
 *  failure must never break the surrounding application. */
export class PostTurnReflector {
  private readonly events: EventStore;
  private readonly candidateStore: LearningCandidateStore;
  private readonly journal: string;
  private readonly writePolicy: MemoryWritePolicy;
  private readonly now: () => number;
  private readonly makeCandidateId: () => string;

  constructor(deps: PostTurnReflectorDeps) {
    this.events = deps.events;
    this.candidateStore = deps.candidateStore;
    this.journal = join(deps.dataDir, REFLECTION_FILE_NAME);
    this.writePolicy = deps.writePolicy ?? DEFAULT_MEMORY_WRITE_POLICY;
    this.now = deps.now ?? Date.now;
    this.makeCandidateId = deps.newCandidateId ?? (() => `lc_${randomUUID()}`);
  }

  /** P2-5: reflect over one completed/failed turn. */
  async reflect(input: ReflectionRunInput): Promise<ReflectionRunResult> {
    let events;
    try {
      events = await this.events.list(input.sessionId);
    } catch (err) {
      // P14-6: event read failure → skip quietly, but reported, never silent.
      process.stderr.write(`[degraded] reflection.events.list: ${err instanceof Error ? err.message : String(err)}\n`);
      return { outputs: 0, candidates: 0 };
    }

    const goal = input.outcome.state?.goal;
    const reflections = new Reflector().reflect({ events, taskGoal: goal });
    // P17-2: did this turn USE untrusted external content (MCP tools, remote
    // skills, repository instruction files)? Candidates from such turns are
    // quarantined — never auto-promoted, pollution marked.
    const pollutionSources = detectPollutionFromEvents(events, input.turnId);

    let outputs = 0;
    let candidates = 0;
    for (const reflection of reflections) {
      // Journal every reflection output first (P2-5: never lose the trace).
      await this.appendJournal(input.sessionId, input.turnId, input.outcome.status, reflection);
      outputs += 1;
      // P2-6: only generalizable procedural candidates with a structured
      // lesson enter the learning pipeline; the write gate re-checks the
      // security + importance/novelty bars.
      if (reflection.candidate === undefined || !reflection.generalizable) continue;
      const gate = evaluateCandidate(reflection.candidate, this.writePolicy);
      if (!gate.allowed) {
        // P14-5: a security-gate rejection must be OBSERVABLE — the denial
        // carries source/reason/details on the event stream (never silent;
        // "injection detector results are observable, denials carry
        // source/id/reason").
        if (gate.code !== undefined) {
          await this.emitGateDenial(input.sessionId, input.turnId, gate.code, gate);
        }
        continue;
      }
      const candidate = candidateFromReflection(
        reflection,
        this.makeCandidateId(),
        this.now(),
        { sourceTurn: input.turnId, pollutionSources },
      );
      try {
        await this.candidateStore.add(candidate);
        candidates += 1;
      } catch (err) {
        // P14-6: queue write failure must not propagate into the app — but it
        // is reported, never silent.
        process.stderr.write(`[degraded] reflection.candidateStore.add: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return { outputs, candidates };
  }

  /** P14-5: surface a memory-write-gate security denial on the event stream.
   *  Event type follows the gate code (injection → security.injection_denied,
   *  secret → security.secret_redacted, scanner failure → security.memory_denied);
   *  the payload carries the gate's source/reason/details. A throwing store
   *  append is intentionally surfaced (denials are audit-relevant, P0-7). */
  private async emitGateDenial(
    sessionId: SessionId,
    turnId: TurnId,
    code: ErrorCode,
    gate: { reason: string; source?: string; details?: string[] },
  ): Promise<void> {
    const type: EventType =
      code === "SECRET_REDACTED"
        ? "security.secret_redacted"
        : code === "INJECTION_DENIED"
          ? "security.injection_denied"
          : "security.memory_denied";
    // P26-1: store-owned atomic sequence allocation (appendNew).
    await this.events.appendNew({
      id: newEventId(),
      sessionId,
      turnId,
      timestamp: this.now(),
      type,
      payload: {
        reason: gate.reason,
        source: gate.source ?? "memory-write-gate",
        code,
        ...(gate.details !== undefined && gate.details.length > 0
          ? { details: gate.details }
          : {}),
      },
    });
  }

  /** Read the reflection journal (for the CLI / audits). */
  async listJournal(): Promise<ReflectionJournalRecord[]> {
    let content: string;
    try {
      content = await readFile(this.journal, "utf8");
    } catch (err) {
      // P14-6: first-run ENOENT is expected — other read failures propagate.
      if (!isNodeErrorCode(err, "ENOENT")) throw err;
      return [];
    }
    const records: ReflectionJournalRecord[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const record = JSON.parse(trimmed) as ReflectionJournalRecord;
        if (record.schemaVersion === REFLECTION_SCHEMA_VERSION) records.push(record);
      } catch (err) {
        // P14-6: corrupt line — skipped but reported, never silent.
        process.stderr.write(`[degraded] reflection.journal.corrupt-line: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return records;
  }

  private async appendJournal(
    sessionId: SessionId,
    turnId: TurnId,
    outcome: string,
    reflection: ReflectionOutput,
  ): Promise<void> {
    try {
      const record: ReflectionJournalRecord = {
        schemaVersion: REFLECTION_SCHEMA_VERSION,
        sessionId,
        turnId,
        outcome,
        at: this.now(),
        reflection,
      };
      const line = JSON.stringify(record);
      let existing = "";
      try {
        existing = await readFile(this.journal, "utf8");
      } catch (err) {
        // P14-6: first append (ENOENT) is expected — other read failures
        // propagate (a journal that exists but cannot be read is a real error).
        if (!isNodeErrorCode(err, "ENOENT")) throw err;
        existing = "";
      }
      await writeFile(this.journal, existing + line + "\n", "utf8");
    } catch (err) {
      // P14-6: journal write failure must never break the app — reported.
      process.stderr.write(`[degraded] reflection.journal.append: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

/** A write-gate-passing reflection becomes a queued learning candidate. The
 *  source reflection id is preserved for the promotion audit trail and the
 *  structured strategy lesson travels with the candidate (P2-6) so a later
 *  promotion can build a rich memory entry. */
export function candidateFromReflection(
  reflection: ReflectionOutput,
  id: string,
  at: number,
  meta: { sourceTurn?: import("@ar/contracts").TurnId; pollutionSources?: string[] } = {},
): LearningCandidate {
  const candidate = reflection.candidate!;
  const kind: LearningCandidateKind =
    candidate.type === "procedural" ? "memory" : candidate.type === "explicit" ? "workflow" : "memory";
  // P17-1: derivability verdict — re-derivable facts are NOT stored long-term.
  const derivability = assessDerivability(candidate.content);
  // P17-2: candidates from pollution-touched turns are quarantined.
  const polluted = (meta.pollutionSources?.length ?? 0) > 0;
  return {
    id,
    kind,
    content: candidate.content,
    proposedAt: at,
    securityChecked: true,
    sourceCandidate: {
      ...candidate,
      ...(meta.sourceTurn !== undefined ? { sourceTurn: meta.sourceTurn } : {}),
      derivability,
      promotionState: polluted ? "quarantined" : "pending",
      securityScan: { checked: true, passed: true, at },
      ...(polluted ? { pollutionSources: meta.pollutionSources } : {}),
    },
    ...(candidate.structured !== undefined ? { structured: candidate.structured } : {}),
  };
}

/** P17-2: heuristic pollution detector over the turn's event stream. A turn
 *  is "pollution-touched" when it USED untrusted external content: MCP tools
 *  (mcp_/mcp: names) or repository instruction files (AGENTS.md/README/
 *  CONTRIBUTING.md read outside the user's own workspace). Candidates from
 *  such turns must never auto-promote. */
const INSTRUCTION_FILE_RE = /(?:^|\/)(?:AGENTS|CLAUDE|README|CONTRIBUTING)\.md$/i;

export function detectPollutionFromEvents(
  events: readonly import("@ar/contracts").AgentEvent[],
  turnId?: import("@ar/contracts").TurnId,
): string[] {
  const sources = new Set<string>();
  for (const e of events) {
    if (turnId !== undefined && e.turnId !== undefined && e.turnId !== turnId) continue;
    if (e.type !== "tool.requested") continue;
    const name = typeof e.payload.name === "string" ? e.payload.name : "";
    if (/^mcp[_:]/i.test(name)) {
      sources.add(`mcp:${name}`);
      continue;
    }
    const args = e.payload.args as Record<string, unknown> | undefined;
    const path =
      typeof args?.path === "string" ? args.path : typeof args?.file === "string" ? args.file : "";
    if (INSTRUCTION_FILE_RE.test(path)) {
      sources.add(`repo-instruction:${path}`);
    }
  }
  return [...sources];
}
