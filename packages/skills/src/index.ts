// @ar/skills public surface.

// SKILL-001: progressive skill discovery/loading (metadata first, body on demand).
export { FileSkillLoader, truncationMarker } from "./skill-loader.js";
export type { FileSkillLoaderDeps } from "./skill-loader.js";

// SKILL-EVO-001: evidence-driven skill evolution (70) + JSONL skill store.
export { SkillEvolver } from "./skill-evolution.js";
export type {
  CreateVersionDeps,
  EvaluateDeps,
  EvolutionDecision,
  EvolutionVerdict,
  SkillEvolverDeps,
} from "./skill-evolution.js";
export { JsonlSkillStore, SKILLS_FILE_NAME } from "./skill-store.js";
export type { JsonlSkillStoreOptions, SkillStoreLike } from "./skill-store.js";

// P2-5: skill effectiveness tracking (discovered != effective).
export {
  averageToolLatencyOf,
  recordSkillEffectiveness,
  successRateOf,
} from "./effectiveness.js";
export type {
  SkillEffectivenessDelta,
  SkillUseFeedback,
  SkillUseOptions,
} from "./effectiveness.js";

// P0-7: unified skill security-deny record (code / event type / payload).
export {
  skillDenialCode,
  skillDenialEventType,
  skillDenialPayload,
} from "./skill-security.js";
export type { SkillSecurityDenial } from "./skill-security.js";

// P2-6: skill selection (index -> relevant selection -> body on demand).
export {
  DEFAULT_SELECT_K,
  DEFAULT_SELECT_MIN_SCORE,
  selectSkills,
  skillSimilarity,
} from "./selection.js";
export type {
  SelectSkillsOptions,
  SkillSelection,
} from "./selection.js";

export type {
  Skill,
  SkillEffectiveness,
  SkillIndexEntry,
  SkillManifest,
  SkillStatus,
  SkillLoader,
  SkillLoaderOptions,
} from "@ar/contracts";
