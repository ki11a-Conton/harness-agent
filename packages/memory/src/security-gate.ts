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

/** Scan the same text the model can receive, including structured lessons.
 * Keeping content in the scan also protects search/review surfaces. */
export function checkUnsafeMemoryEntry(
  entry: Pick<MemoryEntry, "content" | "structured">,
  source: string,
): UnsafeMemory | null {
  for (const content of visibleMemoryContents(entry)) {
    const reason = checkUnsafeMemory(content, source);
    if (reason !== null) return reason;
  }
  return null;
}

function visibleMemoryContents(entry: Pick<MemoryEntry, "content" | "structured">): string[] {
  return entry.structured === undefined ? [entry.content] : [
    entry.content,
    // String conversion matches the model renderer's interpolation for
    // legacy JSONL values; the SQLite metadata decoder checks field shapes.
    `When: ${entry.structured.when}\nDo: ${entry.structured.do}\nAvoid: ${entry.structured.avoid ?? ""}`,
  ];
}

/** Scan persisted entries for injection and secrets (Task B). */
export function scanMemoryEntries(entries: MemoryEntry[]): Array<{ entry: MemoryEntry; issues: { detection: "injection" | "secret"; reasons: string[] }[] }> {
  const results: Array<{ entry: MemoryEntry; issues: { detection: "injection" | "secret"; reasons: string[] }[] }> = [];
  for (const entry of entries) {
    const issues: { detection: "injection" | "secret"; reasons: string[] }[] = [];
    const contents = visibleMemoryContents(entry);
    const injectionReasons = new Set(contents.flatMap((content) => detectPromptInjection(content).reasons));
    if (injectionReasons.size > 0) issues.push({ detection: "injection", reasons: [...injectionReasons] });
    const secrets = new Set(contents.flatMap((content) => detectSecrets(content).secrets));
    if (secrets.size > 0) issues.push({ detection: "secret", reasons: [...secrets] });
    if (issues.length > 0) results.push({ entry, issues });
  }
  return results;
}
