import type { ContextBlock, Skill, SkillEffectiveness, SkillLoader } from "@ar/contracts";
import { type SkillUseFeedback } from "@ar/skills";
export interface SkillBodyBlockProviderDeps {
    loader: SkillLoader;
    /** Discovers the current skill index (shared with the runtime's skills
     *  provider so selection and body loading see the same set). */
    discover: () => Promise<Skill[] | undefined>;
    dataDir: string;
    now?: () => number;
}
export interface SkillBodyBlockProvider {
    /** Load bodies for the selected skill names and render context blocks. */
    load(names: readonly string[]): Promise<ContextBlock[]>;
    /** Record a feedback event on a named skill's funnel (P2-9). */
    record(name: string, feedback: SkillUseFeedback): Promise<void>;
    /** Latest effectiveness profile for a skill (undefined when never used). */
    effectivenessOf(name: string): Promise<SkillEffectiveness | undefined>;
    listEffectiveness(): Promise<Record<string, SkillEffectiveness>>;
    /** P6-4: token ROI for a skill (completed tasks per 1k injected tokens). */
    tokenROI(name: string): Promise<{
        tokensInjected: number;
        tasksCompleted: number;
        roiPer1k: number;
    }>;
}
/** Skill body blocks are wedged between the skill index and tool output. */
export declare const SKILL_BODY_PRIORITY = 450;
export declare const SKILL_BODY_PREFIX = "skill-body:";
/**
 * P2-8/P2-9: production skill body provider. `load` is called by the runtime
 * per context build with the skillSelector's picks; bodies are cached per
 * turn by the caller (the runtime already only asks once per build), and the
 * ledger accumulates the funnel. A body that fails the security scan is
 * skipped (the loader fired the denial event already) and never injected.
 */
export declare function createSkillBodyBlockProvider(deps: SkillBodyBlockProviderDeps): SkillBodyBlockProvider;
/** Name-keyed, JSONL-persisted effectiveness ledger (P2-9). Skill ids from
 *  the filesystem loader are not stable across discoveries, so effectiveness
 *  is keyed by the manifest name — the identity selection actually uses. */
export declare class SkillEffectivenessLedger {
    private readonly file;
    private readonly now;
    private loaded;
    private profiles;
    constructor(dataDir: string, now?: () => number);
    apply(name: string, feedback: SkillUseFeedback): Promise<void>;
    get(name: string): Promise<SkillEffectiveness | undefined>;
    list(): Promise<Record<string, SkillEffectiveness>>;
    /** P6-4: token ROI — completed tasks per 1k injected tokens (0 when no
     *  evidence). Feeds the retrieval self-optimization loop. */
    roiOf(name: string): Promise<{
        tokensInjected: number;
        tasksCompleted: number;
        roiPer1k: number;
    }>;
    private load;
    private persist;
}
//# sourceMappingURL=skill-context.d.ts.map