/**
 * P34-7 — Config drift matrix over the FULL lifecycle taxonomy.
 *
 * For every lifecycle class (process_static / session_frozen /
 * turn_dynamic / step_dynamic) we change the config BETWEEN two snapshots
 * while a session is "active" (frozen baseline → current effective config)
 * and assert the DOCUMENTED behavior from P27-3/P27-4:
 *
 *   process_static  change → restart_required  (load gate REJECTS, never
 *     silently continues with a stale cwd/dataDir/now)
 *   session_frozen  widen  → reject            (new capability on an active
 *                              session is forbidden — needs a NEW session)
 *   session_frozen  narrow → emergency_revocation (capability REMOVED mid-
 *                              flight: actively revoke, not just warn)
 *   session_frozen  unknown→ reject            (fail closed)
 *   turn_dynamic    change → next_step only    (per-turn inputs may vary)
 *   step_dynamic    change → next_step only    (per-step binding re-selection)
 *
 * Matrices are evaluated on ResolvedConfig snapshots — the SAME unit the
 * production `checkSessionConfigDrift` gate freezes and compares.
 */
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config-resolver.js";
import { defaultsLayer, profileLayer, runtimeLayer } from "./config-layers.js";
import {
  evaluateConfigDrift,
  type DriftDecision,
} from "./config-drift.js";

function makeResolved(overrides: Record<string, unknown>) {
  return resolveConfig([
    defaultsLayer(),
    profileLayer("champion"),
    runtimeLayer({
      cwd: "/workspace",
      profile: "champion",
      modelProvider: { id: "stub" } as never,
      model: { providerId: "stub", modelId: "stub-model" },
      ...overrides,
    }),
  ]);
}

/** Severity precedence: restart > reject > revocation > next_step > none. */
const RANK: Record<DriftDecision["severity"], number> = {
  restart_required: 4,
  reject: 3,
  emergency_revocation: 2,
  next_step: 1,
  none: 0,
};

describe("P34-7 config drift matrix", () => {
  it("process_static: changed while active → restart_required (cwd)", () => {
    const d = evaluateConfigDrift(
      makeResolved({ cwd: "/old" }),
      makeResolved({ cwd: "/new" }),
    );
    expect(d.severity).toBe("restart_required");
    expect(d.changed[0]!.lifecycle).toBe("process_static");
    // the production session-load gate treats restart_required as a REJECT:
    // it never loads a session whose static baseline moved.
    expect(RANK[d.severity]).toBe(4);
  });

  it("process_static: dataDir change → restart_required", () => {
    const d = evaluateConfigDrift(
      makeResolved({ dataDir: "/data/a" }),
      makeResolved({ dataDir: "/data/b" }),
    );
    expect(d.severity).toBe("restart_required");
    expect(d.changed[0]!.key).toBe("dataDir");
  });

  it("process_static: injected clock (now) change → restart", () => {
    const d = evaluateConfigDrift(
      makeResolved({ now: 1_000_000 } as never),
      makeResolved({ now: 2_000_000 } as never),
    );
    expect(d.severity).toBe("restart_required");
    expect(d.changed[0]!.key).toBe("now");
  });

  it("session_frozen: boolean flag WIDEN while active → reject", () => {
    const d = evaluateConfigDrift(
      makeResolved({ featureFlags: { memory: false } }),
      makeResolved({ featureFlags: { memory: true } }),
    );
    expect(d.severity).toBe("reject");
    expect(d.frozenChanged).toBe(true);
    expect(d.changed.find((c) => c.key === "featureFlags.memory")!.direction).toBe("widen");
  });

  it("session_frozen: permission string WIDEN (deny→allow) → reject", () => {
    const d = evaluateConfigDrift(
      makeResolved({ sandboxPolicy: { network: "deny" } } as never),
      makeResolved({ sandboxPolicy: { network: "allow" } } as never),
    );
    expect(d.severity).toBe("reject");
    expect(d.changed[0]!.direction).toBe("widen");
  });

  it("session_frozen: NARREN (allow→deny) → emergency_revocation", () => {
    const d = evaluateConfigDrift(
      makeResolved({ sandboxPolicy: { file: "allow" } } as never),
      makeResolved({ sandboxPolicy: { file: "deny" } } as never),
    );
    expect(d.severity).toBe("emergency_revocation");
    expect(d.changed[0]!.direction).toBe("narrow");
    // revocation ranks BELOW reject but ABOVE next_step — it is ACTIVE
    // policy removal, not a per-step re-selection.
    expect(RANK[d.severity]).toBe(2);
  });

  it("session_frozen: numeric limit WIDEN → reject", () => {
    const d = evaluateConfigDrift(
      makeResolved({ limits: { maxTurns: 10 } }),
      makeResolved({ limits: { maxTurns: 20 } }),
    );
    expect(d.severity).toBe("reject");
    expect(d.changed[0]!.direction).toBe("widen");
  });

  it("session_frozen: numeric limit NARREN → emergency revocation", () => {
    const d = evaluateConfigDrift(
      makeResolved({ limits: { maxTurns: 10 } }),
      makeResolved({ limits: { maxTurns: 5 } }),
    );
    expect(d.severity).toBe("emergency_revocation");
    expect(d.changed[0]!.direction).toBe("narrow");
  });

  it("session_frozen: unknown direction fails closed → reject", () => {
    // providerId swap is not number/boolean/allow-deny — classified unknown →
    // the frozen model binding changed in an unclassifiable direction.
    const d = evaluateConfigDrift(
      makeResolved({ model: { providerId: "a", modelId: "m" } }),
      makeResolved({ model: { providerId: "b", modelId: "m" } }),
    );
    expect(d.severity).toBe("reject");
    expect(d.changed[0]!.direction).toBe("unknown");
  });

  it("turn_dynamic: task id change while active → next_step ONLY (never reject)", () => {
    const d = evaluateConfigDrift(
      makeResolved({ task: { id: "t1", verification: { strict: true } } as never }),
      makeResolved({ task: { id: "t2", verification: { strict: true } } as never }),
    );
    expect(d.severity).toBe("next_step");
    expect(d.frozenChanged).toBe(false);
    // a per-turn input is a DIFFERENT turn — no session escalation
    expect(RANK[d.severity]).toBe(1);
  });

  it("step_dynamic: MCP catalog swap while active → next_step ONLY", () => {
    const d = evaluateConfigDrift(
      makeResolved({ mcp: [{ serverId: "a" }] } as never),
      makeResolved({ mcp: [{ serverId: "b" }] } as never),
    );
    expect(d.severity).toBe("next_step");
    expect(d.changed[0]!.lifecycle).toBe("step_dynamic");
    // per-step binding re-select is the DOCUMENTED step_dynamic contract:
    // it must never escalate to a session-level reject.
    expect(RANK[d.severity]).toBe(1);
  });

  it("step_dynamic + frozen mixed change escalates to the frozen severity", () => {
    const d = evaluateConfigDrift(
      makeResolved({ mcp: [{ serverId: "a" }], featureFlags: { memory: false } } as never),
      makeResolved({ mcp: [{ serverId: "b" }], featureFlags: { memory: true } } as never),
    );
    expect(d.severity).toBe("reject"); // the frozen widen dominates
    expect(d.frozenChanged).toBe(true);
    expect(d.changed.some((c) => c.lifecycle === "step_dynamic")).toBe(true);
  });

  it("mixed process_static + step_dynamic: restart dominates", () => {
    const d = evaluateConfigDrift(
      makeResolved({ cwd: "/a", mcp: [{ serverId: "x" }] } as never),
      makeResolved({ cwd: "/b", mcp: [{ serverId: "y" }] } as never),
    );
    expect(d.severity).toBe("restart_required");
  });
});