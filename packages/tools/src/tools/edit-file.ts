import { z } from "zod";
import { createHash } from "node:crypto";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { applyBatchReplace, applyLineRange, applyReplace, lineDiff, MAX_BATCH_EDITS, type TextEdit } from "../edit.js";
import {
  assertFileVersion, checkFileVersion, decodeEditableUtf8, fileSha256, readRegularFileBytes, writeRegularFileUtf8,
  FileOperationCancelled, FileVersionConflict, throwIfFileCancelled, withFileLock,
} from "../file-coordination.js";

export interface EditFileInput {
  path: string;
  /** Batch mode: unique disjoint anchors in one original snapshot; requires expectedSha256. */
  edits?: readonly TextEdit[];
  /** Text-anchor mode: the substring to replace. Omit in line-range mode. */
  oldText?: string;
  newText?: string;
  /** Replace all occurrences of `oldText`. */
  replaceAll?: boolean;
  /** Replace exactly the Nth (1-based) occurrence. */
  occurrence?: number;
  /** Line-range mode: 1-based inclusive start line. */
  lineStart?: number;
  /** Line-range mode: 1-based inclusive end line. */
  lineEnd?: number;
  /** Line-range mode: replacement for the [lineStart..lineEnd] region. */
  replacement?: string;
  /** Optional raw-byte read version. A mismatch fails without writing. */
  expectedSha256?: string;
  /** Strict editing requires a read version for ranges and repeated anchors.
   * Omission retains the existing first/occurrence/all compatibility API. */
  profile?: "compatibility" | "strict";
}

export interface EditFileOutput {
  path: string;
  /** Text mode: number of replacements made. */
  replacements?: number;
  /** Line-range mode: number of lines replaced. */
  replacedLines?: number;
  /** Bounded before/after preview; truncation is explicit. */
  diff: string[];
  /** Version of the exact UTF-8 bytes written by this successful edit.
   * A later edit must still validate it against the current file. */
  sha256: string;
}

const fileSchema = z.object({
  path: z.string().min(1),
  edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1).max(MAX_BATCH_EDITS).optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  replaceAll: z.boolean().optional(),
  occurrence: z.number().int().min(1).optional().describe("Select one non-overlapping match by its 1-based ordinal. Use only in text mode and omit replaceAll=true."),
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional(),
  replacement: z.string().optional(),
  expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  profile: z.enum(["compatibility", "strict"]).optional().describe("Strict range edits require expectedSha256. Without a version, a strict text anchor must have one possible start. Ambiguity errors identify the first two positions."),
});

/**
 * edit_file (VS-001 + P2-28). Three modes:
 *  - text mode: replace `oldText` → `newText` (first occurrence by default,
 *    `occurrence` targets an exact one, `replaceAll` replaces all). Fails when
 *    an explicit occurrence is out of range — never guesses.
 *  - line-range mode: replace lines [lineStart..lineEnd] with `replacement`,
 *    so a local change never requires reproducing the whole file.
 *  - batch mode: versioned edits[] matched against one original snapshot;
 *    all anchors preflight before one write.
 * Every successful edit records a before/after diff in the output.
 * All policy enforcement stays in the orchestrator.
 */
export const editFileTool: ToolDefinition<EditFileInput, EditFileOutput> = {
  name: "edit_file",
  description:
    "Edit a UTF-8 file by anchor, line range, or edits:[{oldText,newText},...]. Batch mode requires expectedSha256 from versioned read_file or the last successful edit; matches every unique, nonoverlapping anchor against the SAME original snapshot, validates all before a single write, and cannot mix legacy selection/range fields. Keep oldText small but unique; merge overlapping edits. On stale/missing/ambiguous anchors reread and recalculate. Identical final content fails without writing. Existing first/occurrence/all and strict range APIs remain available. Returns a bounded diff preview and sha256 of the written version; a later edit still checks that version.",
  inputSchema: fileSchema,
  risk: "side_effect",
  metadata: {
    name: "edit_file",
    version: "2.2.0",
    sideEffect: true,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "none",
    concurrencySafe: false,
  },
  async execute(input: EditFileInput, context: ToolExecutionContext): Promise<ToolResult<EditFileOutput>> {
    try {
      const { resolve } = await import("node:path");
      const target = resolve(context.cwd, input.path);

      const isBatch = input.edits !== undefined;
      const isRange = input.lineStart !== undefined || input.lineEnd !== undefined || input.replacement !== undefined;
      if (isBatch) {
        if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > MAX_BATCH_EDITS
          || input.edits.some(edit => !edit || typeof edit.oldText !== "string" || !edit.oldText.length || typeof edit.newText !== "string")) {
          return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", `batch edits require 1..${MAX_BATCH_EDITS} nonempty oldText/string newText pairs; no writes made`) };
        }
        if (input.expectedSha256 === undefined) {
          return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", "batch edits require expectedSha256; read_file with versioned=true and recalculate; no writes made") };
        }
        if ([input.oldText, input.newText, input.replaceAll, input.occurrence, input.lineStart, input.lineEnd, input.replacement].some(value => value !== undefined)) {
          return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", "batch edits cannot be combined with text/occurrence/range parameters; no writes made") };
        }
      } else if (isRange) {
        if (input.oldText !== undefined || input.newText !== undefined || input.occurrence !== undefined || input.replaceAll) {
          return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", "Choose one edit mode. A line range cannot be combined with oldText/newText, occurrence, or replaceAll=true.") };
        }
        if (input.lineStart === undefined || input.lineEnd === undefined || input.replacement === undefined) {
          return {
            status: "failed",
            error: errorInfo("TOOL_SCHEMA_ERROR", "edit_file range mode requires lineStart, lineEnd and replacement"),
          };
        }
        if (input.profile === "strict" && input.expectedSha256 === undefined) {
          return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", "strict range edits require expectedSha256; no writes made, read_file with versioned=true and recalculate") };
        }
      } else if (input.replaceAll && input.occurrence !== undefined) {
        return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", "Choose occurrence for one match or replaceAll=true for every match.") };
      } else if (input.oldText === undefined || input.newText === undefined) {
        return {
          status: "failed",
          error: errorInfo("TOOL_SCHEMA_ERROR", "edit_file text mode requires oldText and newText"),
        };
      }

      return await withFileLock(target, context.signal, async (): Promise<ToolResult<EditFileOutput>> => {
        const bytes = await readRegularFileBytes(target, context.signal).catch((err: NodeJS.ErrnoException) => {
          if (input.expectedSha256 !== undefined && ["ENOENT", "ENOTDIR", "EISDIR"].includes(err.code ?? "")) {
            throw new FileVersionConflict(target);
          }
          throw err;
        });
        throwIfFileCancelled(context.signal);
        assertFileVersion(bytes, input.expectedSha256, target);
        const before = decodeEditableUtf8(bytes);
        const res = isBatch
          ? applyBatchReplace(before, input.edits!)
          : isRange
          ? applyLineRange(before, input.lineStart!, input.lineEnd!, input.replacement!)
          : applyReplace(before, input.oldText!, input.newText!, {
              replaceAll: input.replaceAll,
              occurrence: input.occurrence,
              requireUnique: input.profile === "strict" && input.expectedSha256 === undefined,
            });

        if (res.ambiguous) {
          return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR",
            `strict edits of repeated anchors require expectedSha256; ${res.error}. Use read_file with versioned=true before retrying.`) };
        }
        if (!res.ok) {
          return {
            status: "failed",
            error: errorInfo(
              "PROCESS_ERROR",
              `edit_file: ${res.error} in ${target}${
                res.matched > 0 && input.occurrence !== undefined ? `; file has ${res.matched} occurrence(s)` : ""
              }`,
            ),
          };
        }

        if (res.content === before) {
          return { status: "failed", error: errorInfo("PROCESS_ERROR",
            "edit_file: no changes made; the replacement produced identical content. Inspect the current file and provide a different edit; no writes made.",
            { retryable: false, safeToRetry: false }) };
        }

        // JSON/JS strings can contain an unpaired UTF-16 surrogate. Node's
        // UTF-8 writer would silently replace it with U+FFFD, making the diff
        // describe different text from the committed bytes. Valid pairs stay.
        if (/[\uD800-\uDFFF]/u.test(res.content)) {
          return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR",
            "edit_file: replacement would produce invalid Unicode (unpaired surrogate); no writes made. Use complete Unicode characters and reread the affected text.",
            { retryable: false, safeToRetry: false }) };
        }

        // Prepare fallible/allocating receipt work before committing bytes.
        // pi follows the same boundary: a diff failure must not follow a write.
        const output: EditFileOutput = {
          path: target,
          diff: lineDiff(before, res.content),
          sha256: createHash("sha256").update(res.content, "utf8").digest("hex"),
          ...(isRange ? { replacedLines: res.count } : { replacements: res.count }),
        };

        // Best-effort pre-write check catches external changes observed here;
        // this is not an atomic CAS against arbitrary external writers.
        await checkFileVersion(target, input.expectedSha256 ?? fileSha256(bytes), context.signal);
        throwIfFileCancelled(context.signal);
        await writeRegularFileUtf8(target, res.content, { signal: context.signal });
        return {
          status: "success",
          output,
          evidence: [
            {
              type: "file",
              description: `edit_file: ${isRange ? `${res.count} line(s) replaced` : `${res.count} replacement(s)`}`,
              source: target,
              timestamp: Date.now(),
            },
          ],
        };
      });
    } catch (err) {
      if (err instanceof FileOperationCancelled) return { status: "cancelled" };
      if (err instanceof FileVersionConflict) return { status: "failed", error: errorInfo("PROCESS_ERROR", err.message, { retryable: false, safeToRetry: false }) };
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};
