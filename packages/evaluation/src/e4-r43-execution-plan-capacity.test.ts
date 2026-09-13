/**
 * E4-R43 (K04) — the PUBLIC planned-sample capacity contract, locked by FIXED
 * inputs that do NOT derive from the implementation constant.
 *
 * The problem (K04): the R38-b negative computes BOTH the input and the
 * expectation from `EXECUTION_PLAN_MAX_PLANNED_SAMPLES` (`repeat = CAP + 5`,
 * expected product `= (CAP + 5) * caseCount`). Raising the constant also grows
 * the input, so it still exceeds — the test keeps passing while the published
 * boundary moves underneath it. It is a useful MECHANISM check (the guard is
 * O(1), fires before expansion, and reports calibrated numbers) but it cannot
 * LOCK the contract.
 *
 * This suite adds the missing discrimination:
 *
 *   1. FIXED contract inputs — single case, `limit: null`, repeat = 999_999 /
 *      1_000_000 / 1_000_001 — expected  accept / accept / reject, with the
 *      reject carrying the capacity issue. The 1_000_000 contract is written as
 *      a literal here, independent of the implementation constant.
 *   2. MUTATION sensitivity — a temporary COPY of the real source is mutated
 *      (relaxed to 2_000_000 / tightened to 999_999) and really LOADED, proving
 *      the fixed inputs catch a moved boundary in both directions. The copy is
 *      destroyed afterwards; the worktree is never modified.
 *
 * No production change, no million-sample grid expansion (only the parser's
 * O(1) boundary validation is exercised), no machine-sensitive timing.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { fixtureExecutionPlan } from "./fixtures.js";
import { parseExecutionPlan, EXECUTION_PLAN_MAX_PLANNED_SAMPLES } from "./execution-plan.js";

const SRC_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CONSTANT_DECL = "export const EXECUTION_PLAN_MAX_PLANNED_SAMPLES = 1_000_000;";

/** The public contract, written LITERALLY (never derived from the impl const). */
const CONTRACT_MAX = 1_000_000;

/** A minimally valid promotion-grade plan whose grid is `repeat × 1` case. */
function fixedPlan(repeat: number): unknown {
  return { ...fixtureExecutionPlan({ suite: "holdout", caseIds: ["a"], repeat }), limit: null };
}

const capIssues = (issues: string[]): string[] => issues.filter((i) => i.includes("planned-sample cap"));

let tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

async function makeTemp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "e4-r43-"));
  tempDirs.push(d);
  return d;
}

/** A temporary copy of the REAL `execution-plan.ts` with the constant mutated.
 *  Only the sibling module is provided as a re-export of the REAL source (an
 *  absolute path back into the repo), so the copy loads the genuine dependency
 *  graph while remaining outside the worktree. */
async function mutatedCopy(suffix: string, replacement: string): Promise<{ constant: number; parse: typeof parseExecutionPlan }> {
  const root = await makeTemp();
  const copy = join(root, "evaluation-src");
  await mkdir(copy, { recursive: true });
  const planFile = join(copy, "execution-plan.ts");
  const original = await readFile(join(SRC_DIR, "execution-plan.ts"), "utf8");
  // Guard the mutation: the declaration must be present exactly as expected.
  expect(original).toContain(CONSTANT_DECL);
  await writeFile(planFile, original.replace(CONSTANT_DECL, `export const EXECUTION_PLAN_MAX_PLANNED_SAMPLES = ${replacement};`), "utf8");
  // The copy's one sibling import (`./manifest.js`) re-exports the REAL module.
  await writeFile(join(copy, "manifest.js"), `export * from ${JSON.stringify(join(SRC_DIR, "manifest.ts"))};\n`, "utf8");
  const mod = await import(`${pathToFileURL(planFile).href}?v=${suffix}`);
  return {
    constant: (mod as { EXECUTION_PLAN_MAX_PLANNED_SAMPLES: number }).EXECUTION_PLAN_MAX_PLANNED_SAMPLES,
    parse: (mod as { parseExecutionPlan: typeof parseExecutionPlan }).parseExecutionPlan,
  };
}

describe("E4-R43 (K04) public planned-sample capacity contract (fixed inputs)", () => {
  it("max−1 / max / max+1 are accepted / accepted / rejected, and the impl constant matches the contract", () => {
    // The fixed inputs are LITERAL (999_999 / 1_000_000 / 1_000_001), so they
    // cannot move with the implementation constant.
    for (const repeat of [CONTRACT_MAX - 1, CONTRACT_MAX]) {
      const parsed = parseExecutionPlan(fixedPlan(repeat));
      expect(parsed.issues).toEqual([]);
      expect(parsed.plan).not.toBeNull();
    }

    const over = parseExecutionPlan(fixedPlan(CONTRACT_MAX + 1));
    expect(over.plan).toBeNull();
    const cap = capIssues(over.issues);
    expect(cap).toHaveLength(1);
    expect(cap[0]).toContain("repeat(1000001)");
    expect(cap[0]).toContain("caseCount(1)");
    expect(cap[0]).toContain("1000001");
    expect(cap[0]).toContain("refuse before expansion");
    // No unrelated issue leaked: the capacity condition is the ONLY reason.
    expect(over.issues).toHaveLength(1);

    // The documented contract literal and the shipped constant agree.
    expect(EXECUTION_PLAN_MAX_PLANNED_SAMPLES).toBe(CONTRACT_MAX);
  });

  it("MUTATION: relaxing the constant to 2_000_000 makes the FIXED max+1 rejection impossible (fixed input is discriminating)", async () => {
    const m = await mutatedCopy("relax", "2_000_000");
    // The COPY's real source really loaded with the mutated constant.
    expect(m.constant).toBe(2_000_000);
    // The FIXED rejection input (1_000_001) would now be ACCEPTED — i.e. the
    // `expect(plan).toBeNull()` assertion above FAILS under this mutation.
    const atOldOver = m.parse(fixedPlan(CONTRACT_MAX + 1));
    expect(atOldOver.plan).not.toBeNull();
    expect(capIssues(atOldOver.issues)).toHaveLength(0);
    // The guard is still REAL: just beyond the mutated cap it still refuses.
    const atNewOver = m.parse(fixedPlan(2_000_001));
    expect(atNewOver.plan).toBeNull();
    expect(capIssues(atNewOver.issues)).toHaveLength(1);
  }, 60_000);

  it("MUTATION: tightening the constant to 999_999 makes the FIXED max acceptance impossible (fixed input is discriminating)", async () => {
    const m = await mutatedCopy("tighten", "999_999");
    expect(m.constant).toBe(999_999);
    // The FIXED acceptance input (1_000_000) would now be REJECTED — i.e. the
    // `expect(plan).not.toBeNull()` assertion above FAILS under this mutation.
    const atOldMax = m.parse(fixedPlan(CONTRACT_MAX));
    expect(atOldMax.plan).toBeNull();
    expect(capIssues(atOldMax.issues)).toHaveLength(1);
    // The still-in-range 999_999 remains accepted.
    expect(m.parse(fixedPlan(999_999)).plan).not.toBeNull();
  }, 60_000);
});
