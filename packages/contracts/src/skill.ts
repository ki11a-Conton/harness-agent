import type { SkillId } from "./ids.js";

export type SkillStatus =
  | "discovered"
  | "eligible"
  | "loaded"
  | "active"
  | "completed"
  | "deprecated"
  | "removed";

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  requiredTools?: string[];
}

export interface Skill {
  id: SkillId;
  path: string;
  manifest: SkillManifest;
  status: SkillStatus;
  /** SKILL.md body; populated when the skill is loaded. */
  body?: string;
  discoveredAt: number;
  headers?: Record<string, string>;
  /** P2-5: cumulative effectiveness profile (discovered ≠ effective). */
  effectiveness?: SkillEffectiveness;
  /** P17-3: skill provenance — where the skill came from and its trust
   *  classification (local filesystem = semi-trusted; remote = untrusted).
   *  Provenance/trust are part of the skill record so context building and
   *  capability gating never guess them. */
  provenance?: {
    /** "local-filesystem" | "remote" (e.g. fetched package / MCP skill). */
    source: "local-filesystem" | "remote";
    /** The root the skill was discovered under. */
    root: string;
    /** P17-3: trust level derived from the source (local → semi-trusted,
     *  remote → untrusted). Untrusted skills' bodies are pollution-prone. */
    trust: "trusted" | "semi-trusted" | "untrusted";
  };
}

/** P2-5: cumulative usage/outcome funnel. Absent until first feedback;
 *  scoring falls back to a neutral profile. History is never deleted. */
export interface SkillEffectiveness {
  /** Times the skill was selected for a task. */
  selectedCount: number;
  /** Times the body was actually loaded. */
  loadedCount: number;
  /** Times the body was injected into the model context. */
  injectedCount: number;
  /** Tasks completed while using the skill. */
  completedCount: number;
  /** Tasks failed while using the skill. */
  failedCount: number;
  /** Surrounding verification passed after use. */
  verificationPassedCount: number;
  /** Surrounding verification failed after use. */
  verificationFailedCount: number;
  /** Tool calls made under the skill. */
  toolCallCount: number;
  /** Tokens consumed under the skill. */
  tokenCount: number;
  /** Accumulated latency of tool calls under the skill (ms). */
  latencyMs: number;
  /** Last feedback timestamp. */
  lastUsedAt?: number;
}

export interface SkillStats {
  successRate: number;
  toolCalls: number;
  tokens: number;
  latencyMs: number;
  humanInterventions: number;
  verificationFailures: number;
  regressions: number;
}

/** SKILL-001: progressive loading — metadata first, body on demand. */
export interface SkillLoaderOptions {
  /** Directories scanned for skill packages (must contain SKILL.md). */
  roots: string[];
  /** Cap on metadata bytes read before parsing (default 64k). */
  maxMetadataBytes?: number;
  /** Cap on body bytes read when loading (default 256k). */
  maxBodyBytes?: number;
  /** Cap on the number of discovered skills (default 1000). */
  maxSkills?: number;
}

export interface SkillLoader {
  /** Discover skill metadata only (manifest + headers); body is not read. */
  discover(opts: SkillLoaderOptions): Promise<Skill[]>;
  /** Load the SKILL.md body of a previously discovered skill (on demand). */
  load(skill: Skill, opts?: Pick<SkillLoaderOptions, "maxBodyBytes">): Promise<Skill>;
}

/** P2-6: one skill index row injected into the system prompt (metadata only,
 *  never the body — bodies load on demand via SkillLoader.load). */
export interface SkillIndexEntry {
  name: string;
  description: string;
}