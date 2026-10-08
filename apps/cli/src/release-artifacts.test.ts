import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReleaseArtifacts, renderReleaseArtifacts } from "./release-artifacts.js";
import { buildGateEvidenceV2, type GateEvidenceV2 } from "@ar/evaluation";

let dir = "";
afterEach(async () => {
  if (dir !== "") {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
});

async function makeRoot(): Promise<string> {
  if (dir === "") dir = await mkdtemp(join(tmpdir(), "release-"));
  return dir;
}

/** Injectable exec: unit test + audit succeed; benchmark steps "fail" so we
 *  can observe that failures are recorded, never swallowed. */
function fakeExec(script: Record<string, string>) {
  return async (cmd: string, args: string[], _opts: unknown): Promise<string> => {
    const key = `${cmd} ${args.join(" ")}`;
    for (const [prefix, out] of Object.entries(script)) {
      if (key.includes(prefix)) return out;
    }
    return "[artifact step failed] no script";
  };
}

/** Injectable gate runner: returns a passed GateEvidenceV2 without running a
 *  real command (the generator itself is unit-tested in gate-evidence-v2). */
function fakeGate(passed = true): (opts: { gate: string; command: string[]; toolVersion: string }) => Promise<GateEvidenceV2> {
  return async (opts) => buildGateEvidenceV2({
    gate: opts.gate, command: opts.command, toolVersion: opts.toolVersion, gitSha: "f".repeat(40),
    cleanBefore: true, cleanAfter: true, input: {}, output: {},
    startedAtIso: "2026-09-07T00:00:00.000Z", finishedAtIso: "2026-09-07T00:00:01.000Z",
    exitCode: passed ? 0 : 1, passed, state: passed ? "passed" : "failed", summary: "fake gate",
    providerCalls: 0, environmentClass: "offline",
  });
}

describe("P22-4 release artifacts", () => {
  it("does not turn a failing benchmark into PRODUCED when its error mentions the suite", async () => {
    const root = await makeRoot();
    const result = await collectReleaseArtifacts({ root, outDir: join(root, "out"), fast: true,
      execFn: fakeExec({
        "benchmark --suite adversarial": "[artifact step failed] adversarial command exited 17",
        "benchmark --suite stress": "[artifact step failed] stress command exited 18",
      }), gateFn: fakeGate() as never });
    expect(result.artifacts.find((a) => a.id === "adversarial-report")!.produced).toBe(false);
    expect(result.artifacts.find((a) => a.id === "stress-report")!.produced).toBe(false);
  });

  it("rejects a failed coverage command even when a previous summary exists", async () => {
    const root = await makeRoot(); await mkdir(join(root, "coverage"));
    await writeFile(join(root, "coverage/coverage-summary.json"), JSON.stringify({ total: { lines: { pct: 100 } } }));
    const result = await collectReleaseArtifacts({ root, outDir: join(root, "out"),
      execFn: fakeExec({ "pnpm test:coverage": "[artifact step failed] coverage exited 17" }), gateFn: fakeGate() as never });
    expect(result.artifacts.find((a) => a.id === "coverage-summary")!.produced).toBe(false);
  });

  it("does not label a workflow definition as executed Linux/Windows CI results", async () => {
    const root = await makeRoot(); await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, ".github/workflows/ci.yml"), "jobs: {}\n");
    const result = await collectReleaseArtifacts({ root, outDir: join(root, "out"), fast: true,
      execFn: fakeExec({}), gateFn: fakeGate() as never });
    const artifact = result.artifacts.find((a) => a.id === "ci-results")!;
    expect(artifact.produced).toBe(false);
    expect(artifact.note).toContain("actual Linux/Windows run results");
  });
  it("records every artifact and reports ok when all produced", async () => {
    const root = await makeRoot();
    const outDir = join(root, "release-artifacts");
    const result = await collectReleaseArtifacts({
      root,
      outDir,
      fast: true,
      execFn: fakeExec({
        "pnpm test": "1 files, 10 tests passed",
        "node apps/cli/dist/main.js benchmark --suite adversarial": "adversarial: 1/1 passed",
        "node apps/cli/dist/main.js benchmark --suite stress": "stress: 1/1 passed",
        "node apps/cli/dist/main.js champion": "mode: stub\npaired cases: 1",
        "node apps/cli/dist/main.js audit": "audit: wrote",
      }),
      gateFn: fakeGate() as never,
    });
    expect(result.artifacts.map((a) => a.id)).toEqual([
      "unit-report",
      "coverage-summary",
      "ci-results",
      "adversarial-report",
      "stress-report",
      "baseline-vs-champion",
      "capability-matrix",
      "champion-manifest",
      "gate-evidence",
    ]);
    // fast mode marks coverage as MISSING (skipped) -> ok=false
    expect(result.artifacts.find((a) => a.id === "unit-report")!.produced).toBe(true);
    expect(result.artifacts.find((a) => a.id === "coverage-summary")!.produced).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("records a failing step as MISSING, never silently skips it", async () => {
    const root = await makeRoot();
    const outDir = join(root, "release-artifacts");
    const result = await collectReleaseArtifacts({
      root,
      outDir,
      fast: true,
      execFn: fakeExec({
        "pnpm test": "[artifact step failed] boom",
        "node apps/cli/dist/main.js benchmark --suite adversarial": "[artifact step failed] boom",
      }),
      gateFn: fakeGate() as never,
    });
    const unit = result.artifacts.find((a) => a.id === "unit-report")!;
    expect(unit.produced).toBe(false);
    const adv = result.artifacts.find((a) => a.id === "adversarial-report")!;
    expect(adv.produced).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("renders a readable manifest", async () => {
    const root = await makeRoot();
    const outDir = join(root, "release-artifacts");
    const result = await collectReleaseArtifacts({ root, outDir, fast: true, execFn: fakeExec({}), gateFn: fakeGate() as never });
    const lines = renderReleaseArtifacts(result).join("\n");
    expect(lines).toContain("# P22-4 release artifacts");
    expect(lines).toContain("champion-manifest");
    expect(lines).toMatch(/PRODUCED|MISSING/);
  });
});
