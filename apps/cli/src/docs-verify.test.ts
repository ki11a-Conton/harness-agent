import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * E4-R54 fault seam — inject a read failure for an explicitly registered path.
 * Only temp fixture roots owned by this suite are ever registered; the repo tree
 * is never chmod'ed and never mutated.
 */
const ioFaults = vi.hoisted(() => ({ failReadFile: new Map<string, string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: ((p: unknown, ...rest: unknown[]) => {
      const key = String(p);
      const code = ioFaults.failReadFile.get(key);
      if (code !== undefined) {
        const err = new Error(`${code}: injected read failure, readFile '${key}'`) as NodeJS.ErrnoException;
        err.code = code;
        return Promise.reject(err);
      }
      return (actual.readFile as unknown as (a: unknown, ...r: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof actual.readFile,
  };
});

import { verifyDocs } from "./docs-verify.js";

let root = "";

async function makeRoot(files: Record<string, string>) {
  root = await mkdtemp(join(tmpdir(), "docs-verify-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  // E2-12: every fixture root gets a minimal valid evolution ledger so the
  // evolution-consistency check passes unless a test tampers with it.
  const ledger = {
    schemaVersion: "2.0.0",
    generatedAtIso: "2026-09-01T00:00:00.000Z",
    reviewBaselineSha: "abc",
    activeChampion: { level: "C0", candidateId: null, validity: "PROVEN" },
    experiments: [],
  };
  await mkdir(join(root, "docs", "evolution"), { recursive: true });
  await writeFile(join(root, "docs", "evolution", "evolution-ledger.json"), JSON.stringify(ledger, null, 2), "utf8");
  // E4-00: every fixture root gets a valid current-plan entry + its detailed
  // spec, so the plan-entry check passes unless a test tampers with it.
  await writeFile(
    join(root, "plan.md"),
    "# Harness Agent — 当前执行计划入口（E4）\n\n详细任务规格：`plan(20260907-004430).md`\n",
    "utf8",
  );
  await writeFile(join(root, "plan(20260907-004430).md"), "# E4 detailed spec\n", "utf8");
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

> NOT RELEASE EVIDENCE — informational repository snapshot. Official release verification uses CI-generated artifacts at immutable \`github.sha\`.

- generatedAt: 2026-08-21T00:00:00.000Z
- gitSha: abc

## Records
| id | status | implemented | productionWired | durable | securityMode |
`;

const MATRIX_JSON = `{"generatedAt":0,"releaseEvidence": false,"byProfile":{"benchmark":{"records":[]}}}`;

const HANDOVER = `## 状态速览
packages/（4 个包）已完成；
测试基线 3919 passed / 0 failed。
`;

beforeEach(() => {
  root = "";
});
afterEach(async () => {
  ioFaults.failReadFile.clear();
  if (root !== "") await rm(root, { recursive: true, force: true });
});

/** The common "everything else is fine" fixture, so a test can isolate one fact. */
const FULL_FIXTURE: Record<string, string> = {
  ...suiteCaseFiles(3),
  "benchmarks/README.md": README_CLAIMS,
  "packages/a/package.json": "{}",
  "HANDOVER.md": HANDOVER,
  ".github/workflows/ci.yml": CI_WITH_GATES,
  "CAPABILITY_MATRIX.md": MATRIX_MD,
  "CAPABILITY_MATRIX.json": MATRIX_JSON,
};

const e4_00 = (result: Awaited<ReturnType<typeof verifyDocs>>) =>
  result.checks.find((c) => c.name === "current plan entry (E4-00)")!;

describe("P20-3 docs:verify — machine truth verification", () => {
  it("passes when every machine-derivable doc fact matches reality", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "package.json": JSON.stringify({
        scripts: {
          typecheck: "tsc -b", test: "vitest run", build: "tsc -b", "test:coverage": "vitest run --coverage",
          "docs:verify": "node apps/cli/dist/main.js docs:verify", "benchmark:smoke": "node apps/cli/dist/main.js benchmark smoke",
          "test:protocol": "vitest run x", "test:security": "vitest run x", "test:race": "vitest run x", "test:chaos": "vitest run x",
          "capability:audit": "node apps/cli/dist/main.js audit --strict",
        },
      }),
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

  it("fails closed when a release-gate command references a missing script (E4-10)", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      // package.json omits `capability:audit` — a gate command with no script.
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc -b", test: "vitest run" } }),
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
    expect(result.ok).toBe(false);
    const gate = result.checks.find((c) => c.name === "release gate commands exist in package.json (E4-10)")!;
    expect(gate.truthful).toBe(false);
    expect(gate.reason).toContain("capability:audit");
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

  it("P38.2-11: fails closed when the tracked matrix lacks the NOT RELEASE EVIDENCE marker", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      // Tracked matrix WITHOUT the informational marker + releaseEvidence:false.
      "CAPABILITY_MATRIX.md": "# CAPABILITY MATRIX\n- generatedAt: 2026-08-21T00:00:00.000Z\n| id | status | implemented | productionWired |",
      "CAPABILITY_MATRIX.json": `{"generatedAt":0,"byProfile":{"benchmark":{"records":[]}}}`,
    });
    const result = await verifyDocs({ root });
    expect(result.ok).toBe(false);
    const marker = result.checks.find((c) => c.name === "CAPABILITY_MATRIX marked informational (P38.2-11)")!;
    expect(marker.truthful).toBe(false);
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

  it("P38.4-10: passes when HANDOVER canonical section has no volatile SHA/run-id", async () => {
    const staticHandover = `## 状态速览
packages/（4 个包）已完成；
测试基线 3919 passed / 0 failed。
## Runtime release truth
The canonical release truth is the exact-SHA GitHub Actions artifact.
Do not treat this file as a substitute for exact-SHA CI evidence.
`;
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": staticHandover,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    const result = await verifyDocs({ root });
    const handover = result.checks.find((c) => c.name === "HANDOVER static truth (P38.4-10)")!;
    expect(handover.truthful).toBe(true);
  });

  it("P38.4-10: fails closed when HANDOVER canonical section embeds a volatile Release SHA", async () => {
    const volatileHandover = `## 状态速览
packages/（4 个包）已完成；
测试基线 3919 passed / 0 failed。
Release SHA: 33de85f9a1b2c3d4e5f60718293a4b5c6d7e8f901
latest run: 32964584028
`;
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": volatileHandover,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    const result = await verifyDocs({ root });
    const handover = result.checks.find((c) => c.name === "HANDOVER static truth (P38.4-10)")!;
    expect(handover.truthful).toBe(false);
    expect(handover.reason).toMatch(/Release SHA|latest run/);
  });

  it("P38.4-10: historical section may keep SHA facts without failing the static rule", async () => {
    // SHA/run-id facts AFTER "## Historical / superseded" are allowed.
    const historicalHandover = `## 状态速览
packages/（4 个包）已完成；
测试基线 3919 passed / 0 failed。
## Historical / superseded
Release SHA: 33de85f9a1b2c3d4e5f60718293a4b5c6d7e8f901 (historical example, not current truth)
`;
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": historicalHandover,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    const result = await verifyDocs({ root });
    const handover = result.checks.find((c) => c.name === "HANDOVER static truth (P38.4-10)")!;
    expect(handover.truthful).toBe(true);
  });

  it("E4-00: passes (honestly) when plan.md is absent — no in-progress plan (E4-R50 收口)", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    // Simulate the R50 收口 state: the plan entry and its spec are both gone
    // (archived in git history). Absent plan.md must NOT fail closed — it is a
    // truthful "no in-progress plan" signal.
    await rm(join(root, "plan.md"), { force: true });
    await rm(join(root, "plan(20260907-004430).md"), { force: true });
    const result = await verifyDocs({ root });
    const plan = result.checks.find((c) => c.name === "current plan entry (E4-00)")!;
    expect(plan.truthful).toBe(true);
    expect(plan.reason).toMatch(/no plan\.md — no in-progress plan/);
  });

  it("E4-00: fails closed when plan.md does not declare itself the current entry", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    // Overwrite the seeded entry with an unmarked (stale) plan.
    await writeFile(join(root, "plan.md"), "# Some old notes\nnothing marks this as current\n", "utf8");
    const result = await verifyDocs({ root });
    const plan = result.checks.find((c) => c.name === "current plan entry (E4-00)")!;
    expect(plan.truthful).toBe(false);
    expect(plan.reason).toMatch(/does not declare itself the current plan entry/);
  });

  it("E4-00: fails closed when the entry references a spec file that is missing", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    await writeFile(
      join(root, "plan.md"),
      "# Harness Agent — 当前执行计划入口（E4）\n详细规格：`plan(20990101-000000).md`\n",
      "utf8",
    );
    const result = await verifyDocs({ root });
    const plan = result.checks.find((c) => c.name === "current plan entry (E4-00)")!;
    expect(plan.truthful).toBe(false);
    expect(plan.reason).toMatch(/spec file is missing/);
  });

  it("E4-00: passes when the entry is marked current and its spec exists", async () => {
    await makeRoot({
      ...suiteCaseFiles(3),
      "benchmarks/README.md": README_CLAIMS,
      "packages/a/package.json": "{}",
      "HANDOVER.md": HANDOVER,
      ".github/workflows/ci.yml": CI_WITH_GATES,
      "CAPABILITY_MATRIX.md": MATRIX_MD,
      "CAPABILITY_MATRIX.json": MATRIX_JSON,
    });
    const result = await verifyDocs({ root });
    const plan = result.checks.find((c) => c.name === "current plan entry (E4-00)")!;
    expect(plan.truthful).toBe(true);
  });

  // ── E4-R54 (F54): "absent" and "unreadable" must not share an outcome ──

  it("E4-R54: plan.md that is a real DIRECTORY fails closed — never reported as 'no in-progress plan'", async () => {
    await makeRoot({ ...FULL_FIXTURE });
    await rm(join(root, "plan.md"), { force: true });
    await mkdir(join(root, "plan.md"), { recursive: true });
    const result = await verifyDocs({ root });
    const plan = e4_00(result);
    expect(plan.truthful).toBe(false);
    // The pre-R54 catch-all selected the absence branch here, claiming there was
    // no in-progress plan while a plan entry demonstrably existed.
    expect(plan.reason).not.toMatch(/no plan\.md — no in-progress plan/);
    expect(plan.reason).toMatch(/could not be read/);
    expect(plan.reason).toMatch(/EISDIR/);
  });

  it("E4-R54: an injected EACCES / EIO on plan.md fails closed and preserves the real error code", async () => {
    for (const code of ["EACCES", "EIO"]) {
      await makeRoot({ ...FULL_FIXTURE });
      const dir = root;
      ioFaults.failReadFile.set(join(dir, "plan.md"), code);
      const result = await verifyDocs({ root: dir });
      const plan = e4_00(result);
      expect(plan.truthful).toBe(false);
      expect(plan.reason).toContain(code);
      expect(plan.reason).not.toMatch(/no plan\.md — no in-progress plan/);
      ioFaults.failReadFile.clear();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("E4-R54: a dangling-symlink entry (readFile ENOENT while the entry exists) fails closed", async () => {
    // Deterministic signature: readFile reports ENOENT while `lstat` still sees
    // the entry. That is exactly what a dangling symlink looks like from the
    // reading code's point of view, so it is reproduced by injecting the ENOENT
    // on a path that really exists (a directory). This does not depend on the
    // platform being able to create links at all.
    await makeRoot({ ...FULL_FIXTURE });
    await rm(join(root, "plan.md"), { force: true });
    await mkdir(join(root, "plan.md"), { recursive: true });
    ioFaults.failReadFile.set(join(root, "plan.md"), "ENOENT");
    const result = await verifyDocs({ root });
    const plan = e4_00(result);
    expect(plan.truthful).toBe(false);
    expect(plan.reason).toMatch(/dangling symlink/);
    ioFaults.failReadFile.clear();

    // And the REAL thing, when the platform can actually create a link. Measured
    // on Windows here: `symlink(..., "file")` resolves "ok" yet creates nothing,
    // so observability (not the syscall's return value) decides whether this
    // half can run — the limitation is recorded rather than faked green.
    await makeRoot({ ...FULL_FIXTURE });
    const dir = root;
    await rm(join(dir, "plan.md"), { force: true });
    try {
      await symlink(join(dir, "definitely-missing-target.md"), join(dir, "plan.md"), "file");
    } catch {
      /* recorded below via observability */
    }
    const observable = await lstat(join(dir, "plan.md")).then(
      (st) => st.isSymbolicLink(),
      () => false,
    );
    if (!observable) {
      expect(observable).toBe(false); // honest: platform cannot create the link
      await rm(dir, { recursive: true, force: true });
      return;
    }
    const real = await verifyDocs({ root: dir });
    const realPlan = e4_00(real);
    expect(realPlan.truthful).toBe(false);
    expect(realPlan.reason).toMatch(/dangling symlink/);
    await rm(dir, { recursive: true, force: true });
  });
});
