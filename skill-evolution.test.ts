import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Skill, SkillId } from "@ar/contracts";
import type {
  BenchCaseResult,
  BenchReport,
  BenchTotals,
  EvalOutcome,
  EvalStatus,
} from "@ar/evaluation";
import { SkillEvolver } from "./skill-evolution.js";
import { JsonlSkillStore, SKILLS_FILE_NAME, type SkillStoreLike } from "./skill-store.js";

const evolver = new SkillEvolver();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill_v1" as SkillId,
    path: join("skills", "workflow"),
    manifest: { name: "workflow", description: "does things", version: "1.0.0" },
    status: "loaded",
    body: "# v1 body",
    discoveredAt: 1000,
    ...overrides,
  };
}

const EMPTY_METRICS = {
  turn_count: 0,
  tool_call_count: 0,
  tokens_input: 0,
  tokens_output: 0,
  context_tokens: 0,
  compaction_count: 0,
  duration_ms: 0,
  retry_count: 0,
  verification_failures: 0,
  human_interventions: 0,
  estimated_cost: 0,
};

function outcome(status: EvalStatus, violations: string[]): EvalOutcome {
  return {
    caseId: "c",
    status,
    actualStatus: status,
    events: [],
    metrics: EMPTY_METRICS,
    violations,
    suite: "regression",
    judgeVersion: "1.0.0",
  };
}

// Fixture builder mirroring bench.ts winner/totals rules so the report passed
// to evaluate is internally consistent (summary matches per-case winners).
const STATUS_RANK: Record<EvalStatus, number> = { passed: 2, failed: 1, error: 0 };

function winnerOf(a: EvalOutcome, b: EvalOutcome): BenchCaseResult["winner"] {
  if (STATUS_RANK[a.status] > STATUS_RANK[b.status]) return "A";
  if (STATUS_RANK[b.status] > STATUS_RANK[a.status]) return "B";
  if (a.violations.length < b.violations.length) return "A";
  if (b.violations.length < a.violations.length) return "B";
  return a.status === "failed" ? "both_failed" : "tie";
}

function totalsOf(outcomes: EvalOutcome[]): BenchTotals {
  let success = 0;
  let safety = 0;
  let reliability = 0;
  let toolCalls = 0;
  let duration = 0;
  let cost = 0;
  for (const o of outcomes) {
    if (o.status === "passed") success += 1;
    if (o.violations.length === 0) safety += 1;
    if (o.status !== "error") reliability += 1;
    toolCalls += o.metrics.tool_call_count;
    duration += o.metrics.duration_ms;
    cost += o.metrics.estimated_cost;
  }
  const count = outcomes.length;
  return {
    success,
    safety,
    reliability,
    efficiency: count === 0 ? 0 : toolCalls / count,
    latency: count === 0 ? 0 : duration / count,
    cost,
  };
}

function reportOf(rows: Array<[EvalOutcome, EvalOutcome]>): BenchReport {
  return {
    cases: rows.map(([a, b], i) => ({
      caseId: `case-${i}`,
      resultA: a,
      resultB: b,
      winner: winnerOf(a, b),
    })),
    summary: {
      a: totalsOf(rows.map(([a]) => a)),
      b: totalsOf(rows.map(([, b]) => b)),
    },
  };
}

function emptyReport(): BenchReport {
  return {
    cases: [],
    summary: {
      a: { success: 0, safety: 0, reliability: 0, efficiency: 0, latency: 0, cost: 0 },
      b: { success: 0, safety: 0, reliability: 0, efficiency: 0, latency: 0, cost: 0 },
    },
  };
}

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function freshStore(): Promise<JsonlSkillStore> {
  tempDir = await mkdtemp(join(tmpdir(), "skills-evo-"));
  return new JsonlSkillStore({ dataDir: tempDir });
}

// ---------------------------------------------------------------------------
// createVersion
// ---------------------------------------------------------------------------

describe("SkillEvolver.createVersion (SKILL-EVO-001)", () => {
  it("bumps manifest.version 1.0.0 → 2.0.0 and swaps in the new body", () => {
    const base = makeSkill();
    const v2 = evolver.createVersion(base, "# new body", { now: () => 5000 });

    expect(v2.manifest.version).toBe("2.0.0");
    expect(v2.body).toBe("# new body");
    expect(v2.path).toBe(base.path);
    expect(v2.manifest.name).toBe(base.manifest.name);
  });

  it("yields 1.0.0 when no version is present (loader default 0.0.0)", () => {
    const base = makeSkill({ manifest: { name: "x", description: "", version: "0.0.0" } });
    const v2 = evolver.createVersion(base, "# body");

    expect(v2.manifest.version).toBe("1.0.0");
  });

  it("reads the version from headers first", () => {
    const base = makeSkill({
      manifest: { name: "x", description: "", version: "0.0.0" },
      headers: { name: "x", version: "3.1.4" },
    });
    const v2 = evolver.createVersion(base, "# body");

    expect(v2.manifest.version).toBe("4.0.0");
  });

  it("assigns a fresh id and stamps discoveredAt from the injected clock", () => {
    const base = makeSkill();
    const v2 = evolver.createVersion(base, "# body", { now: () => 1234 });

    expect(v2.id).not.toBe(base.id);
    expect(v2.discoveredAt).toBe(1234);
  });

  it("keeps the base status and falls back to eligible for terminal states", () => {
    expect(evolver.createVersion(makeSkill({ status: "loaded" }), "# b").status).toBe(
      "loaded",
    );
    expect(evolver.createVersion(makeSkill({ status: "active" }), "# b").status).toBe(
      "active",
    );
    expect(
      evolver.createVersion(makeSkill({ status: "deprecated" }), "# b").status,
    ).toBe("eligible");
    expect(evolver.createVersion(makeSkill({ status: "removed" }), "# b").status).toBe(
      "eligible",
    );
  });
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

describe("SkillEvolver.evaluate (§70 compare)", () => {
  it("promotes when v2 succeeds more with no safety regression", async () => {
    const v1 = makeSkill();
    const v2 = evolver.createVersion(v1, "# v2");
    const report = reportOf([
      [outcome("passed", []), outcome("passed", [])],
      [outcome("failed", ["x"]), outcome("passed", [])],
      [outcome("failed", []), outcome("failed", [])],
    ]);

    const verdict = await evolver.evaluate({ v1, v2, bench: async () => report });

    expect(verdict.decision).toBe("promote");
    expect(verdict.reason).toContain("success");
  });

  it("rolls back when v2 succeeds less", async () => {
    const v1 = makeSkill();
    const v2 = evolver.createVersion(v1, "# v2");
    const report = reportOf([
      [outcome("passed", []), outcome("passed", [])],
      [outcome("passed", []), outcome("failed", [])],
    ]);

    const verdict = await evolver.evaluate({ v1, v2, bench: async () => report });

    expect(verdict.decision).toBe("rollback");
    expect(verdict.reason).toContain("success");
  });

  it("holds when results are equivalent", async () => {
    const v1 = makeSkill();
    const v2 = evolver.createVersion(v1, "# v2");
    const report = reportOf([
      [outcome("passed", []), outcome("passed", [])],
      [outcome("passed", []), outcome("passed", [])],
    ]);

    const verdict = await evolver.evaluate({ v1, v2, bench: async () => report });

    expect(verdict.decision).toBe("hold");
    expect(verdict.reason).toContain("no significant difference");
  });

  it("holds and surfaces the error when the benchmark throws", async () => {
    const v1 = makeSkill();
    const v2 = evolver.createVersion(v1, "# v2");

    const verdict = await evolver.evaluate({
      v1,
      v2,
      bench: async () => {
        throw new Error("simulation crashed");
      },
    });

    expect(verdict.decision).toBe("hold");
    expect(verdict.reason).toContain("simulation crashed");
  });

  it("holds on an empty bench report", async () => {
    const v1 = makeSkill();
    const v2 = evolver.createVersion(v1, "# v2");

    const verdict = await evolver.evaluate({ v1, v2, bench: async () => emptyReport() });

    expect(verdict.decision).toBe("hold");
    expect(verdict.reason).toContain("empty bench report");
  });

  it("rolls back on a safety regression even when v2 improves success", async () => {
    const v1 = makeSkill();
    const v2 = evolver.createVersion(v1, "# v2");
    // a: 1 success / 1 safe; b: 3 success / 0 safe
    const report = reportOf([
      [outcome("passed", []), outcome("passed", ["side effect"])],
      [outcome("failed", ["x"]), outcome("passed", ["side effect"])],
      [outcome("failed", ["x"]), outcome("passed", ["side effect"])],
    ]);

    const verdict = await evolver.evaluate({ v1, v2, bench: async () => report });

    expect(verdict.decision).toBe("rollback");
    expect(verdict.reason).toContain("safety");
  });

  it("promotes on winner counts when success is tied", async () => {
    const v1 = makeSkill();
    const v2 = evolver.createVersion(v1, "# v2");
    // both succeed 2/2, but v2 has fewer violations in case 1 → winner B
    const report = reportOf([
      [outcome("passed", ["x"]), outcome("passed", [])],
      [outcome("passed", []), outcome("passed", [])],
    ]);

    const verdict = await evolver.evaluate({ v1, v2, bench: async () => report });

    expect(verdict.decision).toBe("promote");
    expect(verdict.reason).toContain("wins");
  });

  it("gates promotion on the threshold", async () => {
    const v1 = makeSkill();
    const v2 = evolver.createVersion(v1, "# v2");
    // delta = 1 success in favor of v2
    const report = reportOf([
      [outcome("passed", []), outcome("passed", [])],
      [outcome("failed", ["x"]), outcome("passed", [])],
    ]);

    const open = await evolver.evaluate({ v1, v2, bench: async () => report });
    const strict = await evolver.evaluate({
      v1,
      v2,
      bench: async () => report,
      threshold: 1,
    });

    expect(open.decision).toBe("promote");
    expect(strict.decision).toBe("hold");
  });
});

// ---------------------------------------------------------------------------
// promote / rollback
// ---------------------------------------------------------------------------

describe("SkillEvolver promote/rollback (§70 store writes)", () => {
  it("promote saves v2 as active and returns it", async () => {
    const store = await freshStore();
    const v1 = makeSkill({ status: "active" });
    await store.save(v1);
    const v2 = evolver.createVersion(v1, "# v2 body");

    const promoted = await evolver.promote(v1, v2, store);

    expect(promoted.status).toBe("active");
    expect(promoted.body).toBe("# v2 body");
    const stored = await store.get(v2.id);
    expect(stored?.status).toBe("active");
    expect(stored?.body).toBe("# v2 body");
  });

  it("promote rejects a version of a different skill (lineage guard)", async () => {
    const store = await freshStore();
    const v1 = makeSkill();
    const foreign = makeSkill({ id: "skill_other" as SkillId, path: join("skills", "other") });

    await expect(evolver.promote(v1, foreign, store)).rejects.toThrow();
  });

  it("rollback restores v1 as active and deprecates v2", async () => {
    const store = await freshStore();
    const v1 = makeSkill({ status: "active", body: "# v1 body" });
    await store.save(v1);
    const v2 = evolver.createVersion(v1, "# v2 body");
    await evolver.promote(v1, v2, store);

    const restored = await evolver.rollback(v1, store);

    expect(restored.status).toBe("active");
    expect(restored.body).toBe("# v1 body");
    const afterV1 = await store.get(v1.id);
    expect(afterV1?.status).toBe("active");
    expect(afterV1?.body).toBe("# v1 body");
    const all = await store.list();
    const deprecatedV2 = all.find((s) => s.id === v2.id);
    expect(deprecatedV2?.status).toBe("deprecated");
    expect(deprecatedV2?.body).toBe("# v2 body");
  });

  it("rollback degrades gracefully on a save-only store", async () => {
    const saves: Skill[] = [];
    const store: SkillStoreLike = {
      save: async (s: Skill) => {
        saves.push(s);
      },
    };
    const v1 = makeSkill({ status: "active", body: "# v1 body" });

    const restored = await evolver.rollback(v1, store);

    expect(restored.status).toBe("active");
    expect(restored.body).toBe("# v1 body");
    expect(saves).toHaveLength(1);
    expect(saves[0]?.status).toBe("active");
    expect(saves[0]?.body).toBe("# v1 body");
  });
});

// ---------------------------------------------------------------------------
// JsonlSkillStore
// ---------------------------------------------------------------------------

describe("JsonlSkillStore (SKILL-EVO-001)", () => {
  it("save is an idempotent upsert keyed by id", async () => {
    const store = await freshStore();
    const skill = makeSkill({ id: "skill_a" as SkillId, body: "# one" });

    await store.save(skill);
    await store.save({ ...skill, body: "# two" });

    expect(await store.list()).toHaveLength(1);
    expect((await store.get(skill.id))?.body).toBe("# two");
  });

  it("update replaces an existing record and throws for unknown ids", async () => {
    const store = await freshStore();
    const skill = makeSkill({ id: "skill_a" as SkillId, body: "# one" });

    await store.save(skill);
    await store.update({ ...skill, status: "deprecated" });

    expect((await store.get(skill.id))?.status).toBe("deprecated");
    await expect(store.update(makeSkill())).rejects.toThrow();
  });

  it("persists across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-evo-persist-"));
    tempDir = dir;
    const skill = makeSkill({ id: "skill_a" as SkillId, body: "# body" });

    await new JsonlSkillStore({ dataDir: dir }).save(skill);
    const reopened = await new JsonlSkillStore({ dataDir: dir }).get(skill.id);

    expect(reopened?.body).toBe("# body");
  });

  it("skips corrupt lines on read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-evo-corrupt-"));
    tempDir = dir;
    const skill = makeSkill({ id: "skill_a" as SkillId });
    await writeFile(
      join(dir, SKILLS_FILE_NAME),
      `{not json}\n${JSON.stringify(skill)}\n`,
      "utf8",
    );

    const all = await new JsonlSkillStore({ dataDir: dir }).list();

    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(skill.id);
  });

  it("returns an empty list for a missing file and undefined for unknown ids", async () => {
    const store = await freshStore();

    expect(await store.list()).toEqual([]);
    expect(await store.get("skill_ghost" as SkillId)).toBeUndefined();
  });
});
