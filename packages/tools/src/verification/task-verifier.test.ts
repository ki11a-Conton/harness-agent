import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskSpec, VerificationContext } from "@ar/contracts";
import { newSessionId } from "@ar/contracts";
import { TaskVerifier } from "./task-verifier.js";

let ws = "";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-vf-"));
  writeFileSync(join(ws, "out.txt"), "v1");
});

afterAll(() => rmSync(ws, { recursive: true, force: true }));

const NODE = process.execPath;

function context(over: Partial<VerificationContext> = {}): VerificationContext {
  return { sessionId: newSessionId(), cwd: ws, changedPaths: [], transcript: "", runStartedAt: Date.now(), ...over };
}

function task(specs: TaskSpec["verification"]): TaskSpec {
  return { id: "t1", goal: "g", ...(specs !== undefined ? { verification: specs } : {}) };
}

describe("TaskVerifier (VS-001)", () => {
  it("passes when a command exits 0", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(task([{ kind: "command", command: `${JSON.stringify(NODE)} -e "process.exit(0)"` }]), context());
    expect(r.passed).toBe(true);
    expect(r.checks[0]?.passed).toBe(true);
    expect(r.level).toBe(3);
    expect(r.checks[0]?.evidence?.type).toBe("test");
  });

  it("fails when a command exits non-zero", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(task([{ kind: "command", command: `${JSON.stringify(NODE)} -e "process.exit(1)"` }]), context());
    expect(r.passed).toBe(false);
    expect(r.checks[0]?.error?.code).toBe("VERIFICATION_FAILED");
    expect(r.level).toBe(1);
  });

  it("passes when an artifact exists", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(task([{ kind: "artifact", path: "out.txt" }]), context());
    expect(r.passed).toBe(true);
    expect(r.checks[0]?.evidence?.type).toBe("file");
  });

  it("fails when an artifact is missing", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(task([{ kind: "artifact", path: "missing.txt" }]), context());
    expect(r.passed).toBe(false);
    expect(r.checks[0]?.error).toBeDefined();
  });

  it("mustChange requires the path in changedPaths", async () => {
    const v = new TaskVerifier();
    const ok = await v.verify(task([{ kind: "artifact", path: "out.txt", mustChange: true }]), context({ changedPaths: [join(ws, "out.txt")] }));
    expect(ok.passed).toBe(true);
    const bad = await v.verify(task([{ kind: "artifact", path: "out.txt", mustChange: true }]), context({ changedPaths: [] }));
    expect(bad.passed).toBe(false);
  });

  it("requirement checks fail closed until a reviewer is wired", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(task([{ kind: "requirement", statement: "must be fast" }]), context());
    expect(r.passed).toBe(false);
    expect(r.checks[0]?.error?.code).toBe("VERIFICATION_FAILED");
  });

  it("level 0 and passed=false when no specs", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(task([]), context());
    expect(r.passed).toBe(false);
    expect(r.level).toBe(0);
  });

  it("mixed specs: one failure fails the run", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(
      task([
        { kind: "command", command: `${JSON.stringify(NODE)} -e "process.exit(0)"` },
        { kind: "artifact", path: "nope.txt" },
      ]),
      context(),
    );
    expect(r.passed).toBe(false);
    expect(r.checks).toHaveLength(2);
  });

  it("P1-14 diff: passes when the expected change set is exact", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(
      task([
        {
          kind: "diff",
          expectedPaths: ["src/a.ts", "src/b.ts"],
          mustNotChange: ["package.json"],
        },
      ]),
      context({ changedPaths: [join(ws, "src/a.ts"), join(ws, "src/b.ts")] }),
    );
    expect(r.passed).toBe(true);
    expect(r.checks[0]?.evidence?.type).toBe("diff");
  });

  it("P1-14 diff: reports missing expected changes as structured failure", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(
      task([{ kind: "diff", expectedPaths: ["src/a.ts", "src/b.ts"] }]),
      context({ changedPaths: [join(ws, "src/a.ts")] }),
    );
    expect(r.passed).toBe(false);
    const check = r.checks[0]!;
    expect(check.kind).toBe("diff");
    expect(check.evidence?.description).toContain("src/b.ts");
    expect(check.error?.code).toBe("VERIFICATION_FAILED");
  });

  it("P1-14 diff: unexpected destructive edits fail the gate", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(
      task([{ kind: "diff", mustNotChange: ["deploy.conf", "credentials.json"] }]),
      context({ changedPaths: [join(ws, "deploy.conf")] }),
    );
    expect(r.passed).toBe(false);
    const check = r.checks[0]!;
    expect(check.evidence?.description).toContain("deploy.conf");
    expect(check.evidence?.description).toContain("destructive");
  });

  it("P1-16 diff: unexpected file deletion fails when a baseline file vanishes", async () => {
    const victim = join(ws, "victim.txt");
    writeFileSync(victim, "v1");
    rmSync(victim);
    const v = new TaskVerifier();
    const r = await v.verify(
      task([{ kind: "diff", forbidDeletions: true, description: "no deletions" }]),
      context({ baselineFiles: ["out.txt", "victim.txt"], changedPaths: [] }),
    );
    expect(r.passed).toBe(false);
    const check = r.checks[0]!;
    expect(check.evidence?.description).toContain("unexpected file deletion");
    expect(check.evidence?.description).toContain("victim.txt");
    expect(check.error?.code).toBe("VERIFICATION_FAILED");
  });

  it("P1-16 diff: generated-junk / format-explosion paths are forbidden by glob", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(
      task([{ kind: "diff", forbidPatterns: ["**/dist/**", "*.min.js"], description: "no junk" }]),
      context({ changedPaths: [join(ws, "src/a.ts"), join(ws, "dist/bundle.min.js")] }),
    );
    expect(r.passed).toBe(false);
    const check = r.checks[0]!;
    expect(check.evidence?.description).toContain("forbidden paths changed");
    expect(check.evidence?.description).toMatch(/bundle\.min\.js/);
  });

  it("P1-16 diff: maxFiles flags a large accidental rewrite", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(
      task([{ kind: "diff", maxFiles: 2, description: "small diff" }]),
      context({ changedPaths: [join(ws, "a.ts"), join(ws, "b.ts"), join(ws, "c.ts")] }),
    );
    expect(r.passed).toBe(false);
    const check = r.checks[0]!;
    expect(check.evidence?.description).toContain("too many files changed (3 > 2)");
    expect(check.error?.code).toBe("VERIFICATION_FAILED");
  });

  it("P1-16 diff: deletion/glob/maxFiles all satisfied passes", async () => {
    const v = new TaskVerifier();
    const r = await v.verify(
      task([
        { kind: "diff", forbidDeletions: true, forbidPatterns: ["**/dist/**"], maxFiles: 5 },
      ]),
      context({ baselineFiles: ["out.txt"], changedPaths: [join(ws, "src/a.ts")] }),
    );
    expect(r.passed).toBe(true);
  });
});
describe("P8-2: incremental verification evidence", () => {
  it("emits step_started + step_completed with stable refs and outcome", async () => {
    const events: Array<{ phase: string; ref: string; passed?: boolean }> = [];
    const dir = await mkdtemp(join(tmpdir(), "task-verifier-step-"));
    await writeFile(join(dir, "out.txt"), "ok", "utf8");
    const v = new TaskVerifier({
      onStep: (event) => events.push(event),
      executor: {
        run: async () => ({ status: "success" as const, exitCode: 0, durationMs: 5, stdout: "", stderr: "" }),
      } as never,
    });
    const result = await v.verify(
      {
        id: "t",
        goal: "g",
        verification: [
          { kind: "command", command: "node test.js" },
          { kind: "artifact", path: "out.txt", mustChange: true },
        ],
      },
      { cwd: dir, changedPaths: ["out.txt"], sessionId: "s" as never, transcript: [] as never, runStartedAt: 1 },
    );
    await rm(dir, { recursive: true, force: true });
    expect(events).toHaveLength(4);
    // Steps may run in parallel — assert by content, not index.
    expect(events.filter((e) => e.phase === "started")).toHaveLength(2);
    const completed = events.filter((e) => e.phase === "completed");
    expect(completed).toHaveLength(2);
    expect(completed.every((e) => e.passed === true)).toBe(true);
    expect(events.some((e) => e.ref === "verification.step:command:node test.js")).toBe(true);
    expect(result.passed).toBe(true);
  });
});
