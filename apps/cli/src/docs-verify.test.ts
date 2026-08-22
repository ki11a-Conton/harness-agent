import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyDocs } from "./docs-verify.js";

let root = "";

async function makeRoot(files: Record<string, string>) {
  root = await mkdtemp(join(tmpdir(), "docs-verify-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

function suiteCaseFiles(count: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    out[`benchmarks/regression/reg-${i}/case.json`] = "{}";
    out[`benchmarks/holdout/hold-${i}/case.json`] = "{}";
    out[`benchmarks/adversarial/adv-${i}/case.json`] = "{}";
    out[`benchmarks/stress/st-${i}/case.json`] = "{}";
  }
  return out;
}

const README_CLAIMS = `# Benchmark Suite
node apps/cli/dist/main.js benchmark --suite regression   # 全部 3 个回归用例
node apps/cli/dist/main.js benchmark --suite holdout      # holdout 3 个
node apps/cli/dist/main.js benchmark --suite adversarial  # adversarial 3 个
node apps/cli/dist/main.js benchmark --suite stress       # stress 3 个
`;

const CI_WITH_GATES = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
      - run: pnpm test:coverage
`;

const MATRIX_MD = `# CAPABILITY MATRIX
- generatedAt: 2026-08-21T00:00:00.000Z
- gitSha: abc

## Records
| id | status | implemented | productionWired | durable | securityMode |
`;

const MATRIX_JSON = `{"generatedAt":0,"byProfile":{"benchmark":{"records":[]}}}`;

const HANDOVER = `## 状态速览
packages/（4 个包）已完成；
测试基线 3919 passed / 0 failed。
`;

beforeEach(() => {
  root = "";
});
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("P20-3 docs:verify — machine truth verification", () => {
  it("passes when every machine-derivable doc fact matches reality", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "packages/b/package.json": "{}",
      "packages/c/package.json": "{}",
      "packages/d/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    const result = await verifyDocs({ root });
    expect(result.ok).toBe(true);
    for (const check of result.checks) expect(check.truthful, check.name).toBe(true);
  });

  it("fails closed when a README benchmark count contradicts the disk", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS.replace("3 个回归用例", "99 个回归用例"),
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    const result = await verifyDocs({ root });
    expect(result.ok).toBe(false);
    const suite = result.checks.find((c) => c.name === "benchmark suite: regression")!;
    expect(suite.truthful).toBe(false);
    expect(suite.reason).toContain("99");
  });

  it("fails closed when a README claim is missing entirely", async () => {
    await makeRoot({
      "benchmarks/regression/reg-0/case.json": "{}",
      "benchmarks/README.md": "no claims here",
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    const result = await verifyDocs({ root });
    expect(result.ok).toBe(false);
    const suite = result.checks.find((c) => c.name === "benchmark suite: regression")!;
    expect(suite.truthful).toBe(false);
    expect(suite.reason).toMatch(/does not claim/);
  });

  it("fails closed when CI runs tests but no coverage gate", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": "jobs: { test: { runs-on: ubuntu-latest, steps: [run: pnpm test] } }",
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    const result = await verifyDocs({ root });
    expect(result.ok).toBe(false);
    const ci = result.checks.find((c) => c.name === "CI gates")!;
    expect(ci.truthful).toBe(false);
    expect(ci.reason).toMatch(/coverage/);
  });

  it("fails closed when CAPABILITY_MATRIX.md is missing (not machine-generated)", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
    });
    const result = await verifyDocs({ root });
    expect(result.ok).toBe(false);
    const matrix = result.checks.find((c) => c.name === "CAPABILITY_MATRIX.md machine-generated")!;
    expect(matrix.truthful).toBe(false);
  });

  it("fails closed when the matrix carries no per-profile view", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": "{}", // no byProfile
    });
    const result = await verifyDocs({ root });
    expect(result.ok).toBe(false);
    const profiles = result.checks.find((c) => c.name === "capability profiles present")!;
    expect(profiles.truthful).toBe(false);
  });

  it("fails closed when the doc package count contradicts packages/ on disk", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "packages/b/package.json": "{}",
      "HANDOVER.md": HANDOVER.replace("4 个包", "77 个包"),
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    const result = await verifyDocs({ root });
    expect(result.ok).toBe(false);
    const packages = result.checks.find((c) => c.name === "package count")!;
    expect(packages.truthful).toBe(false);
    expect(packages.reason).toContain("77");
  });
});
