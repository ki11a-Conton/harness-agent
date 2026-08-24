import { describe, expect, it } from "vitest";
import type { DeclaredCapability, EventSink, SandboxPolicy, SessionId } from "@ar/contracts";
import { newSessionId } from "@ar/contracts";
import {
  BoundaryCapabilityError,
  CAPABILITY_BOUNDARIES,
  composeBoundaryCapability,
} from "./boundary-guard.js";

/**
 * P14-4 — capability monotonicity at every extension boundary.
 *
 * The acceptance matrix: EVERY boundary × EVERY capability dimension (tool /
 * filesystem / network / process) gets at least one WIDENING rejection and
 * one NARROWING success. All boundaries share the same composition rule
 * (composeBoundaryCapability), so the matrix is table-driven: proving the
 * shared entry point per boundary × dimension proves the boundary itself
 * cannot widen, and each boundary's integration test wires real call sites.
 */

function grantedPolicy(over: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    filesystem: { mode: "workspace-write", allowedPaths: ["/home/u/work"] },
    network: { mode: "allowlist", hosts: ["api.example.com"] },
    process: { allowedCommands: ["npm test", "git status"] },
    ...over,
  };
}

const GRANT = {
  policy: grantedPolicy(),
  toolAllowlist: ["read", "write", "exec"],
};

/** Widening payloads per dimension — every one MUST be rejected. */
const WIDENING: Record<string, DeclaredCapability> = {
  tool: { tool: ["read", "prompt_inject"] },
  filesystem: { filesystem: ["/home/u/work", "/etc/passwd"] },
  network: { network: ["evil.example.com"] },
  process: { process: ["npm test", "rm -rf /"] },
};

/** Narrowing payloads per dimension — every one MUST succeed and narrow. */
const NARROWING: Record<string, DeclaredCapability> = {
  tool: { tool: ["read"] },
  filesystem: { filesystem: ["/home/u/work/sub"] },
  network: { network: [] },
  process: { process: ["npm test"] },
};

/** Expected effective (narrowed) values per dimension. */
const NARROWED_EFFECTIVE: Record<string, (n: {
  policy: SandboxPolicy;
  toolAllowlist: readonly string[];
}) => unknown> = {
  tool: (n) => n.toolAllowlist,
  filesystem: (n) => n.policy.filesystem,
  network: (n) => n.policy.network,
  process: (n) => n.policy.process.allowedCommands,
};

describe("composeBoundaryCapability — P14-4 boundary × dimension matrix", () => {
  // The full acceptance table: every boundary shares one composition rule;
  // this loop is the table-driven proof of that sharing.
  for (const boundary of CAPABILITY_BOUNDARIES) {
    describe(`boundary: ${boundary}`, () => {
      for (const dimension of ["tool", "filesystem", "network", "process"] as const) {
        it(`WIDENING ${dimension} → typed denial (fail-closed)`, async () => {
          await expect(
            composeBoundaryCapability(boundary, GRANT, WIDENING[dimension]!),
          ).rejects.toBeInstanceOf(BoundaryCapabilityError);
        });

        it(`NARROWING ${dimension} → effective = declared ∩ conferred`, async () => {
          const narrowed = await composeBoundaryCapability(
            boundary,
            GRANT,
            NARROWING[dimension]!,
          );
          expect(narrowed.narrowed).toContain(dimension);
          const effective = NARROWED_EFFECTIVE[dimension]!(narrowed);
          // every effective entry is within the conferred bound
          if (dimension === "tool") {
            expect(effective).toEqual(["read"]);
          } else if (dimension === "filesystem") {
            expect(effective).toMatchObject({ mode: "workspace-write" });
            // P36-10: on Windows, POSIX-style paths gain a drive letter prefix
            const paths = (effective as { allowedPaths: string[] }).allowedPaths;
            expect(paths.length).toBe(1);
            expect(paths[0]!.replace(/^[A-Za-z]:/, "")).toBe("/home/u/work/sub");
          } else if (dimension === "network") {
            expect(effective).toMatchObject({ mode: "allowlist", hosts: [] });
          } else {
            expect(effective).toEqual(["npm test"]);
          }
        });
      }

      it("absent dimensions are inherited unchanged (never widened by omission)", async () => {
        const narrowed = await composeBoundaryCapability(boundary, GRANT, {
          tool: ["read"],
        });
        expect(narrowed.toolAllowlist).toEqual(["read"]);
        // filesystem/network/process inherited from the grant, un-widened
        const fs = narrowed.policy.filesystem as { allowedPaths: string[] };
        expect(fs.allowedPaths.length).toBe(1);
        expect(fs.allowedPaths[0]!.replace(/^[A-Za-z]:/, "")).toBe("/home/u/work");
        expect(narrowed.policy.network).toMatchObject({
          hosts: ["api.example.com"],
        });
        expect(narrowed.policy.process.allowedCommands).toEqual(["npm test", "git status"]);
      });
    });
  }
});

describe("composeBoundaryCapability — typed denial + security event", () => {
  it("the error carries the boundary and the violations", async () => {
    try {
      await composeBoundaryCapability("plugin", GRANT, { tool: ["read", "evil"] });
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BoundaryCapabilityError);
      const e = err as BoundaryCapabilityError;
      expect(e.boundary).toBe("plugin");
      expect(e.info.code).toBe("SECURITY_DENIED");
      expect(e.violations[0]?.kind).toBe("tool_escalation");
      expect(e.violations[0]?.declared).toContain("evil");
    }
  });

  it("emits security.capability_denied BEFORE throwing when a sink is wired", async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sink: EventSink = {
      async emit(_sessionId, type, payload) {
        emitted.push({ type, payload });
      },
    };
    await expect(
      composeBoundaryCapability("child-agent", GRANT, { network: ["evil.example.com"] }, {
        events: sink,
        sessionId: newSessionId(),
        source: "delegator",
      }),
    ).rejects.toBeInstanceOf(BoundaryCapabilityError);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe("security.capability_denied");
    expect(emitted[0]?.payload.source).toBe("delegator");
    expect(emitted[0]?.payload.code).toBe("SECURITY_DENIED");
    expect((emitted[0]?.payload.details as string[]).join(" ")).toContain("network_escalation");
  });

  it("a successful compose emits nothing", async () => {
    const emitted: unknown[] = [];
    const sink: EventSink = {
      async emit() {
        emitted.push(1);
      },
    };
    await composeBoundaryCapability("mcp", GRANT, { tool: ["read"] }, {
      events: sink,
      sessionId: newSessionId(),
    });
    expect(emitted).toHaveLength(0);
  });
});

describe("CAPABILITY_BOUNDARIES — P14-4 audited surfaces", () => {
  it("lists exactly the boundaries the plan audits", () => {
    expect([...CAPABILITY_BOUNDARIES]).toEqual([
      "child-agent",
      "mcp",
      "plugin",
      "hook",
      "skill",
    ]);
  });
});
