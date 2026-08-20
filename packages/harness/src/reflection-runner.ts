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
  EventStore,
  ReflectionOutput,
  SessionId,
  TurnId,
} from "@ar/contracts";
import {
  DEFAULT_MEMORY_WRITE_POLICY,
  Reflector,
  evaluateCandidate,
  type MemoryWritePolicy,
} from "@ar/memory";
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
    } catch {
      return { outputs: 0, candidates: 0 }; // event read failure → skip quietly
    }

    const goal = input.outcome.state?.goal;
    const reflections = new Reflector().reflect({ events, taskGoal: goal });

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
      if (!gate.allowed) continue;
      const candidate = candidateFromReflection(
        reflection,
        this.makeCandidateId(),
        this.now(),
      );
      try {
        await this.candidateStore.add(candidate);
        candidates += 1;
      } catch {
        // queue write failure must not propagate into the app
      }
    }
    return { outputs, candidates };
  }

  /** Read the reflection journal (for the CLI / audits). */
  async listJournal(): Promise<ReflectionJournalRecord[]> {
    let content: string;
    try {
      content = await readFile(this.journal, "utf8");
    } catch {
      return [];
    }
    const records: ReflectionJournalRecord[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const record = JSON.parse(trimmed) as ReflectionJournalRecord;
        if (record.schemaVersion === REFLECTION_SCHEMA_VERSION) records.push(record);
      } catch {
        // corrupt line: skip
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
      } catch {
        existing = ""; // first append
      }
      await writeFile(this.journal, existing + line + "\n", "utf8");
    } catch {
      // journal write failure must never break the app
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
): LearningCandidate {
  const candidate = reflection.candidate!;
  const kind: LearningCandidateKind =
    candidate.type === "procedural" ? "memory" : candidate.type === "explicit" ? "workflow" : "memory";
  return {
    id,
    kind,
    content: candidate.content,
    proposedAt: at,
    securityChecked: true,
    sourceCandidate: candidate,
    ...(candidate.structured !== undefined ? { structured: candidate.structured } : {}),
  };
}
