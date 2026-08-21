import type { ToolDefinition } from "@ar/contracts";
export interface WriteFileInput {
    path: string;
    content: string;
    append?: boolean;
}
export interface WriteFileOutput {
    path: string;
    bytes: number;
    /** P2-27: present when the write-safety guard rated the write "caution". */
    safetyWarning?: string;
    /** P2-27: flags from the write-safety guard, for observability. */
    safetyFlags?: string[];
}
/**
 * write_file (VS-001). Writes/append a UTF-8 file. All policy enforcement
 * (permission + sandbox path checks) happens in the orchestrator. P2-27:
 * the write-safety guard blocks destructive overwrites (existing large file →
 * tiny replacement with no backup checkpoint) before the write happens.
 */
export declare const writeFileTool: ToolDefinition<WriteFileInput, WriteFileOutput>;
//# sourceMappingURL=write-file.d.ts.map