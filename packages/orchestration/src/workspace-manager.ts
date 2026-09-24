/**
 * P33-9 — Per-work-item workspace isolation.
 *
 * Each item gets a deterministic workspace key: a sanitized identifier plus a
 * collision-resistant content hash suffix derived from the item id. No two
 * distinct identifiers may accidentally share a workspace. Deterministic so
 * the same item maps to the same workspace across restarts (resume/retry).
 *
 * Pure path computation only — the actual mkdir is done by the caller
 * (worker.ts) so orchestration remains filesystem-optional for tests.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface WorkspacePaths {
  /** Deterministic unique directory name (no path separators). */
  readonly key: string;
  /** Absolute path under the given root. */
  readonly dir: string;
}

/** Sanitize an identifier into a filesystem-safe segment. */
export function sanitizeKey(identifier: string): string {
  const cleaned = identifier
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return cleaned === "" ? "item" : cleaned.slice(0, 64);
}

/** Deterministic hash suffix for a work item id. */
export function hashSuffix(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

/** Deterministic per-item workspace paths. */
export function workspaceFor(identifier: string, id: string, root: string): WorkspacePaths {
  const key = `${sanitizeKey(identifier)}-${hashSuffix(id)}`;
  return { key, dir: join(root, key) };
}