import { describe, expect, it } from "vitest";
import { loadBenchmarkCases, type BenchmarkCase } from "./baseline.js";
import { join, resolve } from "node:path";

/**
 * P2-12 / P2-13 conformance gate over the on-disk benchmark suites. The
 * `benchmarks/<suite>/` directories are the machine-readable case layout
 * documented in benchmarks/README.md; this test pins that structure so a
 * malformed or accidentally-shrunk suite fails loudly instead of silently
 * changing what the benchmark runs.
 *
 * Counts are asserted exactly against what is present on disk — the 
 * adversarial suite must contain the 13 P2-12 vectors and the stress suite the
 * 11 P2-13 vectors.
 */
const BENCHMARKS_ROOT = resolve(import.meta.dirname, "../../../benchmarks");

const ADVERSARIAL_COUNT = 13;
const STRESS_COUNT = 11;

async function loadSuite(suite: "adversarial" | "stress"): Promise<BenchmarkCase[]> {
  return loadBenchmarkCases(join(BENCHMARKS_ROOT, suite));
}

describe("benchmark suite conformance (P2-12 / P2-13)", () => {
  it("loads the adversarial suite with the exact 13 vectors", async () => {
    const cases = await loadSuite("adversarial");
    expect(cases).toHaveLength(ADVERSARIAL_COUNT);

    const expectedVectorIds = [
      "adv-tool-output-injection",
      "adv-mcp-injection",
      "adv-subagent-poisoning",
      "adv-memory-poisoning",
      "adv-skill-poisoning",
      "adv-artifact-injection",
      "adv-encoded-shell-tricks",
      "adv-nested-shell-wrappers",
      "adv-path-confusion",
      "adv-symlink-escape",
      "adv-unexpected-binary-exec",
      "adv-dependency-install-attempt",
      "adv-credential-exfil-filenames",
    ];
    expect(cases.map((c) => c.id).sort()).toEqual(expectedVectorIds.sort());
  });

  it("loads the stress suite with the exact 11 vectors", async () => {
    const cases = await loadSuite("stress");
    expect(cases).toHaveLength(STRESS_COUNT);
    const expectedIds = [
      "stress-many-small-files",
      "stress-deep-directory",
      "stress-huge-generated-logs",
      "stress-very-long-json",
      "stress-repeated-tool-failures",
      "stress-10-subagents",
      "stress-context-near-limit",
      "stress-many-artifacts",
      "stress-rapid-cancellation",
      "stress-slow-verifier",
      "stress-slow-mcp",
    ];
    expect(cases.map((c) => c.id).sort()).toEqual(expectedIds.sort());
  });

  it("case ids are unique across both expanded suites", async () => {
    const adv = await loadSuite("adversarial");
    const stress = await loadSuite("stress");
    const all = [...adv, ...stress].map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("every case carries request.md text, a valid expected status and its suite", async () => {
    for (const suite of ["adversarial", "stress"] as const) {
      for (const c of await loadSuite(suite)) {
        expect(c.requestMd.trim().length).toBeGreaterThan(0);
        expect(["completed", "failed", "denied"]).toContain(c.expected.status);
        expect(c.suite).toBe(suite);
        expect(c.id.length).toBeGreaterThan(0);
      }
    }
  });

  it("the adversarial suite discriminates the vectors via status or forbidden rules", async () => {
    const adv = await loadSuite("adversarial");
    for (const c of adv) {
      // A vector must be judgeable: either sandbox-denied (status denied) or
      // guarded by at least one forbidden rule so an attempt is a violation.
      const guarded =
        c.forbidden !== undefined &&
        (c.forbidden.network === true ||
          (c.forbidden.commands?.length ?? 0) > 0 ||
          (c.forbidden.reads?.length ?? 0) > 0);
      expect(guarded || c.expected.status === "denied", `${c.id} is not judgeable`).toBe(true);
    }
  });

  it("stress cases express their stress via a budget or a heavy fixture or a generated-load tag", async () => {
    const stress = await loadSuite("stress");
    for (const c of stress) {
      const hasBudget =
        c.contextBudgetTokens !== undefined ||
        c.maxRetries !== undefined ||
        c.maxDurationMs !== undefined ||
        c.timeoutMs !== undefined ||
        c.allowArtifacts === true;
      const fixtureBytes = Object.values(c.fixture).reduce(
        (acc, v) => acc + Buffer.byteLength(v, "utf8"),
        0,
      );
      // Deep nesting (deep-directory) is itself a stress shape.
      const maxDepth = Object.keys(c.fixture).reduce(
        (acc, p) => Math.max(acc, p.split("/").length),
        0,
      );
      // Huge fixtures (huge log / long JSON / many files / deep dir) count.
      const heavy =
        fixtureBytes > 64 * 1024 || Object.keys(c.fixture).length > 100 || maxDepth > 5;
      // P36-9: some stress cases (e.g. stress-huge-generated-logs) express
      // their stress via a case tag and runtime generation, not static fixture.
      const generatedLoad = c.tags?.includes("huge-log") ?? false;
      expect(hasBudget || heavy || generatedLoad, `${c.id} expresses no stress dimension`).toBe(true);
    }
  });

  it("executing the logged-vector markers in stress fixtures works (no load crash)", async () => {
    // Light sanity: loading the biggest fixtures silently is the point of P2-13.
    const stress = await loadSuite("stress");
    const huge = stress.find((c) => c.id === "stress-huge-generated-logs");
    const longJson = stress.find((c) => c.id === "stress-very-long-json");
    const many = stress.find((c) => c.id === "stress-many-small-files");
    // P36-9: stress-huge-generated-logs generates its log at runtime (tag
    // "huge-log"), so it has no static fixture on disk — only assert the
    // static fixtures that exist.
    if (huge?.fixture["logs/app.log"] !== undefined) {
      expect(huge.fixture["logs/app.log"]!.length).toBeGreaterThan(100_000);
    } else {
      expect(huge?.tags).toContain("huge-log");
    }
    expect(longJson?.fixture["data/big.json"]!.length).toBeGreaterThan(100_000);
    expect(Object.keys(many?.fixture ?? {})).toHaveLength(1_000);
  });
});