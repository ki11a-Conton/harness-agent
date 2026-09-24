import { describe, expect, it } from "vitest";
import type { CapabilityGrant, CapabilityRequest, SessionId } from "@ar/contracts";
import { approvalFingerprint } from "@ar/contracts";
import { DefaultGrantCache, grantFromApproval } from "./approval-capability.js";

const SESSION = "sess-1" as SessionId;

function execCap(input: Partial<{
  environmentId: string;
  cwd: string;
  argv: readonly string[];
  tty: boolean;
  permissionDelta: Record<string, number> | undefined;
}> = {}): CapabilityRequest {
  return {
    kind: "exec",
    environmentId: input.environmentId ?? "env-1",
    cwd: input.cwd ?? "/work",
    argv: input.argv ?? ["npm", "test"],
    tty: input.tty ?? false,
    ...(input.permissionDelta !== undefined ? { permissionDelta: input.permissionDelta } : {}),
  };
}

function fileCapability(op: "write" | "delete" | "move", paths: readonly string[]): CapabilityRequest {
  return { kind: "file", operation: op, canonicalPaths: paths };
}

function mcpCapability(serverId: string, generation: string, tool: string): CapabilityRequest {
  return { kind: "mcp", serverId, generation, tool, argsHash: "abc123" };
}

function grant(
  capability: CapabilityRequest,
  opts: { scope?: "session" | "one_tool"; decidedBy?: string } = {},
): CapabilityGrant {
  return {
    sessionId: SESSION,
    fingerprint: approvalFingerprint(capability),
    capability,
    scope: opts.scope ?? "session",
    createdAt: 1000,
    ...(opts.decidedBy !== undefined ? { decidedBy: opts.decidedBy } : {}),
  };
}

function coveredById(cache: DefaultGrantCache, request: CapabilityRequest): boolean {
  return cache.isCovered(request, SESSION);
}

describe("P28-1 typed capability identity", () => {
  it("distinguishes capability kinds", () => {
    expect(approvalFingerprint(execCap())).toMatch(/^exec:/);
    expect(approvalFingerprint(fileCapability("write", ["/a"]))).toMatch(/^file:/);
    expect(approvalFingerprint(mcpCapability("srv", "gen1", "toolA"))).toMatch(/^mcp:/);
  });

  it("same command + cwd + env → same fingerprint (stable identity)", () => {
    const a = approvalFingerprint(execCap({ argv: ["npm", "test"] }));
    const b = approvalFingerprint(execCap({ argv: ["npm", "test"] }));
    expect(a).toBe(b);
  });

  it("different cwd → different fingerprint (P28-3: same command different cwd → no match)", () => {
    const a = approvalFingerprint(execCap({ cwd: "/work" }));
    const b = approvalFingerprint(execCap({ cwd: "/other" }));
    expect(a).not.toBe(b);
  });

  it("argv order matters (canonical representation)", () => {
    const a = approvalFingerprint(execCap({ argv: ["npm", "test"] }));
    const b = approvalFingerprint(execCap({ argv: ["test", "npm"] }));
    expect(a).not.toBe(b);
  });

  it("permissionDelta is part of the identity", () => {
    const a = approvalFingerprint(execCap({ permissionDelta: { fs: 2 } }));
    const b = approvalFingerprint(execCap({ permissionDelta: { fs: 3 } }));
    expect(a).not.toBe(b);
  });

  it("file operation and paths are part of the identity", () => {
    const a = approvalFingerprint(fileCapability("write", ["/a", "/b"]));
    const b = approvalFingerprint(fileCapability("delete", ["/a", "/b"]));
    const c = approvalFingerprint(fileCapability("write", ["/b", "/a"])); // order-independent
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});

describe("P28-4 grant coverage (authority subset checks, fail closed)", () => {
  it("same command + cwd → covered", () => {
    const c = new DefaultGrantCache();
    c.remember(grant(execCap()));
    expect(coveredById(c, execCap())).toBe(true);
  });

  it("same command, different cwd → NOT covered", () => {
    const c = new DefaultGrantCache();
    c.remember(grant(execCap({ cwd: "/work" })));
    expect(coveredById(c, execCap({ cwd: "/other" }))).toBe(false);
  });

  it("less privilege (narrower argv) → may match (subset)", () => {
    const c = new DefaultGrantCache();
    c.remember(grant(execCap({ argv: ["npm", "test", "--coverage"] })));
    expect(coveredById(c, execCap({ argv: ["npm", "test"] }))).toBe(true);
  });

  it("more privilege (wider argv) → NOT covered", () => {
    const c = new DefaultGrantCache();
    c.remember(grant(execCap({ argv: ["npm", "test"] })));
    expect(coveredById(c, execCap({ argv: ["npm", "test", "--coverage"] }))).toBe(false);
  });

  it("less privilege (narrower permission delta) → covered", () => {
    const c = new DefaultGrantCache();
    c.remember(grant(execCap({ permissionDelta: { fs: 3 } })));
    expect(coveredById(c, execCap({ permissionDelta: { fs: 2 } }))).toBe(true);
  });

  it("more privilege (wider permission delta) → NOT covered", () => {
    const c = new DefaultGrantCache();
    c.remember(grant(execCap({ permissionDelta: { fs: 2 } })));
    expect(coveredById(c, execCap({ permissionDelta: { fs: 3 } }))).toBe(false);
  });

  it("same MCP tool, different server → NO", () => {
    const c = new DefaultGrantCache();
    c.remember(grant(mcpCapability("srvA", "gen1", "tool")));
    expect(coveredById(c, mcpCapability("srvB", "gen1", "tool"))).toBe(false);
  });

  it("same server, different generation with changed schema/authority → NO", () => {
    const c = new DefaultGrantCache();
    c.remember(grant(mcpCapability("srv", "gen1", "tool")));
    expect(coveredById(c, mcpCapability("srv", "gen2", "tool"))).toBe(false);
  });

  it("same server + generation, same tool → covered", () => {
    const c = new DefaultGrantCache();
    c.remember(grant(mcpCapability("srv", "gen1", "tool")));
    expect(coveredById(c, mcpCapability("srv", "gen1", "tool"))).toBe(true);
  });

  it("one_call grants are never remembered (P28-3)", () => {
    const g = grantFromApproval({
      sessionId: SESSION,
      capability: execCap(),
      scope: "one_call" as never, // runtime-invalid; function must reject
    });
    expect(g).toBeUndefined();
  });
});

describe("P28-3 executable scope semantics", () => {
  it("session scope allows reuse for equal capability", () => {
    const cache = new DefaultGrantCache();
    const g = grantFromApproval({
      sessionId: SESSION,
      capability: execCap(),
      scope: "session",
    });
    expect(g).toBeDefined();
    cache.remember(g!);
    expect(coveredById(cache, execCap())).toBe(true);
  });

  it("session scope does NOT allow unrelated capability", () => {
    const cache = new DefaultGrantCache();
    const g = grantFromApproval({
      sessionId: SESSION,
      capability: execCap({ argv: ["git", "status"] }),
      scope: "session",
    });
    cache.remember(g!);
    expect(coveredById(cache, execCap({ argv: ["rm", "-rf", "/"] }))).toBe(false);
  });

  it("one_tool allows narrower reuse within the same tool pattern", () => {
    const cache = new DefaultGrantCache();
    const g = grantFromApproval({
      sessionId: SESSION,
      capability: execCap({ argv: ["npm", "test", "--coverage"] }),
      scope: "one_tool",
    });
    cache.remember(g!);
    expect(coveredById(cache, execCap({ argv: ["npm", "test"] }))).toBe(true);
  });

  it("never widens: approve 'exec npm test' does not approve all exec", () => {
    const cache = new DefaultGrantCache();
    cache.remember(grant(execCap({ argv: ["npm", "test"] })));
    expect(coveredById(cache, execCap({ argv: ["npm", "run", "children"] }))).toBe(false);
    expect(coveredById(cache, execCap({ cwd: "/elsewhere" }))).toBe(false);
  });
});

describe("P28-5 emergency revocation", () => {
  it("revoke session removes all grants for that session", () => {
    const cache = new DefaultGrantCache();
    cache.remember(grant(execCap()));
    cache.remember(grant(fileCapability("write", ["/a"]), { scope: "session" as const }));
    expect(cache.list(SESSION).length).toBe(2);
    const removed = cache.revoke({ kind: "session", sessionId: SESSION });
    expect(removed).toBe(2);
    expect(coveredById(cache, execCap())).toBe(false);
    expect(cache.list(SESSION).length).toBe(0);
  });

  it("grant-targeted revocation only affects that fingerprint", () => {
    const cache = new DefaultGrantCache();
    const e1 = grant(execCap());
    const e2 = grant(fileCapability("write", ["/tmp"]), { scope: "session" as const });
    cache.remember(e1);
    cache.remember(e2);
    const removed = cache.revoke({
      kind: "grant",
      sessionId: SESSION,
      fingerprint: e1.fingerprint,
    });
    expect(removed).toBe(1);
    expect(coveredById(cache, execCap())).toBe(false);
    expect(coveredById(cache, fileCapability("write", ["/tmp"]))).toBe(true);
  });

  it("revoking unknown target removes nothing", () => {
    const cache = new DefaultGrantCache();
    cache.remember(grant(execCap()));
    const removed = cache.revoke({ kind: "grant", sessionId: SESSION, fingerprint: "nope" });
    expect(removed).toBe(0);
    expect(coveredById(cache, execCap())).toBe(true);
  });
});