import type { MemoryEntry } from "@ar/contracts";
import { detectPromptInjection, detectSecrets } from "@ar/security";

// Shared memory security gate (Issue 6/6b, §67): every persistence path
// (JSONL and SQLite backends) must reject injection/secret content identically.

export interface SecurityDeniedEvent {
  detection: "injection" | "secret";
  reasons: string[];
  content: string;
  /** P0-7: which gate surfaced the denial (e.g. "memory-store",
   *  "sqlite-memory-store"), so hosts can attribute the rejection. */
  source: string;
}

export interface UnsafeMemory {
  message: string;
  event: SecurityDeniedEvent;
}

/** Check content for injection or secrets; return the reason or null. */
export function checkUnsafeMemory(content: string, source: string): UnsafeMemory | null {
  const injection = detectPromptInjection(content);
  if (injection.hasInjection) {
    return { message: `injection detected (${injection.reasons.join(", ")})`, event: { detection: "injection", reasons: injection.reasons, content, source } };
  }
  const secret = detectSecrets(content);
  if (secret.hasSecret) {
    return { message: `secret detected (${secret.secrets.join(", ")})`, event: { detection: "secret", reasons: secret.secrets, content, source } };
  }
  return null;
}

/** Scan persisted entries for injection and secrets (Task B). */
export function scanMemoryEntries(entries: MemoryEntry[]): Array<{ entry: MemoryEntry; issues: { detection: "injection" | "secret"; reasons: string[] }[] }> {
  const results: Array<{ entry: MemoryEntry; issues: { detection: "injection" | "secret"; reasons: string[] }[] }> = [];
  for (const entry of entries) {
    const issues: { detection: "injection" | "secret"; reasons: string[] }[] = [];
    const injection = detectPromptInjection(entry.content);
    if (injection.hasInjection) issues.push({ detection: "injection", reasons: injection.reasons });
    const secret = detectSecrets(entry.content);
    if (secret.hasSecret) issues.push({ detection: "secret", reasons: secret.secrets });
    if (issues.length > 0) results.push({ entry, issues });
  }
  return results;
}