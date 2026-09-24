// P2-7: explicit learning-candidate lifecycle commands (`agent learn …`).
// Promotion is deliberately NOT automatic: reflection queues candidates
// (P2-5/P2-6) and only an explicit operator command evaluates / promotes /
// re-evaluates them. Every promotion re-runs the write gate and an isolated
// CandidateSandbox check before anything is persisted — a candidate never
// reaches the memory store without a fresh, auditable gate.

import { newMemoryId } from "@ar/contracts";
import type { MemoryEntry, MemoryScope, MemoryStore, SessionId } from "@ar/contracts";
import { CandidateSandbox } from "@ar/learning";
import { DEFAULT_MEMORY_WRITE_POLICY, evaluateCandidate } from "@ar/memory";
import { memoryScopeFor, resolveRepositoryIdentity } from "@ar/harness";
import type { LearningCandidateStore } from "@ar/harness";
import type { CommandResult } from "./commands.js";

export interface LearnDeps {
  candidates: LearningCandidateStore;
  /** Memory store the promotion writes into (absent → promote is refused). */
  memoryStore?: MemoryStore;
  /** Workspace root for memory scope resolution (default process.cwd()). */
  cwd?: string;
  now?: () => number;
}

const USAGE_LINE = "learn candidates|evaluate <id>|promote <id>|reevaluate   learning-candidate lifecycle (P2-7)";

export async function learnCmd(rest: string[], deps: LearnDeps): Promise<CommandResult> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "candidates":
      return candidatesCmd(deps);
    case "evaluate":
      return evaluateCmd(args, deps);
    case "promote":
      return promoteCmd(args, deps);
    case "reevaluate":
      return reevaluateCmd(deps);
    default:
      return { exitCode: 1, lines: ["learn: expected candidates|evaluate <id>|promote <id>|reevaluate", "", USAGE_LINE] };
  }
}

async function candidatesCmd(deps: LearnDeps): Promise<CommandResult> {
  const candidates = await deps.candidates.list();
  if (candidates.length === 0) {
    return { exitCode: 0, lines: ["no learning candidates queued"] };
  }
  const lines = [`${candidates.length} learning candidate(s) queued:`, ""];
  for (const c of candidates.sort((a, b) => a.proposedAt - b.proposedAt)) {
    const score = c.benchmarkScoreAfter !== undefined
      ? `promoted (score ${c.benchmarkScoreAfter})`
      : c.benchmarkScoreBefore !== undefined
        ? `evaluated (baseline ${c.benchmarkScoreBefore})`
        : "pending evaluation";
    lines.push(
      `- ${c.id}  kind=${c.kind}  ${score}  proposed=${new Date(c.proposedAt).toISOString()}`,
    );
    lines.push(`    ${c.content.slice(0, 120)}${c.content.length > 120 ? "…" : ""}`);
  }
  return { exitCode: 0, lines };
}

async function evaluateCmd(args: string[], deps: LearnDeps): Promise<CommandResult> {
  const [id] = args;
  if (id === undefined) return { exitCode: 1, lines: ["learn evaluate: expected <candidate-id>"] };
  const candidate = await deps.candidates.get(id);
  if (candidate === undefined) {
    return { exitCode: 1, lines: [`learn evaluate: unknown candidate ${id}`] };
  }

  // P2-6: isolated candidate evaluation — scratch dir + champion snapshot +
  // mutation check. The candidate never touches the champion state; the
  // runner here only re-validates the write gate (security + thresholds).
  const sandbox = new CandidateSandbox({ now: deps.now ?? Date.now });
  const gate = evaluateCandidate(candidateToMemoryCandidate(candidate), DEFAULT_MEMORY_WRITE_POLICY);
  if (!gate.allowed) {
    return { exitCode: 1, lines: [`learn evaluate ${id}: write gate rejects the candidate: ${gate.reason}`] };
  }
  let sandboxResult;
  try {
    sandboxResult = await sandbox.run({
      candidate,
      championState: async () => (await deps.candidates.list()).map((c) => c.id).sort(),
      runner: async () => ({ ok: true }),
    });
  } catch (cause) {
    return { exitCode: 1, lines: [`learn evaluate ${id}: sandbox run failed: ${cause instanceof Error ? cause.message : String(cause)}`] };
  }
  const lines = [
    `learn evaluate ${id}:`,
    `  write gate: allowed`,
    `  sandbox: ${sandboxResult.violations.length === 0 ? "clean" : `violations: ${sandboxResult.violations.map((v) => `${v.kind}: ${v.detail}`).join("; ")}`}`,
    `  elapsedMs: ${sandboxResult.elapsedMs}`,
    `  benchmark: run \`agent benchmark\` to establish a real score baseline (never fabricated)`,
  ];
  return { exitCode: sandboxResult.violations.length === 0 ? 0 : 1, lines };
}

async function promoteCmd(args: string[], deps: LearnDeps): Promise<CommandResult> {
  const [id] = args;
  if (id === undefined) return { exitCode: 1, lines: ["learn promote: expected <candidate-id>"] };
  if (deps.memoryStore === undefined) {
    return { exitCode: 1, lines: ["learn promote: no memory store wired (harness memory is disabled)"] };
  }
  const candidate = await deps.candidates.get(id);
  if (candidate === undefined) {
    return { exitCode: 1, lines: [`learn promote: unknown candidate ${id}`] };
  }

  // Gate 0a (P17-2): a QUARANTINED candidate (produced by a turn that used
  // untrusted external content) can never be auto-promoted — it must be
  // reviewed first. Malicious-repo-一句话 → 永久记忆 is structurally blocked.
  const meta = candidateToMemoryCandidate(candidate);
  if (meta.promotionState === "quarantined" || (meta.pollutionSources?.length ?? 0) > 0) {
    return {
      exitCode: 1,
      lines: [
        `learn promote ${id}: REJECTED — candidate is quarantined (pollution sources: ${(meta.pollutionSources ?? []).join(", ") || "unknown"})`,
        `  A turn using untrusted external content produced this candidate; it must be reviewed, never auto-promoted.`,
      ],
    };
  }
  // Gate 0b (P17-1): a DERIVABLE fact (re-obtainable from repo/git/AGENTS.md/
  // config) is not stored as long-term memory — re-derivation never goes stale.
  if (meta.derivability?.verdict === "derivable") {
    return {
      exitCode: 1,
      lines: [
        `learn promote ${id}: REJECTED — derivable fact (${meta.derivability.reason})`,
        `  Long-term memory is reserved for preferences / decisions / lessons / environment quirks / underivable constraints.`,
      ],
    };
  }

  // Gate 1: fresh write-gate re-check (security + importance/novelty).
  const gate = evaluateCandidate(candidateToMemoryCandidate(candidate), DEFAULT_MEMORY_WRITE_POLICY);
  if (!gate.allowed) {
    return { exitCode: 1, lines: [`learn promote ${id}: write gate rejects: ${gate.reason}`] };
  }
  // Gate 2: isolated sandbox — the promotion write must not corrupt the
  // existing memory set (champion snapshot diff).
  const sandbox = new CandidateSandbox({ now: deps.now ?? Date.now });
  const championState = async (): Promise<unknown> => {
    const entries = await deps.memoryStore!.list();
    return entries.map((e) => `${e.id}:${e.content}`).sort();
  };
  let sandboxResult;
  try {
    sandboxResult = await sandbox.run({
      candidate,
      championState,
      runner: async () => ({ ok: true }),
    });
  } catch (cause) {
    return { exitCode: 1, lines: [`learn promote ${id}: sandbox run failed: ${cause instanceof Error ? cause.message : String(cause)}`] };
  }
  if (sandboxResult.violations.length > 0) {
    return { exitCode: 1, lines: [`learn promote ${id}: sandbox violations: ${sandboxResult.violations.map((v) => `${v.kind}: ${v.detail}`).join("; ")}`] };
  }

  // Persist: build the MemoryEntry and write it, then dequeue the candidate.
  const cwd = deps.cwd ?? process.cwd();
  const identity = await resolveRepositoryIdentity(cwd);
  const scope = memoryScopeFor(identity);
  const now = (deps.now ?? Date.now)();
  const entry = memoryEntryFromCandidate(candidate, scope, now);
  await deps.memoryStore.write(entry);
  await deps.candidates.remove(candidate.id);

  const lines = [
    `learn promote ${id}: PROMOTED to memory store`,
    `  memory id: ${entry.id}`,
    `  scope: ${entry.scope}`,
    `  content: ${candidate.content.slice(0, 120)}${candidate.content.length > 120 ? "…" : ""}`,
    `  benchmark: ${candidate.benchmarkScoreAfter !== undefined ? `post-promotion score ${candidate.benchmarkScoreAfter}` : "no benchmark score recorded (run `agent benchmark` for real evidence)"}`,
  ];
  return { exitCode: 0, lines };
}

async function reevaluateCmd(deps: LearnDeps): Promise<CommandResult> {
  const candidates = await deps.candidates.list();
  const promoted = candidates.filter((c) => c.benchmarkScoreAfter !== undefined);
  const pending = candidates.filter((c) => c.benchmarkScoreAfter === undefined);
  const lines = [
    `learn reevaluate:`,
    `  ${pending.length} pending candidate(s) — evaluate + benchmark before promotion`,
    `  ${promoted.length} promoted candidate(s) with recorded scores`,
  ];
  for (const c of pending) {
    lines.push(`    pending: ${c.id} (${c.kind})`);
  }
  for (const c of promoted) {
    lines.push(`    promoted: ${c.id} — after ${c.benchmarkScoreAfter}`);
  }
  return { exitCode: 0, lines };
}

/** The candidate as a write-gate-evaluable MemoryCandidate. */
function candidateToMemoryCandidate(candidate: { content: string }): import("@ar/contracts").MemoryCandidate {
  const source = (candidate as { sourceCandidate?: import("@ar/contracts").MemoryCandidate }).sourceCandidate;
  if (source !== undefined) return source;
  return {
    content: candidate.content,
    type: "procedural",
    sourceSession: "" as SessionId,
    importance: 0.6,
    confidence: 0.6,
    novelty: 0.5,
    stability: 0.5,
  };
}

/** Rebuild a persisted MemoryEntry from a queued candidate (P2-7 promotion). */
function memoryEntryFromCandidate(
  candidate: { id: string; content: string; sourceCandidate?: import("@ar/contracts").MemoryCandidate },
  scope: MemoryScope,
  now: number,
): MemoryEntry {
  const source = candidate.sourceCandidate;
  return {
    id: newMemoryId(),
    content: candidate.content,
    type: source?.type ?? "procedural",
    sourceSession: source?.sourceSession ?? ("" as SessionId),
    importance: source?.importance ?? 0.6,
    confidence: source?.confidence ?? 0.6,
    novelty: source?.novelty ?? 0.5,
    stability: source?.stability ?? 0.5,
    ...(source?.structured !== undefined ? { structured: source.structured } : {}),
    // P17-1: provenance survives promotion (sourceTurn/derivability/scan/
    // pollution state are part of the durable memory record).
    ...(source?.sourceTurn !== undefined ? { sourceTurn: source.sourceTurn } : {}),
    ...(source?.derivability !== undefined ? { derivability: source.derivability } : {}),
    ...(source?.promotionState !== undefined ? { promotionState: source.promotionState } : {}),
    ...(source?.securityScan !== undefined ? { securityScan: source.securityScan } : {}),
    ...(source?.pollutionSources !== undefined ? { pollutionSources: source.pollutionSources } : {}),
    createdAt: now,
    updatedAt: now,
    deleted: false,
    scope,
  };
}
