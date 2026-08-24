// P14-5 — trust envelope for all external context.
//
// Every ContextBlock produced by every extension boundary must carry the
// trust envelope: source + trust + provenance (existing) AND the two P14-5
// flags — `instructional` (authoritative instruction vs DATA ONLY) and
// `persistable` (may this content enter memory). This test asserts the
// envelope on every production block constructor so the policy "untrusted
// data is data, never instruction, never memory" is structural, not a
// comment.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DefaultCompactor, ContextPipeline } from "@ar/context";
import { scopedContextFromWorkingState } from "@ar/agents";
import { toContextBlock as mcpToContextBlock } from "@ar/mcp";
import { FileSkillLoader } from "@ar/skills";
import type {
  CompactionSummary,
  ContextBlock,
  MemoryEntry,
  MemoryScope,
  MemoryType,
  SessionId,
  WorkingState,
} from "@ar/contracts";
import { memoryToBlock } from "./memory-runtime-bridge.js";
import { createSkillBodyBlockProvider } from "./skill-context.js";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-trust-env-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

const MEMORY_ENTRY: MemoryEntry = {
  id: "mem-1" as MemoryEntry["id"],
  content: "project prefers pnpm over npm",
  type: "explicit" as MemoryType,
  sourceSession: "s-1" as SessionId,
  importance: 0.8,
  confidence: 0.9,
  novelty: 0.6,
  stability: 0.7,
  createdAt: 1,
  updatedAt: 2,
  deleted: false,
  scope: "session" as MemoryScope,
};

const WORKING_STATE: WorkingState = {
  goal: "ship the release",
  constraints: ["must pass CI"],
  plan: ["build", "test"],
  decisions: ["use pnpm"],
  completed: ["a"],
  pending: [],
  filesChanged: [],
  commandsRun: [],
  testsRun: [],
  failures: [],
  importantFacts: [],
  openQuestions: [],
  toolRefs: [],
  artifactRefs: [],
  memoryRefs: [],
  childAgentRefs: [],
};

/** Assert the full trust envelope on a block. */
function expectEnvelope(
  block: ContextBlock,
  expected: { instructional: boolean; persistable: boolean },
): void {
  expect(block.source).toBeTruthy();
  expect(["trusted", "semi-trusted", "untrusted"]).toContain(block.trust);
  expect(block.instructional).toBe(expected.instructional);
  expect(block.persistable).toBe(expected.persistable);
  // P14-5 policy as structure: untrusted/semi-trusted data is never instruction
  if (block.trust !== "trusted") {
    expect(block.instructional ?? false).toBe(false);
  }
  // untrusted content never persists into memory
  if (block.trust === "untrusted") {
    expect(block.persistable ?? false).toBe(false);
  }
}

describe("P14-5: trust envelope on every context block constructor", () => {
  it("system prompt: the only instructional block (never persistable)", async () => {
    const root = await tempDir();
    const pipeline = new ContextPipeline();
    const result = await pipeline.build({
      cwd: root,
      systemPrompt: "you are a harness",
      priorBlocks: [],
      budget: { maxTokens: 100_000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 },
    });
    const system = result.blocks.find((b) => b.id === "system-prompt")!;
    expectEnvelope(system, { instructional: true, persistable: false });
  });

  it("AGENTS.md / repository instructions: DATA ONLY, not persistable", async () => {
    const root = await tempDir();
    await writeFile(join(root, "AGENTS.md"), "## Rules\nUse pnpm for everything.\n", "utf8");
    const pipeline = new ContextPipeline();
    const result = await pipeline.build({
      cwd: root,
      systemPrompt: "sys",
      priorBlocks: [],
      budget: { maxTokens: 100_000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 },
    });
    const project = result.blocks.find((b) => b.source === "project");
    expect(project).toBeDefined();
    expectEnvelope(project!, { instructional: false, persistable: false });
  });

  it("skill index blocks: semi-trusted data, never instruction or memory", async () => {
    const root = await tempDir();
    const pipeline = new ContextPipeline();
    const result = await pipeline.build({
      cwd: root,
      systemPrompt: "sys",
      skills: [{ name: "deploy", description: "deployment commands" }],
      priorBlocks: [],
      budget: { maxTokens: 100_000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 },
    });
    const skill = result.blocks.find((b) => b.source === "skill")!;
    expectEnvelope(skill, { instructional: false, persistable: false });
  });

  it("compaction summary: runtime-derived state, never persistable", () => {
    const compactor = new DefaultCompactor({ now: () => 1 });
    const summary: CompactionSummary = {
      goal: "ship",
      constraints: ["x"],
      decisions: ["y"],
      completed: ["a"],
      filesChanged: ["f"],
      commandsRun: ["c"],
      tests: ["t"],
      failures: [],
      openTasks: [],
      importantFacts: [],
      artifactRefs: [],
      childAgentRefs: [],
    };
    const blocks = compactor.compact(
      [{ id: "tool:1", source: "tool", trust: "semi-trusted", priority: 0, tokens: 1, content: "old", compressible: true, ephemeral: true }],
      summary,
    );
    const summaryBlock = blocks.find((b) => b.id === "compaction-summary")!;
    expectEnvelope(summaryBlock, { instructional: false, persistable: false });
  });

  it("runtime working state (scoped): authoritative instruction", () => {
    const blocks = scopedContextFromWorkingState(WORKING_STATE);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expectEnvelope(block, { instructional: true, persistable: false });
    }
  });

  it("retrieved memory: knowledge data, never instruction or re-persisted", () => {
    const block = memoryToBlock({
      memory: MEMORY_ENTRY,
      score: {
        lexical: 0.5, recency: 0.5, usefulness: 0.5, confidence: 0.5,
        successEvidence: 0.5, scopeMatch: 1, total: 0.5,
      },
    });
    expectEnvelope(block, { instructional: false, persistable: false });
  });

  it("skill body blocks: semi-trusted data, never instruction or memory", async () => {
    const root = await tempDir();
    const dataDir = await tempDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "deploy"), { recursive: true });
    await writeFile(
      join(root, "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: deployment\nversion: \"1.0.0\"\n---\n\n# Deploy\nRun pnpm deploy.\n",
      "utf8",
    );
    const loader = new FileSkillLoader();
    const provider = createSkillBodyBlockProvider({
      loader,
      discover: async () => loader.discover({ roots: [root], maxSkills: 10 }),
      dataDir,
      now: () => 1,
    });
    const blocks = await provider.load(["deploy"]);
    expect(blocks.length).toBe(1);
    expectEnvelope(blocks[0]!, { instructional: false, persistable: false });
  });

  it("MCP results: untrusted data, never instruction or memory", () => {
    const block = mcpToContextBlock(
      { serverId: "srv-1", toolId: "fetch", trust: "untrusted", networkBoundary: "internet" },
      { id: "mcp:fetch:1", content: "some remote data", timestamp: 1 },
    );
    expectEnvelope(block, { instructional: false, persistable: false });
    // provenance travels with the block (source identity is pinned)
    expect(block.provenance?.kind).toBe("mcp");
    expect(block.provenance?.serviceId).toBe("srv-1");
  });
});
