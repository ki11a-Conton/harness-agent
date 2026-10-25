import { mkdir, readFile, rename, open, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionStore, ToolExecutionContext } from "@ar/contracts";
import { ManagedCommands, type ManagedCommandRecord } from "@ar/tools";
import type { HarnessConfig } from "./config.js";

export interface ManagedCommandConfig { enabled: true; maxJobMs?: number; retainedBytes?: number }

export function parseManagedCommandEnvironment(enabled: string | undefined, turnMs: string | undefined): { managedCommands: ManagedCommandConfig; limits: { maxDurationMs: number } } | undefined {
  if (enabled === undefined || enabled === "0") return undefined;
  if (enabled !== "1") throw new TypeError("HARNESS_MANAGED_COMMANDS must be 0 or 1");
  if (turnMs !== undefined && !/^[1-9]\d*$/.test(turnMs)) throw new TypeError("HARNESS_MANAGED_TURN_MS must be a finite positive integer");
  const duration = turnMs === undefined ? 600000 : Number(turnMs);
  if (!Number.isSafeInteger(duration) || duration > 3600000) throw new TypeError("HARNESS_MANAGED_TURN_MS must be 1..3600000");
  return { managedCommands: { enabled: true }, limits: { maxDurationMs: duration } };
}

/** Validation precedes store creation and has no default/profile side effect. */
export function validateManagedCommandConfig(config: HarnessConfig): void {
  if (config.managedCommands === undefined) return;
  const value = config.managedCommands;
  if (value.enabled !== true) throw new TypeError("managedCommands.enabled must be true, or omit the configuration");
  if (!Number.isSafeInteger(config.limits?.maxDurationMs) || config.limits!.maxDurationMs! <= 0) throw new TypeError("managed commands require a finite limits.maxDurationMs");
  if (!config.task || config.task.completionPolicy?.requiresVerification === false || !config.task.verification?.some(v => v.kind === "command")) throw new TypeError("managed commands require a task with real command verification");
  if (config.verification?.verifier !== undefined) throw new TypeError("managed commands require the original TaskVerifier, not a verifier override");
  if (value.maxJobMs !== undefined && (!Number.isSafeInteger(value.maxJobMs) || value.maxJobMs <= 0 || value.maxJobMs > 600000)) throw new TypeError("managed maxJobMs must be 1..600000");
  if (value.retainedBytes !== undefined && (!Number.isSafeInteger(value.retainedBytes) || value.retainedBytes < 0 || value.retainedBytes > 65536)) throw new TypeError("managed retainedBytes must be 0..65536");
  if (config.now !== undefined) throw new TypeError("managed real-process deadlines require the real host clock");
}

const record = z.object({ id: z.string(), owner: z.string(), workspace: z.string(), deadlineAt: z.number().int(), state: z.enum(["running", "succeeded", "failed", "timed_out", "cancelled", "unknown"]) }).strict();

export async function composeManagedCommands(config: HarnessConfig, store: SessionStore): Promise<ManagedCommands | undefined> {
  if (!config.managedCommands) return undefined;
  const journal = config.dataDir === undefined ? undefined : join(config.dataDir, "managed-commands-v1.json");
  let recovered: ManagedCommandRecord[] = [];
  if (journal) {
    try {
      if ((await stat(journal)).size > 256 * 1024) throw new Error("managed journal exceeds size limit");
      const text = await readFile(journal, "utf8");
      if (Buffer.byteLength(text) > 256 * 1024) throw new Error("managed journal exceeds size limit");
      recovered = z.array(record).max(128).parse(JSON.parse(text));
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  return new ManagedCommands({
    ...config.managedCommands,
    recovered,
    resolveAuthority: async (context: ToolExecutionContext) => {
      const [session, turn, snapshot] = await Promise.all([store.getSession(context.sessionId), store.getTurn(context.turnId!), store.loadStateSnapshot(context.sessionId)]);
      const effective = snapshot?.effectiveAgent as { agentId?: string; limits?: { maxDurationMs?: number } } | undefined;
      const duration = effective?.limits?.maxDurationMs;
      if (!session || !turn || session.agentId !== context.agentId || effective?.agentId !== context.agentId || turn.sessionId !== session.id || !["running", "waiting_for_approval"].includes(turn.status) || !Number.isSafeInteger(duration) || duration! <= 0) throw new Error("managed command has no trusted live owner/budget");
      return { signal: context.signal, deadlineAt: Math.min(turn.startedAt + duration!, config.campaignDeadlineAtMs ?? Infinity) };
    },
    ...(journal ? { save: async (records: readonly ManagedCommandRecord[]) => {
      await mkdir(config.dataDir!, { recursive: true });
      const temp = journal + "." + randomUUID() + ".tmp";
      // Atomic replacement; no command/env/output secrets in the journal.
      try {
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(records) + "\n"); await file.sync(); } finally { await file.close(); }
        await rename(temp, journal);
        if (process.platform !== "win32") { const directory = await open(config.dataDir!, "r"); try { await directory.sync(); } finally { await directory.close(); } }
      } finally { await rm(temp, { force: true }); }
    } } : {}),
  });
}
