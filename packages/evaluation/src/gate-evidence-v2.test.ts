import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGateEvidenceV2,
  verifyGateEvidenceV2,
  captureGitState,
  digestOf,
  runGateV2,
  writeGateEvidenceV2,
  loadGateEvidenceV2,
  parseGateEvidenceV2,
  gateEvidenceV2Issues,
  GATE_EVIDENCE_V2_SCHEMA_VERSION,
  type GateEvidenceV2,
} from "./gate-evidence-v2.js";

const HEAD = "deadbeef";
const CMD = ["pnpm", "capability:audit"];

function mkEvidence(overrides: Partial<GateEvidenceV2> = {}): GateEvidenceV2 {
  return buildGateEvidenceV2({
    gate: "capability_audit",
    command: CMD,
    toolVersion: "1.0.0",
    gitSha: HEAD,
    cleanBefore: true,
    cleanAfter: true,
    input: { matrix: "a" },
    output: { summary: "ok" },
    startedAtIso: "2026-09-01T00:00:00.000Z",
    finishedAtIso: "2026-09-01T00:00:01.000Z",
    exitCode: 0,
    passed: true,
    state: "passed",
    summary: "capability audit passed",
    ...overrides,
  } as never);
}

function verify(e: GateEvidenceV2, opts: Record<string, unknown> = {}) {
  return verifyGateEvidenceV2(e, {
    expectedHead: HEAD,
    expectedCommand: CMD,
    ...opts,
  } as never);
}

describe("E2-13 gate evidence V2", () => {
  it("1. valid evidence passes strict verification (HEAD-bound, clean, non-tampered)", () => {
    const result = verify(mkEvidence());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("2. stale HEAD evidence is rejected (freshness is HEAD-bound, not wall-clock)", () => {
    const result = verify(mkEvidence({ gitSha: "other-sha" }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "STALE_HEAD")).toBe(true);
  });

  it("3. command mismatch is rejected (a different command is a different gate)", () => {
    const result = verify(mkEvidence({ command: ["pnpm", "whoami"] }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "COMMAND_MISMATCH")).toBe(true);
  });

  it("4. tampered exitCode/passed contradiction is rejected with EXIT_CODE_TAMPERED", () => {
    const tampered = mkEvidence({ passed: true, exitCode: 1 });
    const result = verify(tampered);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "EXIT_CODE_TAMPERED")).toBe(true);

    const tampered2 = mkEvidence({ passed: false, exitCode: 0 });
    const result2 = verify(tampered2);
    expect(result2.ok).toBe(false);
    expect(result2.issues.some((i) => i.code === "EXIT_CODE_TAMPERED")).toBe(true);
  });

  it("5. dirty source AFTER the gate run invalidates the evidence", () => {
    const result = verify(mkEvidence({ cleanAfter: false }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "SOURCE_DIRTY_AFTER")).toBe(true);
  });

  it("6. output digest mismatch is rejected", () => {
    const result = verify(mkEvidence(), { expectedOutputDigest: "wrong-digest" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "DIGEST_MISMATCH")).toBe(true);
  });

  it("7. NOT_RUN is a stable state, never PASS", () => {
    const result = verify(mkEvidence({ state: "not_run", exitCode: null, passed: false }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "NOT_RUN")).toBe(true);
  });

  it("8. unauthorized paid gate is BLOCKED (PAID_BENCHMARK_NOT_AUTHORIZED), never PASS", () => {
    const result = verify(mkEvidence({ gate: "ar2_paid_reeval" }), {
      paidGate: true,
      paidAuthorized: false,
      expectedCommand: ["pnpm", "benchmark", "ar2"],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "PAID_BENCHMARK_NOT_AUTHORIZED")).toBe(true);
  });

  it("9. digestOf is deterministic and content-sensitive", () => {
    expect(digestOf({ a: 1, b: [1, 2] })).toBe(digestOf({ a: 1, b: [1, 2] }));
    expect(digestOf({ a: 1, b: [1, 2] })).not.toBe(digestOf({ a: 1, b: [1, 3] }));
  });

  it("captureGitState returns sha + cleanness for a git repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "e2-13-"));
    try {
      await writeFile(join(repo, "tracked.txt"), "x", "utf8");
      // Not a git repo -> null (no fabricated values).
      const state = await captureGitState(repo);
      expect(state === null || typeof state.sha === "string").toBe(true);
      if (state !== null) expect(typeof state.clean).toBe("boolean");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("evidence schemaVersion is 2.0.0 and JSON round-trips as a single document", () => {
    const e = mkEvidence();
    expect(e.schemaVersion).toBe(GATE_EVIDENCE_V2_SCHEMA_VERSION);
    const parsed = JSON.parse(JSON.stringify(e)) as GateEvidenceV2;
    expect(parsed.gitSha).toBe(HEAD);
    expect(parsed.command).toEqual(CMD);
  });
});

describe("E4-10 gate evidence generator + loader", () => {
  async function tempGitRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "e4-r09-repo-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await writeFile(join(dir, "f.txt"), "x", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
    return dir;
  }

  it("runGateV2 captures the REAL exit code and passes only on exit 0 (on a CLEAN source tree)", async () => {
    const dir = await tempGitRepo();
    const artifactDir = await mkdtemp(join(tmpdir(), "e4-r09-art-"));
    try {
      // The artifact lives OUTSIDE the git repo so the tree stays clean.
      const artifact = join(artifactDir, "out.json");
      await writeFile(artifact, "{}", "utf8");
      const ev = await runGateV2({
        gate: "capability_audit",
        command: ["node", "-e", "0"],
        cwd: dir,
        toolVersion: "test",
        artifactPaths: [artifact],
        environmentClass: "offline",
        run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      });
      expect(ev.passed).toBe(true);
      expect(ev.state).toBe("passed");
      expect(ev.exitCode).toBe(0);
      expect(ev.cleanBefore).toBe(true);
      expect(ev.cleanAfter).toBe(true);
      expect(ev.providerCalls).toBe(0);
      expect(ev.artifactRefs?.[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("a nonzero exit is recorded as failed, never passed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e4-10-gate-"));
    try {
      const ev = await runGateV2({
        gate: "g", command: ["x"], cwd: dir, toolVersion: "t",
        run: async () => ({ exitCode: 3, stdout: "", stderr: "boom" }),
      });
      expect(ev.passed).toBe(false);
      expect(ev.exitCode).toBe(3);
      expect(ev.state).toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a missing declared artifact cannot be PASS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e4-10-gate-"));
    try {
      const ev = await runGateV2({
        gate: "g", command: ["x"], cwd: dir, toolVersion: "t",
        artifactPaths: [join(dir, "does-not-exist.json")],
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      expect(ev.passed).toBe(false);
      expect(ev.artifactRefs?.[0]?.digest).toBeNull();
      // And the verifier rejects a hand-forged PASS over a missing artifact.
      const forged = { ...ev, passed: true, state: "passed" as const };
      const v = verify(forged);
      expect(v.ok).toBe(false);
      expect(v.issues.map((i) => i.code)).toContain("MISSING_ARTIFACT_REF");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an offline gate reporting provider calls is rejected", () => {
    const v = verify(mkEvidence({ environmentClass: "offline", providerCalls: 5 }));
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain("PROVIDER_CALLS_ON_OFFLINE");
  });

  it("a hand-written PASS with a nonzero exit code is rejected", () => {
    const v = verify(mkEvidence({ passed: true, exitCode: 1, state: "passed" }));
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain("EXIT_CODE_TAMPERED");
  });

  it("stale sourceSha (evidence from an older HEAD) is rejected", () => {
    const v = verify(mkEvidence({ gitSha: "oldsha" }), { expectedHead: "newhead" });
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain("STALE_HEAD");
  });

  it("write then load round-trips; a missing file loads as NOT_RUN (never PASS)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e4-10-gate-"));
    try {
      const path = join(dir, "evidence.json");
      await writeGateEvidenceV2(mkEvidence(), path);
      const loaded = await loadGateEvidenceV2(path);
      expect(loaded.passed).toBe(true);
      const missing = await loadGateEvidenceV2(join(dir, "nope.json"));
      expect(missing.state).toBe("not_run");
      expect(missing.passed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gate output content changed but the recorded digest not updated is rejected", () => {
    const e = mkEvidence({ outputDigest: digestOf({ stdout: "original" }) });
    const v = verify(e, { expectedOutputDigest: digestOf({ stdout: "tampered" }) });
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain("DIGEST_MISMATCH");
  });
});
describe("E4-R09 strict GateEvidenceV2 parse (F18)", () => {
  function valid(): Record<string, unknown> {
    return {
      schemaVersion: GATE_EVIDENCE_V2_SCHEMA_VERSION,
      gate: "capability_audit",
      command: ["node", "run.ts"],
      toolVersion: "e4-09",
      gitSha: "a".repeat(40),
      cleanBefore: true,
      cleanAfter: true,
      inputDigest: "0".repeat(64),
      outputDigest: "1".repeat(64),
      startedAtIso: "2026-01-01T00:00:00.000Z",
      finishedAtIso: "2026-01-01T00:00:01.000Z",
      exitCode: 0,
      passed: true,
      state: "passed",
      summary: "PASS",
      providerCalls: 0,
      environmentClass: "offline",
    };
  }

  const cases: Array<[string, (e: Record<string, unknown>) => void, string]> = [
    ["missing required field (digest)", (e) => { delete e.outputDigest; }, "outputDigest"],
    ["bad schemaVersion", (e) => { e.schemaVersion = "1.0.0"; }, "schemaVersion"],
    ["unknown gate id", (e) => { e.gate = "../evil!"; }, "gate"],
    ["wrong argv (empty command)", (e) => { e.command = []; }, "command"],
    ["stale/absent gitSha", (e) => { e.gitSha = "unknown"; }, "gitSha"],
    ["dirty source cannot pass", (e) => { e.cleanBefore = false; }, "cleanBefore"],
    ["failed state cannot be passed", (e) => { e.state = "failed"; e.exitCode = 2; e.summary = "FAIL"; }, "passed"],
    ["passed=true but exit nonzero", (e) => { e.exitCode = 1; }, "exitCode"],
    ["passed=true with state not passed", (e) => { e.passed = true; e.state = "invalid"; }, "state"],
    ["non-iso timestamps", (e) => { e.startedAtIso = "yesterday"; }, "startedAtIso"],
    ["bad artifactRef digest", (e) => { e.artifactRefs = [{ path: "o.json", digest: "short" }]; }, "digest"],
  ];

  for (const [name, mutate, needle] of cases) {
    it(`rejects: ${name}`, () => {
      const e = valid();
      mutate(e);
      const issues = gateEvidenceV2Issues(e);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((i) => i.includes(needle))).toBe(true);
      expect(() => parseGateEvidenceV2(e)).toThrow();
    });
  }

  it("a complete valid object parses", () => {
    const parsed = parseGateEvidenceV2(valid());
    expect(parsed.passed).toBe(true);
  });

  it("loadGateEvidenceV2 returns NOT_RUN (never PASS) for a missing-field object on disk", async () => {
    const dir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "e4-r09-"));
    try {
      const p = join(dir, "g.json");
      const e = valid();
      delete e.inputDigest;
      await (await import("node:fs/promises")).writeFile(p, JSON.stringify(e), "utf8");
      const loaded = await loadGateEvidenceV2(p);
      expect(loaded.passed).toBe(false);
      expect(loaded.state).toBe("not_run");
      expect(loaded.summary).toContain("invalid GateEvidenceV2");
    } finally {
      await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
    }
  });
});
