// P2-8/P2-9: skill body loading + effectiveness funnel. Progressive
// disclosure is closed here: the runtime selects skills from the index
// (skillSelector) and asks this provider for the bodies of the selected
// names; the provider discovers → loads (FileSkillLoader, which scans for
// injection/secrets) → renders a semi-trusted skill body block → injects.
// Every selection/load/inject/outcome is accumulated into a name-keyed
// effectiveness ledger (P2-9) — a discovered skill is not an effective skill.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ContextBlock,
  Skill,
  SkillEffectiveness,
  SkillId,
  SkillLoader,
  ToolPolicy,
} from "@ar/contracts";
import { isNodeErrorCode } from "@ar/contracts";
import {
  checkSkillRequiredTools,
  recordSkillEffectiveness,
  requiredToolsDenial,
  type SkillSecurityDenial,
  type SkillUseFeedback,
} from "@ar/skills";

export interface SkillBodyBlockProviderDeps {
  loader: SkillLoader;
  /** Discovers the current skill index (shared with the runtime's skills
   *  provider so selection and body loading see the same set). */
  discover: () => Promise<Skill[] | undefined>;
  dataDir: string;
  now?: () => number;
  /** P14-4: the host agent's conferred tool policy. A skill whose declared
   *  requiredTools are not allowed by this policy is never injected — the
   *  skill boundary may only narrow, never widen, the host tool capability. */
  toolPolicy?: ToolPolicy;
  /** P14-4: fired when a selected skill is denied because its requiredTools
   *  exceed the host tool policy (typed denial, never silent). */
  onRequiredToolsDenied?: (event: SkillSecurityDenial) => void;
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
  tokenROI(name: string): Promise<{ tokensInjected: number; tasksCompleted: number; roiPer1k: number }>;
}

/** Skill body blocks are wedged between the skill index and tool output. */
export const SKILL_BODY_PRIORITY = 450;
export const SKILL_BODY_PREFIX = "skill-body:";
const EFFECTIVENESS_FILE = "skill-effectiveness.jsonl";

function estimateSkillTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, "utf8") / 4);
}

/**
 * P2-8/P2-9: production skill body provider. `load` is called by the runtime
 * per context build with the skillSelector's picks; bodies are cached per
 * turn by the caller (the runtime already only asks once per build), and the
 * ledger accumulates the funnel. A body that fails the security scan is
 * skipped (the loader fired the denial event already) and never injected.
 */
export function createSkillBodyBlockProvider(deps: SkillBodyBlockProviderDeps): SkillBodyBlockProvider {
  const ledger = new SkillEffectivenessLedger(deps.dataDir, deps.now);
  // Process-level caches: discovery is a disk scan and bodies are large — a
  // long turn builds context many times, so re-scan/re-read per build would
  // be wasteful. Bodies are stable per process (skills are files).
  let discoveredSkills: Skill[] | undefined;
  const bodyCache = new Map<string, string>();
  const ensureSkills = async (): Promise<Skill[] | undefined> => {
    if (discoveredSkills === undefined) discoveredSkills = await deps.discover();
    return discoveredSkills;
  };
  return {
    async load(names) {
      const skills = await ensureSkills();
      if (skills === undefined) return [];
      const byName = new Map(skills.map((skill) => [skill.manifest.name, skill]));
      const blocks: ContextBlock[] = [];
      for (const name of names) {
        const skill = byName.get(name);
        if (skill === undefined) continue;
        // P14-4 skill boundary: a skill that declares required tools outside
        // the host's conferred tool policy is a capability widening — deny
        // injection (fail-closed) and surface the typed denial.
        const required = checkSkillRequiredTools(skill, deps.toolPolicy);
        if (!required.allowed) {
          deps.onRequiredToolsDenied?.(requiredToolsDenial(skill, required));
          continue;
        }
        let body = bodyCache.get(name);
        if (body === undefined) {
          let loaded: Skill;
          try {
            loaded = await deps.loader.load(skill);
          } catch {
            continue; // denied at load (injection/secret) — the loader emitted it
          }
          body = loaded.body ?? "";
          if (body === "") continue;
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
          category: "knowledge",
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
          // P14-5: skill bodies are semi-trusted DATA (procedural knowledge,
          // not policy) — never an instruction upgrade, never persistable into
          // memory on their own.
          instructional: false,
          persistable: false,
        });
        // P2-9: loaded + injected are observable facts of this build.
        await ledger.apply(name, { kind: "loaded" });
        await ledger.apply(name, { kind: "injected" });
        // P6-4: injection cost is a token fact — ROI = outcome per token.
        await ledger.apply(name, { kind: "tokensUsed", count: blocks[blocks.length - 1]!.tokens });
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
  private readonly file: string;
  private readonly now: () => number;
  private loaded = false;
  private profiles = new Map<string, SkillEffectiveness>();

  constructor(dataDir: string, now: () => number = Date.now) {
    this.file = join(dataDir, EFFECTIVENESS_FILE);
    this.now = now;
  }

  async apply(name: string, feedback: SkillUseFeedback): Promise<void> {
    await this.load();
    const skill = skillShell(name, this.profiles.get(name));
    const updated = recordSkillEffectiveness(skill, feedback, { at: this.now() });
    this.profiles.set(name, updated.effectiveness!);
    await this.persist();
  }

  async get(name: string): Promise<SkillEffectiveness | undefined> {
    await this.load();
    return this.profiles.get(name);
  }

  async list(): Promise<Record<string, SkillEffectiveness>> {
    await this.load();
    return Object.fromEntries(this.profiles);
  }

  /** P6-4: token ROI — completed tasks per 1k injected tokens (0 when no
   *  evidence). Feeds the retrieval self-optimization loop. */
  async roiOf(name: string): Promise<{ tokensInjected: number; tasksCompleted: number; roiPer1k: number }> {
    await this.load();
    const profile = this.profiles.get(name);
    if (profile === undefined) return { tokensInjected: 0, tasksCompleted: 0, roiPer1k: 0 };
    const tokensInjected = profile.tokenCount;
    const tasksCompleted = profile.completedCount;
    return {
      tokensInjected,
      tasksCompleted,
      roiPer1k: tokensInjected > 0 ? (tasksCompleted / tokensInjected) * 1000 : 0,
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (err) {
      // P14-6: only the expected "no effectiveness file yet" ENOENT is silent;
      // any other read error is a real failure and propagates.
      if (isNodeErrorCode(err, "ENOENT")) return;
      throw err;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const record = JSON.parse(trimmed) as { name: string; effectiveness: SkillEffectiveness };
        this.profiles.set(record.name, record.effectiveness);
      } catch (err) {
        // P14-6: a corrupt ledger line is data-loss evidence — reported, then
        // skipped so the rest of the ledger still loads.
        process.stderr.write(`[degraded] skill-ledger.corrupt-line: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  private async persist(): Promise<void> {
    const lines = [...this.profiles.entries()].map(([name, effectiveness]) =>
      JSON.stringify({ name, effectiveness }),
    );
    await writeFile(this.file, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
  }
}

/** Minimal Skill shell so recordSkillEffectiveness's immutable update works
 *  without a real loader object (only `effectiveness` is consumed). */
function skillShell(name: string, effectiveness?: SkillEffectiveness): Skill {
  return {
    id: name as SkillId,
    path: "",
    manifest: { name, description: "", version: "0.0.0" },
    status: "discovered",
    discoveredAt: 0,
    ...(effectiveness !== undefined ? { effectiveness } : {}),
  };
}
