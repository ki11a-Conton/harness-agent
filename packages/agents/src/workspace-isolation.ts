// P3-4/P3-5: child workspace isolation — session isolation alone is not
// workspace isolation. A write-capable child must never mutate the parent's
// working directory directly (plan.md AUDIT-013): it runs in an isolated
// copy and returns a structured patch the parent applies under conflict
// detection. Read-only children share the parent root (no write rights, so
// no isolation needed).

import type { SessionId } from "@ar/contracts";

/** Mode of a child workspace handle. */
export type ChildWorkspaceMode = "shared-readonly" | "isolated-copy";

/** One changed path in the child workspace, relative to the parent root. */
export interface WorkspacePatchEntry {
  path: string;
  kind: "added" | "modified" | "deleted" | "skipped";
  /** sha256 of the child version (added/modified). */
  contentHash?: string;
  /** New file content (added/modified, within the size cap). */
  content?: string;
  /** Parent's content hash at child start — the P3-5 conflict baseline.
   *  Present for added/modified/deleted entries in isolated-copy mode. */
  parentBaselineHash?: string;
  /** Why an entry was skipped (oversized / unreadable). */
  detail?: string;
}

/** Structured diff of the child's changes since its workspace was created. */
export interface WorkspacePatch {
  childSessionId: SessionId;
  entries: WorkspacePatchEntry[];
}

export interface ApplyPatchOptions {
  /** Never overwrite a path the parent changed since the child started
   *  (default true — conflict detection is the point of P3-5). */
  conflictCheck?: boolean;
  /** Max bytes of a file admitted into a patch (default 256 KiB). */
  maxPatchBytes?: number;
  /** Injectable clock for the result timestamps. */
  now?: () => number;
}

export interface ApplyPatchResult {
  applied: string[];
  conflicts: { path: string; detail: string }[];
  skipped: { path: string; detail: string }[];
}

/**
 * P3-4: the isolation contract the Delegator consumes. The harness owns the
 * concrete filesystem implementation; the delegator only asks for a handle
 * and later applies the child's patch (P3-5) under conflict detection.
 */
export interface ChildWorkspaceManager {
  /** Create the child's workspace. `writable:false` → shared parent root
   *  (read-only child); `writable:true` → isolated copy under a scratch
   *  location (never the parent root itself). */
  create(input: {
    parentRoot: string;
    childSessionId: SessionId;
    writable: boolean;
  }): Promise<ChildWorkspaceHandle>;

  /** Apply a child's patch to the parent workspace (physical merge). The
   *  default conflict check refuses to overwrite paths the parent changed
   *  while the child was running. */
  apply(parentRoot: string, patch: WorkspacePatch, opts?: ApplyPatchOptions): Promise<ApplyPatchResult>;
}

export interface ChildWorkspaceHandle {
  root: string;
  mode: ChildWorkspaceMode;
  /** Structured patch of the child's changes ([] for shared-readonly). */
  diff(): Promise<WorkspacePatch>;
  dispose(): Promise<void>;
}
