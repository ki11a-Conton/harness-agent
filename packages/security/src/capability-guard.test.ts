import { describe, expect, it } from "vitest";
import type { SandboxPolicy } from "@ar/contracts";
import { canonicalizePath } from "./canonical-path.js";
import {
  CapabilityEscalationError,
  capabilitySetsFromGrant,
  composeChildCapability,
} from "./capability-guard.js";

/**
 * The guard canonicalises filesystem paths with the SAME function the
 * SandboxManager uses (P14-1), so the expected effective allowedPaths are the
 * canonicalised forms — never the raw strings.  `C` mirrors that contract.
 */
const C = (p: string): string => canonicalizePath(p, { cwd: process.cwd() });

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
    expect(out.policy.filesystem.allowedPaths).toEqual([C("/home/u/work/docs")]);
    expect(out.policy.network.hosts).toEqual(["api.example.com"]);
    // undeclared process dimension is inherited unchanged (narrowed to conferred)
    expect(out.policy.process.allowedCommands).toEqual(["npm test", "git status"]);
    expect(out.narrowed).toContain("tool");
  });

  it("omitting a dimension never widens it (inherits the conferred bound)", () => {
    const out = composeChildCapability(GRANT, { tool: ["read"] });
    expect(out.policy.filesystem.allowedPaths).toEqual([C("/home/u/work")]);
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
    expect(out.policy.filesystem.allowedPaths).toEqual([C("/only/this")]);
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

describe("composeChildCapability — P14-1 filesystem canonicalization", () => {
  it("traversal via .. is denied after canonicalization (/home/u/work/../etc)", () => {
    // canonicalizePath turns /home/u/work/../etc into …/home/u/etc, which is
    // NOT inside the conferred root /home/u/work — the text 'looks inside' but
    // the resolved path is out of scope. Fail closed.
    expect(() =>
      composeChildCapability(GRANT, {
        filesystem: ["/home/u/work/../etc"],
      }),
    ).toThrow(CapabilityEscalationError);
  });

  it("multi-level traversal is denied (/home/u/work/a/../../etc)", () => {
    expect(() =>
      composeChildCapability(GRANT, {
        filesystem: ["/home/u/work/a/../../etc"],
      }),
    ).toThrow(CapabilityEscalationError);
  });

  it("sibling roots with a shared textual prefix are denied (/home/u/workx)", () => {
    expect(() =>
      composeChildCapability(GRANT, {
        filesystem: ["/home/u/workx"],
      }),
    ).toThrow(CapabilityEscalationError);
  });

  it("sibling roots with a numeric suffix are denied (/home/u/work2)", () => {
    expect(() =>
      composeChildCapability(GRANT, {
        filesystem: ["/home/u/work2"],
      }),
    ).toThrow(CapabilityEscalationError);
  });

  it("a clean narrowing inside the root is allowed and canonicalised", () => {
    const out = composeChildCapability(GRANT, {
      filesystem: ["/home/u/work/sub"],
    });
    expect(out.policy.filesystem.allowedPaths).toEqual([C("/home/u/work/sub")]);
  });

  it("declared . and .. mixtures resolve before comparison", () => {
    // /home/u/work/./sub/../deep → canonical …/home/u/work/deep → still inside
    const out = composeChildCapability(GRANT, {
      filesystem: ["/home/u/work/./sub/../deep"],
    });
    expect(out.policy.filesystem.allowedPaths).toEqual([C("/home/u/work/deep")]);
  });

  it("Windows drive traversal is denied (C:\\work\\..\\Windows against C:\\work)", () => {
    const winGrant = {
      policy: grantedPolicy({
        filesystem: { mode: "workspace-write", allowedPaths: ["C:\\work"] },
      }),
      toolAllowlist: ["read"],
    };
    expect(() =>
      composeChildCapability(winGrant, {
        filesystem: ["C:\\work\\..\\Windows"],
      }),
    ).toThrow(CapabilityEscalationError);
  });

  it("Windows sibling is denied (C:\\work2 against C:\\work)", () => {
    const winGrant = {
      policy: grantedPolicy({
        filesystem: { mode: "workspace-write", allowedPaths: ["C:\\work"] },
      }),
      toolAllowlist: ["read"],
    };
    expect(() =>
      composeChildCapability(winGrant, {
        filesystem: ["C:\\work2"],
      }),
    ).toThrow(CapabilityEscalationError);
  });

  it("case-insensitive policy folds differently-cased declared paths", () => {
    const ciGrant = {
      policy: grantedPolicy({
        filesystem: {
          mode: "workspace-write",
          allowedPaths: ["/home/u/work"],
          caseInsensitive: true,
        },
      }),
      toolAllowlist: ["read"],
    };
    const out = composeChildCapability(ciGrant, {
      filesystem: ["/HOME/U/WORK/sub"],
    });
    expect(out.policy.filesystem.allowedPaths).toEqual([C("/HOME/U/WORK/sub")]);
  });
});