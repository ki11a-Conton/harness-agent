import type { SkillIndexEntry, SkillSelectionContext } from "@ar/contracts";

/** A separate, opt-in agent strategy. The legacy selectSkills API is unchanged. */
export const TASK_SCOPED_SKILLS_STRATEGY_V1 = "task_scoped_skills_v1" as const;
export const TASK_SCOPED_SKILLS_MAX_RELEVANT_V1 = 5;

export interface TaskScopedSkillSelectionOptions {
  /** Cap for ordinary relevance matches. Explicit and required names survive it. */
  maxRelevantSkills?: number;
  /** Trusted host requirements; only names already present in the safe index survive. */
  requiredSkillNames?: readonly string[];
}

export interface TaskScopedSkillSelectionConfig extends TaskScopedSkillSelectionOptions {
  strategy: typeof TASK_SCOPED_SKILLS_STRATEGY_V1;
}

export interface TaskScopedSkillSelection {
  selected: SkillIndexEntry[];
  excluded: SkillIndexEntry[];
  reason: "relevance" | "required-or-explicit" | "unknown-fallback";
  explicitNames: string[];
  requiredNames: string[];
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "be", "this", "that", "it", "please", "using", "use", "do",
  "run", "fix", "task", "code",
]);
const GENERIC_HAN = new Set(["请帮", "帮我", "修复", "处理", "完成", "执行", "使用", "一个", "这个", "一下", "代码", "任务"]);

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** Preserve word boundaries for Latin/etc. Chinese has no required spaces,
 * so overlapping Han bigrams give a deterministic signal without a tokenizer
 * dependency. A single Han character is too ambiguous to be a relevance cue. */
function tokensOf(text: string): Set<string> {
  const normalized = normalize(text);
  const tokens = new Set<string>();
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) {
      const token = chars[i]! + chars[i + 1]!;
      if (!GENERIC_HAN.has(token)) tokens.add(`han:${token}`);
    }
  }
  for (const word of normalized.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+/gu) ?? []) {
    if ([...word].length >= 3 && !STOP_WORDS.has(word)) tokens.add(`word:${word}`);
  }
  return tokens;
}

function explicitlyNames(goal: string, name: string): boolean {
  const normalized = normalize(name).trim();
  if (normalized === "") return false;
  if (goal.trim() === normalized) return true;
  // Whole Chinese names can occur inside an unspaced sentence. Require at
  // least two characters; one-character names otherwise match unrelated prose.
  if (/^\p{Script=Han}{2,}$/u.test(normalized)) return goal.includes(normalized);
  const short = [...normalized].length < 3;
  let offset = 0;
  while (offset <= goal.length - normalized.length) {
    const at = goal.indexOf(normalized, offset);
    if (at === -1) return false;
    const before = [...goal.slice(0, at)].at(-1);
    const after = [...goal.slice(at + normalized.length)][0];
    const wordCharacter = (value: string | undefined) => value !== undefined &&
      /[\p{L}\p{N}_]/u.test(value) && !/\p{Script=Han}/u.test(value);
    const namedShortSkill = !short || before === "$" || before === "`" || before === "\"" || before === "'" ||
      /^(?:\s+(?:skill\b|技能)|技能)/u.test(goal.slice(at + normalized.length)) ||
      /(?:\bskill\s+|使用)$/u.test(goal.slice(0, at));
    if (!wordCharacter(before) && !wordCharacter(after) && namedShortSkill) return true;
    offset = at + normalized.length;
  }
  return false;
}

/** Select metadata names only. Skill bodies, permissions and revision/security
 * gates remain the existing host's responsibility. Unknown/no-overlap tasks
 * fail open to the original index rather than losing all procedural knowledge. */
export function selectTaskScopedSkills(
  index: readonly SkillIndexEntry[],
  taskGoal: string,
  opts: TaskScopedSkillSelectionOptions = {},
): TaskScopedSkillSelection {
  const k = opts.maxRelevantSkills ?? TASK_SCOPED_SKILLS_MAX_RELEVANT_V1;
  if (!Number.isSafeInteger(k) || k <= 0) throw new RangeError("maxRelevantSkills must be a positive safe integer");
  if (opts.requiredSkillNames !== undefined &&
      (!Array.isArray(opts.requiredSkillNames) || opts.requiredSkillNames.some((name) => typeof name !== "string" || name.trim() === ""))) {
    throw new TypeError("requiredSkillNames must contain non-empty skill names");
  }
  const goal = normalize(taskGoal);
  const goalTokens = tokensOf(goal);
  const required = new Set(opts.requiredSkillNames ?? []);
  const explicitRows = index.filter((row) => explicitlyNames(goal, row.name));
  const requiredRows = index.filter((row) => required.has(row.name));
  const protectedRows = new Set([...explicitRows, ...requiredRows]);
  const relevant = index.map((row, position) => {
    let overlap = 0;
    for (const token of tokensOf(`${row.name} ${row.description}`)) {
      if (goalTokens.has(token)) overlap++;
    }
    // Goal coverage rewards relevant terms. Appending unrelated description
    // words never dilutes an exact name or existing relevance match.
    return { row, position, overlap };
  }).filter((item) => item.overlap > 0);
  const ranked = relevant.filter((item) => !protectedRows.has(item.row))
    .sort((a, b) => b.overlap - a.overlap || a.position - b.position);
  const selectedRows = new Set([...protectedRows, ...ranked.slice(0, k).map((item) => item.row)]);
  const reason = relevant.length > 0 ? "relevance" : explicitRows.length > 0 ? "required-or-explicit" : "unknown-fallback";
  return {
    selected: reason === "unknown-fallback" ? [...index] : index.filter((row) => selectedRows.has(row)),
    excluded: reason === "unknown-fallback" ? [] : index.filter((row) => !selectedRows.has(row)),
    reason,
    explicitNames: explicitRows.map((row) => row.name),
    requiredNames: requiredRows.map((row) => row.name),
  };
}

/** Freeze policy values once per configured host; active goal comes from the
 * current context, including durable user steering, on every invocation. */
export function createTaskScopedSkillSelector(config: TaskScopedSkillSelectionConfig):
  (entries: SkillIndexEntry[], context: SkillSelectionContext) => SkillIndexEntry[] {
  if (config.strategy !== TASK_SCOPED_SKILLS_STRATEGY_V1) throw new RangeError("Unsupported skill selection strategy");
  selectTaskScopedSkills([], "", config);
  const options = Object.freeze({
    maxRelevantSkills: config.maxRelevantSkills ?? TASK_SCOPED_SKILLS_MAX_RELEVANT_V1,
    requiredSkillNames: Object.freeze([...(config.requiredSkillNames ?? [])]),
  });
  selectTaskScopedSkills([], "", options);
  return (entries, context) => selectTaskScopedSkills(entries, context.goal, options).selected;
}
