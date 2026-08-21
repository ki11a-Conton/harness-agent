import type { EventStore, ModelProvider, PermissionPolicy, SandboxPolicy, SessionStore, SkillLoader } from "@ar/contracts";
/** Injectable probe surface for `agent doctor` (plan §87). */
export interface DoctorDeps {
    modelProvider?: ModelProvider;
    sandboxPolicy?: SandboxPolicy;
    permissions?: PermissionPolicy;
    workspaceRoot?: string;
    toolRegistry?: {
        list(): {
            name: string;
        }[];
    };
    skills?: SkillLoader;
    plugins?: {
        list(): unknown[];
    };
    sessionStore?: SessionStore;
    eventStore?: EventStore;
    /** Present when persistent (JSONL) stores are active. */
    dataDir?: string;
    /** True when the model's context window was unknown and the harness used
     *  the conservative fallback budget (plan.md P0-4: surface a warning). */
    contextBudgetFallback?: boolean;
    contextBudgetMaxTokens?: number;
}
export interface CheckResult {
    name: string;
    status: "OK" | "WARNING" | "ERROR";
    detail: string;
}
export declare function runChecks(deps: DoctorDeps): Promise<CheckResult[]>;
//# sourceMappingURL=doctor.d.ts.map