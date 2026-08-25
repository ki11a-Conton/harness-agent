/**
 * P31 — EnvironmentSnapshot / EnvironmentManager tests.
 *
 * Covers:
 * - P31-1: buildLocalEnvironmentSnapshot is deterministic (same facts → same
 *   id/fingerprint), id encodes cwd, and a changed cwd/shell changes both.
 * - P31-2: LocalEnvironmentManager resolves deterministically and snapshots
 *   the facts it was given (no IO, pure registry semantics).
 * - P31-3: step-snapshot-factory accepts a pre-built snapshot and uses its
 *   fingerprint as environmentFingerprint (not a naked cwd hash).
 */
import { describe, expect, it } from "vitest";
import {
  buildLocalEnvironmentSnapshot,
  localCapabilities,
  type EnvironmentSnapshot,
} from "@ar/contracts";
import {
  buildStepExecutionSnapshot,
  type StepSnapshotBuildInput,
} from "./step-snapshot-factory.js";
import {
  LocalEnvironmentManager,
  deterministicLocalId,
  currentShellPath,
} from "./local-environment-manager.js";

describe("P31-1 EnvironmentSnapshot determinism", () => {
  it("same facts → same id and fingerprint", () => {
    const a = buildLocalEnvironmentSnapshot({
      cwd: "/work/app",
      workspaceRoots: ["/work/app", "/work"],
      shell: "/bin/bash",
      permissionsFingerprint: "p1",
    });
    const b = buildLocalEnvironmentSnapshot({
      cwd: "/work/app",
      workspaceRoots: ["/work/app", "/work"],
      shell: "/bin/bash",
      permissionsFingerprint: "p1",
    });
    expect(a.id).toBe(b.id);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.id).toMatch(/^env_local_/);
  });

  it("changed cwd produces a different id (and fingerprint)", () => {
    const a = buildLocalEnvironmentSnapshot({
      cwd: "/a",
      shell: "/bin/bash",
      permissionsFingerprint: "",
    });
    const b = buildLocalEnvironmentSnapshot({
      cwd: "/b",
      shell: "/bin/bash",
      permissionsFingerprint: "",
    });
    expect(a.id).not.toBe(b.id);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("shell env vars are fingerprinted but undefined values are dropped", () => {
    const a = buildLocalEnvironmentSnapshot({
      cwd: "/x",
      shell: "/bin/bash",
      env: { PATH: "/bin", LANG: undefined },
      permissionsFingerprint: "",
    });
    expect(a.shell.envVarsFingerprint).toBeTruthy();
    expect(a.shell.envVars).toEqual({ PATH: "/bin" });
    const b = buildLocalEnvironmentSnapshot({
      cwd: "/x",
      shell: "/bin/bash",
      env: { PATH: "/bin" },
      permissionsFingerprint: "",
    });
    // key insertion order irrelevant — fingerprint is stable
    expect(a.shell.envVarsFingerprint).toBe(b.shell.envVarsFingerprint);
  });

  it("capabilities default to the local-process set", () => {
    const s = buildLocalEnvironmentSnapshot({
      cwd: "/x",
      shell: "/bin/bash",
      permissionsFingerprint: "",
    });
    expect(s.capabilities).toEqual(localCapabilities());
  });
});

describe("P31-2 LocalEnvironmentManager", () => {
  it("resolves deterministically for the same session cwd", async () => {
    const mgr = new LocalEnvironmentManager({ env: {} });
    const h1 = await mgr.resolveForSession({ id: "s1", cwd: "/work/app" });
    const h2 = await mgr.resolveForSession({ id: "s2", cwd: "/work/app" });
    expect(h1.id).toBe(h2.id);
  });

  it("snapshot returns the resolved cwd and a deterministic id", async () => {
    const mgr = new LocalEnvironmentManager({ env: {} });
    const handle = await mgr.resolveForSession({ id: "s1", cwd: "/work/app" });
    const snap = await mgr.snapshot(handle);
    expect(snap.cwd).toBe("/work/app");
    expect(snap.id).toBe(handle.id);
    expect(snap.shell.shell).toBeTruthy();
    expect(snap.capabilities.filesystem).toContain("local");
  });

  it("currentShellPath and deterministicLocalId agree with the builder", () => {
    const shell = currentShellPath();
    const id = deterministicLocalId("/work/app", ["/work/app"], shell);
    const built = buildLocalEnvironmentSnapshot({
      cwd: "/work/app",
      workspaceRoots: ["/work/app"],
      shell,
      permissionsFingerprint: "",
    });
    expect(id).toBe(built.id);
  });
});

describe("P31-3 factory uses full environment snapshot", () => {
  function makeInput(overrides: Partial<StepSnapshotBuildInput> = {}): StepSnapshotBuildInput {
    return {
      sessionId: "sess-1" as never,
      turnId: "turn-1" as never,
      agent: {
        id: "agent-1" as never,
        name: "t",
        description: "t",
        mode: "primary",
        model: { providerId: "p", modelId: "m" },
        systemPrompt: "you",
        tools: {},
        permissions: { rules: [] },
        skills: {},
        limits: {},
      },
      cwd: "/work/app",
      stepIndex: 0,
      priorBlocks: [],
      system: "you",
      compacted: false,
      history: [],
      registry: { get: () => undefined, list: () => [], specs: () => [] } as never,
      semanticsOf: () => ({ retrySafety: "unknown", concurrencySafety: true } as never),
      now: () => 0,
      ...overrides,
    };
  }

  it("environmentFingerprint equals the injected snapshot fingerprint", () => {
    const env: EnvironmentSnapshot = buildLocalEnvironmentSnapshot({
      cwd: "/work/app",
      workspaceRoots: ["/work/app"],
      shell: "/bin/bash",
      permissionsFingerprint: "perm-1",
    });
    const snap = buildStepExecutionSnapshot(makeInput({ environment: env }));
    expect(snap.record.environmentFingerprint).toBe(env.fingerprint);
    expect(snap.environment).toBe(env);
    expect(snap.environment.id).toBe(env.id);
  });

  it("without an injected snapshot builds a deterministic local one", () => {
    const snap = buildStepExecutionSnapshot(makeInput({ cwd: "/work/app" }));
    expect(snap.environment.cwd).toBe("/work/app");
    expect(snap.environment.id).toMatch(/^env_local_/);
    // fingerprint is stable across two identical builds
    const snap2 = buildStepExecutionSnapshot(makeInput({ cwd: "/work/app" }));
    expect(snap.record.environmentFingerprint).toBe(snap2.record.environmentFingerprint);
  });

  it("a changed cwd changes the environment fingerprint (P31 regression)", () => {
    const a = buildStepExecutionSnapshot(makeInput({ cwd: "/a" }));
    const b = buildStepExecutionSnapshot(makeInput({ cwd: "/b" }));
    expect(a.record.environmentFingerprint).not.toBe(b.record.environmentFingerprint);
  });
});