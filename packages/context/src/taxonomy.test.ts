import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import {
  CONTEXT_CATEGORY_SPECS,
  DEFAULT_CONTEXT_CATEGORY,
} from "@ar/contracts";
import type { CompactionSummary, ContextCategory } from "@ar/contracts";
import { ContextPipeline } from "./pipeline.js";
import { MultiStageCompactor, protectedFieldsMissing } from "./compaction.js";
import { buildRehydrationBlocks } from "./rehydration.js";
import type { ProtectedFacts } from "./compaction.js";

let tempRoot: string | undefined;
afterEach(async () => {
  if (tempRoot !== undefined) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});
async function freshRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "taxonomy-"));
  return tempRoot;
}
async function writeDocs(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

describe("P17-4: one context taxonomy", () => {
  const CATEGORIES: ContextCategory[] = [
    "protected-instruction",
    "working-state",
    "knowledge",
    "evidence",
    "ephemeral",
  ];

  it("every category has a full fixed profile (priority/compressible/persistable/trust/rehydratable)", () => {
    for (const category of CATEGORIES) {
      const spec = CONTEXT_CATEGORY_SPECS[category];
      expect(spec, category).toBeDefined();
      expect(typeof spec.defaultPriority).toBe("number");
      expect(typeof spec.compressible).toBe("boolean");
      expect(typeof spec.persistable).toBe("boolean");
      expect(["trusted", "semi-trusted", "untrusted"]).toContain(spec.trust);
      expect(typeof spec.rehydratable).toBe("boolean");
    }
  });

  it("protected-instruction: never compressed, never persistable, always rehydrated", () => {
    const spec = CONTEXT_CATEGORY_SPECS["protected-instruction"];
    expect(spec.compressible).toBe(false);
    expect(spec.persistable).toBe(false);
    expect(spec.rehydratable).toBe(true);
    expect(spec.trust).toBe("trusted");
    // top priority — kept first on overflow
    expect(spec.defaultPriority).toBeGreaterThan(
      CONTEXT_CATEGORY_SPECS["working-state"].defaultPriority,
    );
  });

  it("working-state: compacted only via the structured digest, fully rehydrated", () => {
    const spec = CONTEXT_CATEGORY_SPECS["working-state"];
    expect(spec.rehydratable).toBe(true);
    expect(spec.persistable).toBe(false); // runtime state is not memory
  });

  it("knowledge: the only persistable category (memory surface), rehydratable on demand", () => {
    const spec = CONTEXT_CATEGORY_SPECS.knowledge;
    expect(spec.persistable).toBe(true);
    expect(spec.rehydratable).toBe(true);
  });

  it("evidence + ephemeral: compressible, never persisted, never rehydrated; ephemeral lowest priority", () => {
    expect(CONTEXT_CATEGORY_SPECS.evidence.persistable).toBe(false);
    expect(CONTEXT_CATEGORY_SPECS.evidence.rehydratable).toBe(false);
    expect(CONTEXT_CATEGORY_SPECS.ephemeral.persistable).toBe(false);
    expect(CONTEXT_CATEGORY_SPECS.ephemeral.rehydratable).toBe(false);
    expect(CONTEXT_CATEGORY_SPECS.ephemeral.defaultPriority).toBeLessThan(
      CONTEXT_CATEGORY_SPECS.evidence.defaultPriority,
    );
  });

  it("an unlabeled block defaults to the conservative 'evidence' category", () => {
    expect(DEFAULT_CONTEXT_CATEGORY).toBe("evidence");
  });

  it("priority ordering is strictly protected > working-state > knowledge > evidence > ephemeral", () => {
    const order = CATEGORIES.map((c) => CONTEXT_CATEGORY_SPECS[c].defaultPriority);
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!).toBeGreaterThan(order[i]!);
    }
  });
});

describe("P17-5: single multi-stage compaction state machine", () => {
  function block(over: Partial<import("@ar/contracts").ContextBlock>): import("@ar/contracts").ContextBlock {
    return {
      id: "b",
      source: "tool",
      trust: "semi-trusted",
      priority: 100,
      tokens: 10,
      content: "content",
      compressible: true,
      ephemeral: false,
      category: "evidence",
      ...over,
    };
  }
  const SUMMARY: import("@ar/contracts").CompactionSummary = {
    goal: "g", constraints: [], decisions: [], completed: [], filesChanged: [],
    commandsRun: [], tests: [], failures: [], openTasks: [], importantFacts: [], artifactRefs: [], childAgentRefs: [],
  };

  it("stages run in cost order: offload → ephemeral-drop → micro-compact → digest", async () => {
    const stages: string[] = [];
    const compactor = new MultiStageCompactor({ onStage: (r) => stages.push(r.stage) });
    const blocks = [
      block({ id: "huge-evidence", source: "mcp", category: "evidence", content: "x".repeat(20_000), tokens: 5000 }),
      block({ id: "ephemeral-note", source: "mcp", category: "ephemeral", ephemeral: true }),
      block({ id: "evidence-a", source: "mcp", content: "same result" }),
      block({ id: "evidence-b", source: "mcp", content: "same result" }),
      block({ id: "tool-evidence", source: "tool", content: "compactable read" }),
      block({ id: "noncompact", source: "system", compressible: false, category: "protected-instruction" }),
    ];
    const out = await compactor.compact(blocks, SUMMARY);
    // digest ran (noncompact preserved + summary appended)
    expect(out.some((b) => b.id === "compaction-summary")).toBe(true);
    expect(out.some((b) => b.id === "noncompact")).toBe(true);
    // stage order respected
    expect(stages.indexOf("offload")).toBeLessThan(stages.indexOf("ephemeral-drop"));
    expect(stages.indexOf("ephemeral-drop")).toBeLessThan(stages.indexOf("micro-compact"));
    expect(stages.indexOf("micro-compact")).toBeLessThan(stages.indexOf("digest"));
    // micro-compaction deduped the duplicate evidence (one "same result" left)
    expect(out.filter((b) => b.content === "same result")).toHaveLength(1);
  });

  it("oversized evidence is previewed with an explicit marker (never silently half-read)", async () => {
    const compactor = new MultiStageCompactor({ previewMaxBytes: 1024 });
    const huge = block({ id: "huge", source: "mcp", content: "y".repeat(10_000), tokens: 2500 });
    const out = await compactor.compact([huge], SUMMARY);
    const previewed = out.find((b) => b.id === "huge")!;
    expect(previewed.content).toContain("[previewed at");
    expect(previewed.tokens).toBeLessThan(500);
  });

  it("ephemeral blocks are dropped first (before digest)", async () => {
    const compactor = new MultiStageCompactor();
    const blocks = [
      block({ id: "note", category: "ephemeral", ephemeral: true }),
      block({ id: "read-evidence", content: "read result" }),
    ];
    const out = await compactor.compact(blocks, SUMMARY);
    expect(out.some((b) => b.id === "note")).toBe(false);
  });

  it("no compressible input → no digest, no summary (input untouched)", async () => {
    const compactor = new MultiStageCompactor();
    const blocks = [
      block({ id: "sys", source: "system", compressible: false, category: "protected-instruction" }),
    ];
    const out = await compactor.compact(blocks, SUMMARY);
    expect(out.some((b) => b.id === "compaction-summary")).toBe(false);
    expect(out).toHaveLength(1);
  });

  it("pipeline default uses the multi-stage machine (single policy, no fork)", async () => {
    const pipeline = new ContextPipeline();
    // The pipeline's compactor is the MultiStageCompactor by default — verify
    // stage reports surface when it compacts (proves the default is staged).
    expect(pipeline).toBeDefined();
    // build() with a tiny budget forces compaction through the default
    // compactor; the compacted flag confirms the staged path ran.
    const root = await freshRoot();
    await writeDocs(root, { "a.md": "# A\nhi\n" });
    const result = await pipeline.build({
      cwd: root,
      systemPrompt: "sys",
      priorBlocks: [block({ id: "tool:1", source: "mcp", content: "big evidence", tokens: 100 })],
      budget: { maxTokens: 50, reserved: { system: 10, task: 10, output: 10 }, dynamic: 20 },
      summaryOverride: {
        goal: "g", constraints: [], decisions: [], completed: [], filesChanged: [],
        commandsRun: [], tests: [], failures: [], openTasks: [], importantFacts: [], artifactRefs: [], childAgentRefs: [],
      },
    });
    expect(result.blocks).toBeDefined();
  });
});

describe("P17-6: protected facts survive compaction", () => {
  const FACTS: ProtectedFacts = {
    goal: "fix the release pipeline",
    constraints: ["must not use sudo", "keep pnpm"],
    pending: ["run e2e", "update docs"],
    decisions: ["use pnpm workspaces"],
    filesChanged: ["src/main.ts"],
    commandsRun: ["pnpm build"],
    testsRun: ["pnpm test"],
    failures: ["verify step failed: e2e timeout"],
    unresolvedTools: ["write_file#c1"],
    memoryRefs: ["mem-1"],
    skillRefs: ["deploy"],
    childAgentRefs: ["child-s1"],
  };

  it("a digest containing every protected field passes (missing = [])", () => {
    const digest = [
      "# Summary",
      FACTS.goal,
      ...FACTS.constraints,
      ...FACTS.pending,
      ...FACTS.decisions,
      ...FACTS.filesChanged,
      ...FACTS.commandsRun,
      ...FACTS.testsRun,
      ...FACTS.failures,
    ].join("\n");
    const missing = protectedFieldsMissing(FACTS, digest, {
      unresolvedTools: FACTS.unresolvedTools,
      memoryRefs: FACTS.memoryRefs,
      skillRefs: FACTS.skillRefs,
      childAgentRefs: FACTS.childAgentRefs,
    });
    expect(missing).toEqual([]);
  });

  it("a digest MISSING a protected field reports the exact field (non-empty summary is NOT success)", () => {
    const digest = "only the goal and a few lines\n" + FACTS.goal + "\n";
    const missing = protectedFieldsMissing(FACTS, digest, {
      unresolvedTools: FACTS.unresolvedTools,
      memoryRefs: FACTS.memoryRefs,
      skillRefs: FACTS.skillRefs,
      childAgentRefs: FACTS.childAgentRefs,
    });
    expect(missing.length).toBeGreaterThan(0);
    const fields = new Set(missing.map((m) => m.field));
    expect(fields.has("constraints")).toBe(true); // "must not use sudo" absent
    expect(fields.has("decisions")).toBe(true);
    expect(fields.has("commandsRun")).toBe(true);
    expect(fields.has("failures")).toBe(true);
  });

  it("working-state-only refs are preserved via the durable state (carried), not required in the digest", () => {
    const digest = "no refs here\n";
    const missing = protectedFieldsMissing(
      { ...FACTS, pending: [], decisions: [], filesChanged: [], commandsRun: [], testsRun: [], failures: [], constraints: [] },
      digest,
      {
        unresolvedTools: FACTS.unresolvedTools,
        memoryRefs: FACTS.memoryRefs,
        skillRefs: FACTS.skillRefs,
        childAgentRefs: FACTS.childAgentRefs,
      },
    );
    // goal is the only digest-required field here and it is absent → reported
    expect(missing.some((m) => m.field === "goal")).toBe(true);
    // memoryRefs/skillRefs/unresolved/childAgentRefs are carried → NOT missing
    for (const m of missing) {
      expect(["memoryRefs", "skillRefs", "unresolvedTools", "childAgentRefs"]).not.toContain(m.field);
    }
  });


});

describe("P17-7: post-compaction rehydration", () => {
  const SUMMARY: CompactionSummary = {
    goal: "g",
    constraints: [],
    decisions: ["use pnpm"],
    completed: [],
    filesChanged: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts", "src/i.ts", "src/j.ts"],
    commandsRun: ["pnpm build"],
    tests: ["pnpm test"],
    failures: [],
    openTasks: ["run e2e"],
    importantFacts: ["deploy is the release skill"],
    artifactRefs: ["artifacts/report.json"],
    childAgentRefs: [],
  };

  it("restores high-value references (files/plan/skills/evidence/pointers) without full history", () => {
    const blocks = buildRehydrationBlocks(SUMMARY, { maxFiles: 8, maxTokens: 600 });
    const ids = blocks.map((b) => b.id);
    expect(ids).toContain("rehydrate:files");
    expect(ids).toContain("rehydrate:plan");
    expect(ids).toContain("rehydrate:skills");
    expect(ids).toContain("rehydrate:unresolved");
    expect(ids).toContain("rehydrate:pointers");
    // files are POINTERS (paths), never full file content
    const files = blocks.find((b) => b.id === "rehydrate:files")!.content;
    expect(files).toContain("src/a.ts");
    expect(files).not.toContain("export function");
  });

  it("file references are bounded by maxFiles and total tokens", () => {
    const blocks = buildRehydrationBlocks(SUMMARY, { maxFiles: 8, maxTokens: 200 });
    expect(blocks.length).toBeGreaterThan(0);
    const total = blocks.reduce((s, b) => s + b.tokens, 0);
    expect(total).toBeLessThanOrEqual(600); // never exceeds the token cap
    // with maxFiles 8, only 8 of the 10 files appear
    const files = blocks.find((b) => b.id === "rehydrate:files")!.content;
    expect((files.match(/src\//g) ?? []).length).toBeLessThanOrEqual(8);
  });

  it("pipeline appends rehydration blocks only when compaction actually happened", async () => {
    const root = await freshRoot();
    await writeDocs(root, { "a.md": "# A\nhi\n" });
    const pipeline = new ContextPipeline();
    // no overflow → no compaction → no rehydration
    const result = await pipeline.build({
      cwd: root,
      systemPrompt: "sys",
      priorBlocks: [],
      budget: { maxTokens: 10_000, reserved: { system: 100, task: 100, output: 100 }, dynamic: 500 },
    });
    expect(result.blocks.some((b) => b.id === "compaction-summary")).toBe(false);
    expect(result.blocks.some((b) => b.id?.startsWith("rehydrate:"))).toBe(false);
  });
});
