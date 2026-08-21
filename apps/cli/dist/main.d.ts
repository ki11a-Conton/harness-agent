import type { ModelProvider, PermissionPolicy } from "@ar/contracts";
import { ToolRegistry } from "@ar/tools";
import type { CommandDeps } from "./commands.js";
/**
 * Builtin tool set every `createDefaultDeps` host registers. Single source:
 * packages/tools/src/production-tools.ts (plan.md P0-5) — the 11-tool coding
 * profile. Kept as a names+registry helper so CLI/benchmark share one list.
 */
export declare const BUILTIN_TOOLS: readonly ["read_file", "write_file", "edit_file", "search_files", "grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands", "env_snapshot", "exec", "update_plan"];
/** §24 "build" profile: reads allowed; edits/exec/network ask for approval. */
export declare const DEFAULT_PERMISSIONS: PermissionPolicy;
export declare const DEFAULT_SYSTEM_PROMPT: string;
/** Default request model id for a real provider; the provider may still apply
 *  its own env-based default (e.g. OPENAI_MODEL) when configured. */
export declare const DEFAULT_MODEL_ID = "gpt-4o-mini";
export interface DefaultDepsOptions {
    /** Enables persistent stores (JSONL session/event, durable approval +
     *  checkpoint) under dataDir; when absent, in-memory stores are used
     *  (doctor reports WARNING). */
    dataDir?: string;
    /** Agent model ref; defaults to the resolved provider + DEFAULT_MODEL_ID. */
    model?: {
        providerId: string;
        modelId: string;
    };
    /** Test/advanced injection: replaces env-based provider resolution. */
    provider?: ModelProvider;
    /** P2: enable the memory + learning pipeline (pre-turn retrieval, post-turn
     *  reflection, `agent learn` promotion). Requires a dataDir — memories are
     *  never written into the workspace. */
    memory?: boolean;
}
export declare function registerBuiltinTools(registry: ToolRegistry): void;
/** Entry point: parse `agent <command> [args]` (process.argv includes the
 *  node binary and the script path) and run the command. */
export declare function main(argv: string[]): Promise<number>;
/** Pull `--data-dir <path>` / `--data-dir=<path>` out of argv before command
 *  dispatch, so runCommand only ever sees `agent <command> [args]`. */
export declare function extractDataDirFlag(argv: string[]): {
    args: string[];
    dataDir?: string;
};
/**
 * Default host wiring via the @ar/harness production composition root
 * (plan.md P0-3): interactive profile (read allow, edit/exec/network ask),
 * the 11-tool production registry, ContextPipeline + budget, skills and
 * artifact stores, persistent stores when a dataDir is provided (JSONL +
 * durable approval/checkpoint), the OpenAI-compatible provider when
 * OPENAI_API_KEY is set, and the real ToolOrchestrator pipeline (permission
 * → approval → sandbox).
 */
export declare function createDefaultDeps(options?: DefaultDepsOptions): Promise<CommandDeps>;
//# sourceMappingURL=main.d.ts.map