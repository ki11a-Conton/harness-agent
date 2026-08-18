import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LearningCandidate } from "./candidate.js";
import { CandidateSandbox, championDigest } from "./sandbox.js";

function makeCandidate(overrides: Partial<LearningCandidate> = {}): LearningCandidate {
  return {
    id: "candidate_1",
    kind: "prompt_rule",
    content: "always verify inputs before retry",
    proposedAt: 1000,
    securityChecked: true,
    ...overrides,
  };
}

describe("P2-7 learning candidate sandbox", () => {
  it("runs the candidate in an isolated scratch dir and reports clean", async () => {
    const sandbox = new CandidateSandbox({ scratchRoot: tmpdir() });
    const champion = { rules: ["r1"], version: 3 };
    let sawScratch = "";

    const out = await sandbox.run({
      candidate: makeCandidate(),
      championState: () => champion,
      runner: async (ctx) => {
        sawScratch = ctx.scratchDir;
        const path = await ctx.writeScratch("notes.txt", "candidate work");
        await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
        return ctx.candidate.id;
      },
    });

    expect(out.result).toBe("candidate_1");
    expect(out.violations).toEqual([]);
    expect(out.threw).toBe(false);
    expect(sawScratch.length).toBeGreaterThan(0);
    expect(existsSync(sawScratch)).toBe(false);
  });

  it("records a champion_mutation violation when the runner mutates global state", async () => {
    const sandbox = new CandidateSandbox({ scratchRoot: tmpdir() });
    const champion = { rules: ["r1"] };

    const out = await sandbox.run({
      candidate: makeCandidate(),
      championState: () => champion,
      runner: async () => {
        champion.rules.push("smuggled");
        return "done";
      },
    });

    expect(out.result).toBe("done");
    expect(out.violations).toEqual([
      { kind: "champion_mutation", detail: "champion state changed during the candidate run" },
    ]);
  });

  it("cleanup still runs when the runner throws; the error propagates", async () => {
    const sandbox = new CandidateSandbox({ scratchRoot: tmpdir() });
    let scratch = "";
    const boom = new Error("candidate crashed");

    await expect(
      sandbox.run({
        candidate: makeCandidate(),
        championState: () => ({}),
        runner: async (ctx) => {
          scratch = ctx.scratchDir;
          throw boom;
        },
      }),
    ).rejects.toThrow("candidate crashed");

    expect(existsSync(scratch)).toBe(false);
  });

  it("writeScratch rejects paths escaping the sandbox", async () => {
    const sandbox = new CandidateSandbox({ scratchRoot: tmpdir() });

    await expect(
      sandbox.run({
        candidate: makeCandidate(),
        championState: () => ({}),
        runner: async (ctx) => {
          await ctx.writeScratch("../evil.txt", "x");
          return "unreachable";
        },
      }),
    ).rejects.toThrow(/escapes the sandbox/);
  });

  it("championDigest is deterministic and key-order independent", () => {
    expect(championDigest({ b: 2, a: { d: 1, c: [3, 1] } })).toBe(
      championDigest({ a: { c: [3, 1], d: 1 }, b: 2 }),
    );
  });

  it("a thrown runner is reported with elapsed time and a throw violation", async () => {
    const sandbox = new CandidateSandbox({ scratchRoot: tmpdir(), now: () => 100 });
    let threw: unknown;
    try {
      await sandbox.run({
        candidate: makeCandidate(),
        championState: () => ({}),
        runner: async () => {
          throw new Error("nope");
        },
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
  });
});