import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";

export interface EditFileInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface EditFileOutput {
  path: string;
  replacements: number;
}

/**
 * edit_file (VS-001). Replace oldText → newText (first occurrence, or all
 * when replaceAll=true). Fails loudly when the anchor is absent — never
 * guesses. All policy enforcement happens in the orchestrator.
 */
export const editFileTool: ToolDefinition<EditFileInput, EditFileOutput> = {
  name: "edit_file",
  description: "Replace text in a UTF-8 file (first occurrence, or all with replaceAll).",
  inputSchema: z.object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().optional(),
  }),
  risk: "side_effect",
  metadata: {
    name: "edit_file",
    version: "1.0.0",
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
      const content = await readFile(target, "utf8");
      if (!content.includes(input.oldText)) {
        return {
          status: "failed",
          error: errorInfo("PROCESS_ERROR", `edit_file: anchor not found in ${target} (${input.oldText.slice(0, 40)}${input.oldText.length > 40 ? "…" : ""})`),
        };
      }
      const replacements = input.replaceAll
        ? content.split(input.oldText).length - 1
        : 1;
      const updated = input.replaceAll
        ? content.split(input.oldText).join(input.newText)
        : content.replace(input.oldText, input.newText);
      await writeFile(target, updated, "utf8");
      return {
        status: "success",
        output: { path: target, replacements },
        evidence: [{ type: "file", description: `edit_file: ${replacements} replacement(s)`, source: target, timestamp: Date.now() }],
      };
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};