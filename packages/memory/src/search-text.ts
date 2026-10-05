import type { MemoryEntry } from "@ar/contracts";

/** Existing lexical memory body: content and the three rendered strategy fields.
 * Provenance and other metadata must not manufacture a search match. Legacy
 * malformed fields are ignored instead of coercing objects into search text. */
export function memorySearchText(entry: Pick<MemoryEntry, "content" | "structured">): string {
  const parts = [entry.content];
  const strategy: unknown = entry.structured;
  if (strategy !== null && typeof strategy === "object") {
    for (const field of ["when", "do", "avoid"] as const) {
      const value = (strategy as Record<string, unknown>)[field];
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n");
}

/** Case-insensitive literal substring or existing whole-word token matching.
 * No query punctuation is interpreted as SQL LIKE or FTS syntax here. */
/** Prepare immutable query work once per search. The closure owns no entry
 * state and is deliberately not cached across requests. */
export function prepareMemoryQuery(query: string): (content: string) => boolean {
  const q = query.toLowerCase();
  if (q.trim() === "") return () => false;
  const queryTokens = q.split(/\s+/).filter((token) => token !== "");
  return (content) => {
    const c = content.toLowerCase();
    if (c.includes(q)) return true;
    const contentTokens = new Set(c.split(/[^a-z0-9]+/).filter((token) => token !== ""));
    return queryTokens.every((token) => contentTokens.has(token));
  };
}

/** Compatibility for callers matching one body. Stores reuse the prepared
 * matcher instead of repeating query parsing for each candidate. */
export function matchesMemoryQuery(query: string, content: string): boolean {
  return prepareMemoryQuery(query)(content);
}
