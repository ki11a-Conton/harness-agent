import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { applyLineRange, applyReplace, lineDiff } from "../edit.js";

export interface EditFileInput {
  path: string;
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
}

export interface EditFileOutput {
  path: string;
  /** Text mode: number of replacements made. */
  replacements?: number;
  /** Line-range mode: number of lines replaced. */
  replacedLines?: number;
  /** Recorded before/after diff (P2-28). */
  diff: string[];
}

const fileSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  replaceAll: z.boolean().optional(),
  occurrence: z.number().int().min(1).optional(),
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional(),
  replacement: z.string().optional(),
});

/**
 * edit_file (VS-001 + P2-28). Two modes:
 *  - text mode: replace `oldText` → `newText` (first occurrence by default,
 *    `occurrence` targets an exact one, `replaceAll` replaces all). Fails when
 *    an explicit occurrence is out of range — never guesses.
 *  - line-range mode: replace lines [lineStart..lineEnd] with `replacement`,
 *    so a local change never requires reproducing the whole file.
 * Every successful edit records a before/after diff in the output.
 * All policy enforcement stays in the orchestrator.
 */
export const editFileTool: ToolDefinition<EditFileInput, EditFileOutput> = {
  name: "edit_file",
  description:
    "Edit a UTF-8 file: replace anchor text (first/occurrence/all) or replace a line range. Returns a recorded diff.",
  inputSchema: fileSchema,
  risk: "side_effect",
  metadata: {
    name: "edit_file",
    version: "2.0.0",
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
      const { readFile, writeFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const target = resolve(context.cwd, input.path);

      const isRange = input.lineStart !== undefined;
      if (isRange) {
        if (input.lineEnd === undefined || input.replacement === undefined) {
          return {
            status: "failed",
            error: errorInfo("TOOL_SCHEMA_ERROR", "edit_file range mode requires lineEnd and replacement"),
          };
        }
        if (input.oldText !== undefined || input.newText !== undefined) {
          return {
            status: "failed",
            error: errorInfo("TOOL_SCHEMA_ERROR", "edit_file range mode cannot be combined with oldText/newText"),
          };
        }
      } else if (input.oldText === undefined || input.newText === undefined) {
        return {
          status: "failed",
          error: errorInfo("TOOL_SCHEMA_ERROR", "edit_file text mode requires oldText and newText"),
        };
      }

      const before = await readFile(target, "utf8");
      const res = isRange
        ? applyLineRange(before, input.lineStart!, input.lineEnd!, input.replacement!)
        : applyReplace(before, input.oldText!, input.newText!, {
            replaceAll: input.replaceAll,
            occurrence: input.occurrence,
          });

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

      await writeFile(target, res.content, "utf8");
      const output: EditFileOutput = {
        path: target,
        diff: lineDiff(before, res.content),
        ...(isRange ? { replacedLines: res.count } : { replacements: res.count }),
      };
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
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};