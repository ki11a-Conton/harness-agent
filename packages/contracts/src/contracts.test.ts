import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  errorInfo,
  newAgentId,
  newApprovalId,
  newAskId,
  newEventId,
  newMemoryId,
  newMessageId,
  newProcessId,
  newRunId,
  newSessionId,
  newSkillId,
  newToolCallId,
  newTraceId,
  newTurnId,
} from "./index.js";
import { EVENT_TYPES } from "./event.js";
import { RETRY_KINDS, RETRY_KIND_SPECS, isRetryKind } from "./retry.js";
import type { ToolCallTrace } from "./stall.js";
import { detectStallPattern } from "./stall.js";
import { AdaptiveRecoveryPlanner } from "./recovery.js";
import {
  ASK_REASONS,
  defaultAskUserLifecycle,
  isAskReason,
} from "./ask-user.js";
import { APPROVAL_SCOPES, approvalDecisionRecord, isApprovalScope } from "./approval.js";
import {
  GRANT_BOUNDS,
  consumePermissionGrantUsage,
  grantRemainingMs,
  isGrantExpired,
} from "./permission-expiry.js";
import { CAPABILITY_DIMENSIONS, composeCapabilities } from "./capability.js";

const SRC = join(import.meta.dirname);

describe("ids", () => {
  it("produces stable opaque prefixed IDs", () => {
    expect(newSessionId()).toMatch(/^session_/);
    expect(newTurnId()).toMatch(/^turn_/);
    expect(newMessageId()).toMatch(/^message_/);
    expect(newToolCallId()).toMatch(/^toolcall_/);
    expect(newApprovalId()).toMatch(/^approval_/);
    expect(newEventId()).toMatch(/^event_/);
    expect(newRunId()).toMatch(/^run_/);
    expect(newMemoryId()).toMatch(/^memory_/);
    expect(newSkillId()).toMatch(/^skill_/);
    expect(newAgentId()).toMatch(/^agent_/);
    expect(newProcessId()).toMatch(/^proc_/);
    expect(newTraceId()).toMatch(/^trace_/);
    expect(newAskId()).toMatch(/^ask_/);
  });

  it("never collides", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = newEventId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe("errors", () => {
  it("applies retry defaults per failure class", () => {
    expect(errorInfo("PERMISSION_DENIED").retryable).toBe(false);
    expect(errorInfo("NETWORK_ERROR").safeToRetry).toBe(true);
    expect(errorInfo("MODEL_ERROR").retryable).toBe(true);
    expect(errorInfo("PROCESS_TIMEOUT").safeToRetry).toBe(false);
    expect(errorInfo("SECURITY_DENIED").retryable).toBe(false);
    expect(errorInfo("SECURITY_DENIED").safeToRetry).toBe(false);
  });

  it("carries custom message and overrides", () => {
    const e = errorInfo("TOOL_SCHEMA_ERROR", "bad args", { evidence: "x" });
    expect(e.message).toBe("bad args");
    expect(e.evidence).toBe("x");
  });
});

describe("event types", () => {
  it("includes security.injection_denied", () => {
    expect(EVENT_TYPES).toContain("security.injection_denied");
    expect(EVENT_TYPES).toContain("security.network_denied");
    expect(EVENT_TYPES).toContain("security.permission_denied");
    expect(EVENT_TYPES).toContain("security.filesystem_denied");
    expect(EVENT_TYPES).toContain("security.process_denied");
    expect(EVENT_TYPES).toContain("security.secret_redacted");
  });

  it("P2-40: retry.reconciliation and retry.mcpReconnect are registered event types", () => {
    expect(EVENT_TYPES).toContain("retry.reconciliation");
    expect(EVENT_TYPES).toContain("retry.mcpReconnect");
  });

  it("P2-43: the ask-user gate has registered event types", () => {
    expect(EVENT_TYPES).toContain("ask.user_asked");
    expect(EVENT_TYPES).toContain("ask.user_replied");
    expect(EVENT_TYPES).toContain("ask.turn_waiting");
  });
});

describe("retry taxonomy V2", () => {
  it("every kind has a governing spec (max attempts / backoff / safe predicate / termination)", () => {
    for (const kind of RETRY_KINDS) {
      const spec = RETRY_KIND_SPECS[kind];
      expect(spec, `${kind} must have a spec`).toBeDefined();
      expect(spec.kind).toBe(kind);
      expect(Number.isInteger(spec.maxAttempts) && spec.maxAttempts >= 0).toBe(true);
      expect(isRetryKind(kind)).toBe(true);
    }
  });

  it("termination behaviors are drawn from the bounded TerminationReason taxonomy", () => {
    const terminations = new Set<string>(Object.values(RETRY_KIND_SPECS).map((s) => s.terminationBehavior));
    // Every behavior is a known member; asserting the closed set below keeps
    // retry <-> termination taxonomies in lock-step.
    expect([...terminations].sort()).toEqual(
      [
        "context_limit",
        "model_error",
        "provider_error",
        "resume_ambiguous",
        "tool_limit",
        "verification_failed",
      ].sort(),
    );
  });

  it("reconciliation is never auto-redone and mcpReconnect is bounded", () => {
    expect(RETRY_KIND_SPECS.reconciliation.safePredicate).toBe("never");
    expect(RETRY_KIND_SPECS.reconciliation.maxAttempts).toBe(0);
    expect(RETRY_KIND_SPECS.reconciliation.terminationBehavior).toBe("resume_ambiguous");
    expect(RETRY_KIND_SPECS.mcpReconnect.maxAttempts).toBeGreaterThan(0);
    expect(RETRY_KIND_SPECS.mcpReconnect.safePredicate).toBe("always");
    expect(RETRY_KIND_SPECS.mcpReconnect.terminationBehavior).toBe("provider_error");
  });
});

describe("stall detection V2", () => {
  function trace(
    name: string,
    args: string,
    opts: Partial<ToolCallTrace> = {},
  ): ToolCallTrace {
    return { name, argsKey: args, ...opts };
  }

  it("identical_tool: the same call with an unchanged result is a stall", () => {
    const w: ToolCallTrace[] = Array.from({ length: 3 }, () => trace("exec", "{cmd:ls}", { resultFingerprint: "r1" }));
    expect(detectStallPattern(w)).toBe("identical_tool");
  });

  it("identical_tool is NOT reported when the result changed (progress)", () => {
    const w: ToolCallTrace[] = [
      trace("exec", "{cmd:ls}", { resultFingerprint: "r1" }),
      trace("exec", "{cmd:ls}", { resultFingerprint: "r2" }),
      trace("exec", "{cmd:ls}", { resultFingerprint: "r3" }),
    ];
    expect(detectStallPattern(w)).toBeNull();
  });

  it("alternating_loop: A->B->A->B with unchanged results is a stall", () => {
    const a = () => trace("read", "{path:a}", { resultFingerprint: "ra" });
    const b = () => trace("read", "{path:b}", { resultFingerprint: "rb" });
    const w = [a(), b(), a(), b(), a(), b()];
    expect(detectStallPattern(w)).toBe("alternating_loop");
  });

  it("repeated_read_no_change: repeated read of the same file/args", () => {
    const r1 = trace("read_file", "{path:f}", { isRead: true, resultFingerprint: "same" });
    const r2 = trace("read_file", "{path:f}", { isRead: true, resultFingerprint: "same" });
    expect(detectStallPattern([r1, r2])).toBe("repeated_read_no_change");
  });

  it("repeated_error: the same failure code repeated", () => {
    const w: ToolCallTrace[] = Array.from({ length: 3 }, () =>
      trace("exec", "{cmd:x}", { errorCode: "NETWORK_ERROR" }),
    );
    expect(detectStallPattern(w)).toBe("repeated_error");
  });

  it("verification_fix_loop: a write between two unchanged reads is a stuck edit->re-check cycle", () => {
    const readFail = (id: string) => trace("run_tests", `{id:${id}}`, { isRead: true, resultFingerprint: "fail-same" });
    const w: ToolCallTrace[] = [
      readFail("a"),
      trace("edit_file", "{path:x}", { resultFingerprint: "edit-out" }),
      readFail("b"),
    ];
    expect(detectStallPattern(w)).toBe("verification_fix_loop");
  });

  it("verification_fix_loop is NOT reported when the read feedback changed (progress)", () => {
    const w: ToolCallTrace[] = [
      trace("run_tests", "{run:1}", { isRead: true, resultFingerprint: "fail" }),
      trace("edit_file", "{path:x}", { resultFingerprint: "edit-out" }),
      trace("run_tests", "{run:2}", { isRead: true, resultFingerprint: "pass" }),
    ];
    expect(detectStallPattern(w)).toBeNull();
  });

  it("verification_fix_loop requires at least one write between reads", () => {
    const w: ToolCallTrace[] = [
      trace("run_tests", "{cmd:test}", { isRead: true, resultFingerprint: "same" }),
      trace("run_tests", "{cmd:test}", { isRead: true, resultFingerprint: "same" }),
    ];
    // No write -> the pure repeated-read rule owns this case.
    expect(detectStallPattern(w)).toBe("repeated_read_no_change");
  });

  it("no_progress only on a long window of varying calls with identical results (bounded false positives)", () => {
    // Calls churn but every result is unchanged -> genuine no-progress.
    const churn: ToolCallTrace[] = [
      trace("grep", "{q:a}", { resultFingerprint: "r" }),
      trace("list", "{q:b}", { resultFingerprint: "r" }),
      trace("grep", "{q:c}", { resultFingerprint: "r" }),
      trace("read", "{q:d}", { resultFingerprint: "r" }),
      trace("grep", "{q:e}", { resultFingerprint: "r" }),
      trace("list", "{q:f}", { resultFingerprint: "r" }),
      trace("grep", "{q:g}", { resultFingerprint: "r" }),
      trace("read", "{q:h}", { resultFingerprint: "r" }),
    ];
    expect(detectStallPattern(churn)).toBe("no_progress");
    // A short identical pair does not escalate to no_progress.
    const short: ToolCallTrace[] = Array.from({ length: 2 }, () => trace("mcp", "{q:1}", { resultFingerprint: "r" }));
    expect(detectStallPattern(short)).toBe("identical_tool");
  });

  it("returns null for an empty or single-element window", () => {
    expect(detectStallPattern([])).toBeNull();
    expect(detectStallPattern([trace("x", "{}")])).toBeNull();
  });
});

describe("adaptive recovery V2", () => {
  it("picks retry first for a tool_failure while budget remains", () => {
    const p = new AdaptiveRecoveryPlanner();
    const d = p.decide("tool_failure");
    expect(d.action).toBe("retry");
    expect(d.remaining).toBe(2); // 0/3 used
  });

  it("falls to change_strategy once retry budget is spent", () => {
    const p = new AdaptiveRecoveryPlanner();
    const d = p.decide("tool_failure", { retry: 3 });
    // retry exhausted, change_strategy addresses tool_failure and still has budget.
    expect(d.action).toBe("change_strategy");
    expect(d.used).toBe(0);
  });

  it("compact is chosen for context_overflow (retry cannot self-heal it)", () => {
    const p = new AdaptiveRecoveryPlanner();
    const d = p.decide("context_overflow");
    expect(d.action).toBe("compact");
  });

  it("refresh_mcp is chosen for mcp_disconnected", () => {
    const p = new AdaptiveRecoveryPlanner();
    const d = p.decide("mcp_disconnected");
    expect(d.action).toBe("refresh_mcp");
  });

  it("ask_user is the best remaining action for context_overflow after compaction spent", () => {
    const p = new AdaptiveRecoveryPlanner();
    const d = p.decide("context_overflow", { compact: 2 });
    expect(d.action).toBe("ask_user");
  });

  it("fails safe when every eligible action is spent", () => {
    const p = new AdaptiveRecoveryPlanner();
    const d = p.decide("test_failure", {
      retry: 3,
      change_strategy: 2,
      delegate_specialist: 1,
    });
    expect(d.action).toBe("fail_safe");
    // fail_safe is the unlimited backstop.
    expect(d.remaining).toBeGreaterThan(0);
  });

  it("respects a budget override that disables an action", () => {
    const p = new AdaptiveRecoveryPlanner({ retry: { budget: 0 } });
    const d = p.decide("tool_failure");
    // retry disabled -> next in priority that addresses tool_failure.
    expect(d.action).not.toBe("retry");
    expect(d.action).toBe("change_strategy");
  });

  it("rejects an unknown recovery input with a TypeError", () => {
    const p = new AdaptiveRecoveryPlanner();
    expect(() => p.decide("bogus" as never)).toThrow(TypeError);
  });
});

describe("ask-user gate V2", () => {
  it("the AskReason taxonomy is closed and known", () => {
    expect(ASK_REASONS).toEqual(
      expect.arrayContaining(["missing_critical_input", "ambiguous_goal", "unresolvable_context", "choice_required"]),
    );
    for (const reason of ASK_REASONS) {
      expect(isAskReason(reason)).toBe(true);
    }
    expect(isAskReason("bogus")).toBe(false);
    expect(isAskReason(42)).toBe(false);
  });

  it("default lifecycle classifies pending vs answered and dedupes per session+turn", () => {
    const req = {
      id: newAskId(),
      sessionId: newSessionId(),
      turnId: newTurnId(),
      reason: "choice_required" as const,
      question: "Pick a target?",
      options: ["a", "b"],
      status: "pending" as const,
      createdAt: 1,
    };
    expect(defaultAskUserLifecycle.isPending(req)).toBe(true);
    expect(defaultAskUserLifecycle.isAnswered(req)).toBe(false);
    const other = { ...req, id: newAskId(), sessionId: newSessionId() };
    expect(defaultAskUserLifecycle.hasPending(req.sessionId, req.turnId!)(req)).toBe(true);
    expect(defaultAskUserLifecycle.hasPending(other.sessionId, other.turnId!)(req)).toBe(false);
  });

  it("resumePrompt renders the injected user message tagged with the ask id", () => {
    const reply = { requestId: newAskId(), text: "the subdir", answeredAt: 5 };
    const prompt = defaultAskUserLifecycle.resumePrompt(reply);
    expect(prompt.content).toContain("the subdir");
    expect(prompt.askId).toBe(reply.requestId);
  });

  it("fingerprint is stable and distinct across asks", () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();
    const a = defaultAskUserLifecycle.fingerprint({ id: newAskId(), sessionId, turnId, reason: "ambiguous_goal", question: "q", status: "pending", createdAt: 1 });
    const b = defaultAskUserLifecycle.fingerprint({ id: newAskId(), sessionId, turnId, reason: "ambiguous_goal", question: "q", status: "pending", createdAt: 1 });
    expect(a).not.toBe(b);
  });
});

describe("approval scope + audit (P2-44)", () => {
  it("the approval scope taxonomy is closed and known", () => {
    expect(APPROVAL_SCOPES).toEqual(
      expect.arrayContaining(["one_call", "one_tool", "session"]),
    );
    for (const scope of APPROVAL_SCOPES) {
      expect(isApprovalScope(scope)).toBe(true);
    }
    expect(isApprovalScope("global")).toBe(false);
    expect(isApprovalScope(7)).toBe(false);
  });

  it("approvalDecisionRecord projects an explicit, auditable record", () => {
    const sessionId = newSessionId();
    const agentId = newAgentId();
    const request = {
      id: newApprovalId(),
      sessionId,
      turnId: newTurnId(),
      agentId,
      action: "exec",
      target: "rm -rf /",
      reason: "expanded permission",
      scope: "session" as const,
      createdAt: 1,
      expiresAt: 100,
    };
    const record = approvalDecisionRecord(request, {
      id: request.id,
      value: "allow",
      decidedAt: 50,
      decidedBy: "user-42",
    });
    expect(record.scope).toBe("session");
    expect(record.expired).toBe(false);
    expect(record.decidedBy).toBe("user-42");
    expect(record.sessionId).toBe(sessionId);
    expect(record.action).toBe("exec");
    expect(record.target).toBe("rm -rf /");
  });

  it("missing scope defaults to one_call; expired decisions are flagged", () => {
    const request = {
      id: newApprovalId(),
      sessionId: newSessionId(),
      agentId: newAgentId(),
      action: "exec",
      target: "ls",
      reason: "r",
      createdAt: 1,
      expiresAt: 100,
    };
    expect(approvalDecisionRecord(request, { id: request.id, value: "allow", decidedAt: 200 }).scope).toBe("one_call");
    expect(approvalDecisionRecord(request, { id: request.id, value: "expired", decidedAt: 200 }).expired).toBe(true);
  });
});

describe("permission expansion expiry (P2-44)", () => {
  const sessionId = newSessionId();
  const agentId = newAgentId();
  const approvalId = newApprovalId();

  function grant(over: Partial<Parameters<typeof isGrantExpired>[0]> = {}) {
    return {
      sessionId,
      grantKey: "exec@npm install *",
      bound: "session" as const,
      approvalId,
      agentId,
      grantedAt: 0,
      expiresAt: 1000,
      remainingUses: undefined,
      ...over,
    };
  }

  it("hard expiry kills a grant regardless of remaining usage", () => {
    const g = grant({ expiresAt: 1000, remainingUses: 5 });
    expect(isGrantExpired(g, 999)).toBe(false);
    expect(isGrantExpired(g, 1000)).toBe(true);
    expect(grantRemainingMs(g, 400)).toBe(600);
    expect(grantRemainingMs(g, 9999)).toBe(0);
  });

  it("one_call grants are single-use and consumed to death", () => {
    // one_call ⇒ a usage meter of exactly 1; a single consume exhausts it.
    expect(consumePermissionGrantUsage(grant({ bound: "one_call", remainingUses: 1 }), 5)).toBeUndefined();
  });

  it("undefined remainingUses is an uncapped (session) grant that never dies by usage", () => {
    const g = consumePermissionGrantUsage(grant({ bound: "session", remainingUses: undefined }), 5);
    expect(g).toBeDefined();
    expect(consumePermissionGrantUsage(g!, 6)?.remainingUses).toBeUndefined();
  });

  it("bounded grants are usage-limited", () => {
    let g = consumePermissionGrantUsage(grant({ bound: "one_tool", remainingUses: 2 }), 5);
    expect(g?.remainingUses).toBe(1);
    g = consumePermissionGrantUsage(g!, 6);
    // Exactly 1 remaining used ⇒ grant is exhausted and dropped (no 0 state).
    expect(g).toBeUndefined();
  });

  it("the grant bound taxonomy is closed and known", () => {
    expect(GRANT_BOUNDS).toEqual(expect.arrayContaining(["one_call", "one_tool", "session"]));
  });
});

describe("capability escalation defense (P2-45)", () => {
  const CONFER: Parameters<typeof composeCapabilities>[0] = {
    tool: ["read", "write", "exec"],
    filesystem: ["/home/u/work"],
    network: ["api.example.com"],
    process: ["npm test"],
  };

  it("the capability dimensions are closed and known", () => {
    expect(CAPABILITY_DIMENSIONS).toEqual(
      expect.arrayContaining(["tool", "filesystem", "network", "process"]),
    );
  });

  it("declaring only a subset of the conferred bound is valid narrowing", () => {
    const verdict = composeCapabilities(CONFER, { tool: ["read"], filesystem: ["/home/u/work/docs"] });
    expect(verdict.allowed).toBe(true);
    expect(verdict.effective.tool).toEqual(["read"]);
    expect(verdict.effective.filesystem).toEqual(["/home/u/work/docs"]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.narrowed).toContain("tool");
    expect(verdict.narrowed).toContain("filesystem");
    // undeclared dimensions are inherited unchanged (never widened)
    expect(verdict.effective.network).toEqual(["api.example.com"]);
  });

  it("declaring an item outside the conferred bound is an escalation violation", () => {
    const verdict = composeCapabilities(CONFER, {
      filesystem: ["/etc/passwd"],
      network: ["evil.example.com"],
    });
    expect(verdict.allowed).toBe(false);
    const kinds = verdict.violations.map((v) => v.kind);
    expect(kinds).toContain("filesystem_escalation");
    expect(kinds).toContain("network_escalation");
    // effective is the intersection: the escalated item is dropped, not granted
    expect(verdict.effective.filesystem).toEqual([]);
    expect(verdict.effective.network).toEqual([]);
  });

  it("filesystem narrowing is path-boundary aware (sibling roots are out of scope)", () => {
    // `/home/u/workdocs` shares a textual prefix with `/home/u/work` but is a
    // sibling, NOT a child — it is outside the conferred root and must be denied.
    const verdict = composeCapabilities(CONFER, { filesystem: ["/home/u/workdocs"] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations.some((v) => v.kind === "filesystem_escalation")).toBe(true);
    expect(verdict.effective.filesystem).toEqual([]);

    // a genuine descendant is valid narrowing and survives the intersection
    const ok = composeCapabilities(CONFER, { filesystem: ["/home/u/work/sub"] });
    expect(ok.allowed).toBe(true);
    expect(ok.effective.filesystem).toEqual(["/home/u/work/sub"]);
  });

  it("a subordinate cannot widen the tool allowlist via its own config", () => {
    const verdict = composeCapabilities(CONFER, { tool: ["read", "exec", "rm_rf", "curl_to_any_host"] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations.some((v) => v.kind === "tool_escalation")).toBe(true);
    expect(verdict.effective.tool).toEqual(["read", "exec"]);
  });

  it("a subordinate's own '*' claim is only valid if conferred also allows '*'", () => {
    const denied = composeCapabilities({ ...CONFER, process: ["npm test"] }, { process: ["*"] });
    expect(denied.allowed).toBe(false);
    expect(denied.violations.some((v) => v.kind === "process_escalation")).toBe(true);

    const full = composeCapabilities(
      { tool: ["*"], filesystem: ["*"], network: ["*"], process: ["*"] },
      { tool: ["*"], process: ["npm install"] },
    );
    expect(full.allowed).toBe(true);
    expect(full.effective.process).toEqual(["npm install"]);
  });

  it("conferred '*' permits any declared item as narrowing", () => {
    const verdict = composeCapabilities(
      { tool: ["*"], filesystem: ["*"], network: ["*"], process: ["*"] },
      { network: ["anything.example.org"], filesystem: ["/tmp/x"] },
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.effective.network).toEqual(["anything.example.org"]);
    expect(verdict.effective.filesystem).toEqual(["/tmp/x"]);
  });

  it("omission never widens: undeclared dimensions carry the conferred bound", () => {
    const verdict = composeCapabilities(CONFER, {
      tool: ["read"],
      // filesystem/network/process intentionally omitted
    });
    // unchanged, and *not* expanded to something the subordinate could sneak in
    expect(verdict.effective.filesystem).toEqual(["/home/u/work"]);
    expect(verdict.effective.network).toEqual(["api.example.com"]);
    expect(verdict.effective.process).toEqual(["npm test"]);
  });

  it("P14-1: canonicalised traversal (/work/../etc → /etc) is NOT inside /work", () => {
    // composeCapabilities is pure: the caller canonicalises first (realpath +
    // lexical resolution). The canonical form of /work/../etc is /etc, which
    // must fail closed — a textual prefix would have admitted it.
    const verdict = composeCapabilities(
      { tool: [], filesystem: ["/work"], network: [], process: [] },
      { filesystem: ["/etc"] },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations.some((v) => v.kind === "filesystem_escalation")).toBe(true);
    expect(verdict.effective.filesystem).toEqual([]);
  });

  it("P14-1: canonicalised multi-level traversal is NOT inside /work", () => {
    const verdict = composeCapabilities(
      { tool: [], filesystem: ["/work"], network: [], process: [] },
      { filesystem: ["/etc"] }, // /work/a/../../etc canonicalises to /etc
    );
    expect(verdict.allowed).toBe(false);
  });

  it("P14-1: sibling roots with shared text prefix are NOT inside (no prefix illusion)", () => {
    const verdict = composeCapabilities(
      { tool: [], filesystem: ["/home/u/work"], network: [], process: [] },
      { filesystem: ["/home/u/workx", "/home/u/work2"] },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.effective.filesystem).toEqual([]);
  });

  it("P14-1: Windows drive sibling is NOT inside (C:\\work2 vs C:\\work)", () => {
    const verdict = composeCapabilities(
      { tool: [], filesystem: ["C:/work"], network: [], process: [] },
      { filesystem: ["C:/work2"] },
    );
    expect(verdict.allowed).toBe(false);
  });

  it("P14-1: case-insensitive folding narrows correctly and still rejects siblings", () => {
    const verdict = composeCapabilities(
      { tool: [], filesystem: ["/home/u/work"], network: [], process: [] },
      { filesystem: ["/HOME/U/WORK/sub"] },
      { caseInsensitive: true },
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.effective.filesystem).toEqual(["/HOME/U/WORK/sub"]);

    const sibling = composeCapabilities(
      { tool: [], filesystem: ["/home/u/work"], network: [], process: [] },
      { filesystem: ["/HOME/U/WORK-SIBLING"] },
      { caseInsensitive: true },
    );
    expect(sibling.allowed).toBe(false);
  });
});

describe("contracts purity", () => {
  it("contains no forbidden imports (no core/UI/providers/filesystem deps)", () => {
    const srcFiles = readdirSync(SRC, { recursive: true }) as string[];
    const sources = srcFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of sources) {
      const text = readFileSync(join(SRC, file), "utf8");
      const forbidden = ["@ar/core", "@ar/model", "@ar/tools", "@ar/security", "node:fs", "zod/"];
      for (const f of forbidden) {
        expect(text, `${file} must not import ${f}`).not.toContain(f);
      }
    }
  });

  it("has no circular relative imports", () => {
    const files = new Set(
      (readdirSync(SRC, { recursive: true }) as string[])
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")),
    );
    const moduleImports = new Map<string, Set<string>>();
    for (const file of files) {
      const text = readFileSync(join(SRC, file), "utf8");
      const imports = new Set<string>();
      for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const target = m[1]!.replace(/\.js$/, "").replace(/^\.\//, "");
        const resolved = `${target}.ts`;
        if (files.has(resolved)) imports.add(resolved);
      }
      moduleImports.set(file, imports);
    }

    const WHITE = "WHITE";
    const GRAY = "GRAY";
    const BLACK = "BLACK";
    const color = new Map<string, string>();
    const cycleNodes = new Set<string>();

    function dfs(node: string): void {
      color.set(node, GRAY);
      for (const next of moduleImports.get(node) ?? []) {
        const c = color.get(next);
        if (c === GRAY) {
          cycleNodes.add(next);
        } else if (c === WHITE) {
          dfs(next);
        }
      }
      color.set(node, BLACK);
    }

    for (const f of files) {
      if ((color.get(f) ?? WHITE) === WHITE) dfs(f);
    }

    expect([...cycleNodes], "circular imports detected").toEqual([]);
  });
});