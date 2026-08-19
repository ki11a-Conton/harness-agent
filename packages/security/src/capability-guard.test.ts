import { describe, expect, it } from "vitest";
import type { SandboxPolicy } from "@ar/contracts";
import {
  CapabilityEscalationError,
  capabilitySetsFromGrant,
  composeChildCapability,
} from "./capability-guard.js";

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

describe("composeChildCapability (P2-45)", () => {
  it("a subordinate may only narrow; widening the filesystem root is denied", () => {
    expect(() =>
      composeChildCapability(GRANT, {
        filesystem: ["/home/u/work", "/etc/passwd"],
      }),
    ).toThrow(CapabilityEscalationError);
  });

  it("a subordinate cannot add a new network host it was not conferred", () => {
    expect(() =>
      composeChildCapability(GRANT, {
        network: ["evil.example.com"],
      }),
    ).toThrow(CapabilityEscalationError);
  });

  it("a subordinate cannot add a process command to its own policy", () => {
    expect(() =>
      composeChildCapability(GRANT, {
        process: ["npm test", "rm -rf /"],
      }),
    ).toThrow(CapabilityEscalationError);
  });

  it("a subordinate cannot widen the tool allowlist via its own config", () => {
    expect(() =>
      composeChildCapability(GRANT, { tool: ["read", "write", "exec", "prompt_inject"] }),
    ).toThrow(CapabilityEscalationError);
  });

  it("a valid narrowing returns a restricted policy + tool allowlist", () => {
    const out = composeChildCapability(GRANT, {
      tool: ["write"],
      filesystem: ["/home/u/work/docs"],
      network: ["api.example.com"],
    });
    expect(out.toolAllowlist).toEqual(["write"]);
    expect(out.policy.filesystem.allowedPaths).toEqual(["/home/u/work/docs"]);
    expect(out.policy.network.hosts).toEqual(["api.example.com"]);
    // undeclared process dimension is inherited unchanged (narrowed to conferred)
    expect(out.policy.process.allowedCommands).toEqual(["npm test", "git status"]);
    expect(out.narrowed).toContain("tool");
  });

  it("omitting a dimension never widens it (inherits the conferred bound)", () => {
    const out = composeChildCapability(GRANT, { tool: ["read"] });
    expect(out.policy.filesystem.allowedPaths).toEqual(["/home/u/work"]);
    expect(out.policy.network.hosts).toEqual(["api.example.com"]);
    expect(out.policy.process.allowedCommands).toEqual(["npm test", "git status"]);
  });

  it("a full-conferral upper bound can still only narrow downward", () => {
    const full = grantedPolicy({
      filesystem: { mode: "full" },
      network: { mode: "full" },
      process: { allowedCommands: ["*"] },
    });
    const grant = { policy: full, toolAllowlist: ["*"] };
    const out = composeChildCapability(grant, {
      tool: ["exec"],
      filesystem: ["/only/this"],
      network: ["narrow.example.net"],
      process: ["npm install"],
    });
    expect(out.toolAllowlist).toEqual(["exec"]);
    expect(out.policy.filesystem.allowedPaths).toEqual(["/only/this"]);
    expect(out.policy.network.hosts).toEqual(["narrow.example.net"]);
    expect(out.policy.process.allowedCommands).toEqual(["npm install"]);
  });

  it("capabilitySetsFromGrant projects full modes as '*'", () => {
    const sets = capabilitySetsFromGrant({
      policy: grantedPolicy({
        filesystem: { mode: "full" },
        network: { mode: "full" },
      }),
      toolAllowlist: ["read"],
    });
    expect(sets.filesystem).toEqual(["*"]);
    expect(sets.network).toEqual(["*"]);
    expect(sets.tool).toEqual(["read"]);
  });
});