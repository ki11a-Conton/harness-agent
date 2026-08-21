// P2-8/P2-9: skill body loading + effectiveness funnel. Progressive
// disclosure is closed here: the runtime selects skills from the index
// (skillSelector) and asks this provider for the bodies of the selected
// names; the provider discovers → loads (FileSkillLoader, which scans for
// injection/secrets) → renders a semi-trusted skill body block → injects.
// Every selection/load/inject/outcome is accumulated into a name-keyed
// effectiveness ledger (P2-9) — a discovered skill is not an effective skill.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordSkillEffectiveness } from "@ar/skills";
/** Skill body blocks are wedged between the skill index and tool output. */
export const SKILL_BODY_PRIORITY = 450;
export const SKILL_BODY_PREFIX = "skill-body:";
const EFFECTIVENESS_FILE = "skill-effectiveness.jsonl";
function estimateSkillTokens(content) {
    return Math.ceil(Buffer.byteLength(content, "utf8") / 4);
}
/**
 * P2-8/P2-9: production skill body provider. `load` is called by the runtime
 * per context build with the skillSelector's picks; bodies are cached per
 * turn by the caller (the runtime already only asks once per build), and the
 * ledger accumulates the funnel. A body that fails the security scan is
 * skipped (the loader fired the denial event already) and never injected.
 */
export function createSkillBodyBlockProvider(deps) {
    const ledger = new SkillEffectivenessLedger(deps.dataDir, deps.now);
    // Process-level caches: discovery is a disk scan and bodies are large — a
    // long turn builds context many times, so re-scan/re-read per build would
    // be wasteful. Bodies are stable per process (skills are files).
    let discoveredSkills;
    const bodyCache = new Map();
    const ensureSkills = async () => {
        if (discoveredSkills === undefined)
            discoveredSkills = await deps.discover();
        return discoveredSkills;
    };
    return {
        async load(names) {
            const skills = await ensureSkills();
            if (skills === undefined)
                return [];
            const byName = new Map(skills.map((skill) => [skill.manifest.name, skill]));
            const blocks = [];
            for (const name of names) {
                const skill = byName.get(name);
                if (skill === undefined)
                    continue;
                let body = bodyCache.get(name);
                if (body === undefined) {
                    let loaded;
                    try {
                        loaded = await deps.loader.load(skill);
                    }
                    catch {
                        continue; // denied at load (injection/secret) — the loader emitted it
                    }
                    body = loaded.body ?? "";
                    if (body === "")
                        continue;
                    bodyCache.set(name, body);
                }
                blocks.push({
                    id: `${SKILL_BODY_PREFIX}${name}`,
                    source: "skill",
                    trust: "semi-trusted",
                    priority: SKILL_BODY_PRIORITY,
                    tokens: estimateSkillTokens(body),
                    content: body,
                    compressible: true,
                    ephemeral: false,
                    path: skill.path,
                    // P6-2: skill body blocks trace to the manifest name (stable across
                    // discovers — FileSkillLoader ids are not) for effectiveness/ROI.
                    provenance: {
                        kind: "skill",
                        serviceId: "skill-loader",
                        toolId: name,
                        version: skill.manifest.version,
                        trust: "semi-trusted",
                    },
                });
                // P2-9: loaded + injected are observable facts of this build.
                await ledger.apply(name, { kind: "loaded" });
                await ledger.apply(name, { kind: "injected" });
                // P6-4: injection cost is a token fact — ROI = outcome per token.
                await ledger.apply(name, { kind: "tokensUsed", count: blocks[blocks.length - 1].tokens });
            }
            return blocks;
        },
        record: (name, feedback) => ledger.apply(name, feedback),
        effectivenessOf: (name) => ledger.get(name),
        listEffectiveness: () => ledger.list(),
        tokenROI: (name) => ledger.roiOf(name),
    };
}
/** Name-keyed, JSONL-persisted effectiveness ledger (P2-9). Skill ids from
 *  the filesystem loader are not stable across discoveries, so effectiveness
 *  is keyed by the manifest name — the identity selection actually uses. */
export class SkillEffectivenessLedger {
    file;
    now;
    loaded = false;
    profiles = new Map();
    constructor(dataDir, now = Date.now) {
        this.file = join(dataDir, EFFECTIVENESS_FILE);
        this.now = now;
    }
    async apply(name, feedback) {
        await this.load();
        const skill = skillShell(name, this.profiles.get(name));
        const updated = recordSkillEffectiveness(skill, feedback, { at: this.now() });
        this.profiles.set(name, updated.effectiveness);
        await this.persist();
    }
    async get(name) {
        await this.load();
        return this.profiles.get(name);
    }
    async list() {
        await this.load();
        return Object.fromEntries(this.profiles);
    }
    /** P6-4: token ROI — completed tasks per 1k injected tokens (0 when no
     *  evidence). Feeds the retrieval self-optimization loop. */
    async roiOf(name) {
        await this.load();
        const profile = this.profiles.get(name);
        if (profile === undefined)
            return { tokensInjected: 0, tasksCompleted: 0, roiPer1k: 0 };
        const tokensInjected = profile.tokenCount;
        const tasksCompleted = profile.completedCount;
        return {
            tokensInjected,
            tasksCompleted,
            roiPer1k: tokensInjected > 0 ? (tasksCompleted / tokensInjected) * 1000 : 0,
        };
    }
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        let content;
        try {
            content = await readFile(this.file, "utf8");
        }
        catch {
            return;
        }
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "")
                continue;
            try {
                const record = JSON.parse(trimmed);
                this.profiles.set(record.name, record.effectiveness);
            }
            catch {
                // corrupt line: skip
            }
        }
    }
    async persist() {
        const lines = [...this.profiles.entries()].map(([name, effectiveness]) => JSON.stringify({ name, effectiveness }));
        await writeFile(this.file, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
    }
}
/** Minimal Skill shell so recordSkillEffectiveness's immutable update works
 *  without a real loader object (only `effectiveness` is consumed). */
function skillShell(name, effectiveness) {
    return {
        id: name,
        path: "",
        manifest: { name, description: "", version: "0.0.0" },
        status: "discovered",
        discoveredAt: 0,
        ...(effectiveness !== undefined ? { effectiveness } : {}),
    };
}
//# sourceMappingURL=skill-context.js.map