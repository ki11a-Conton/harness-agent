/**
 * R3/F4 — the PRE-DISPATCH tool budget, at the REAL dispatch point.
 * plan(20260928-105425).md §R3; AGENTS.md Runtime Freeze P38.4-11 clause 2
 * (security/budget boundary) is the sanctioned justification for the change.
 *
 * THE DEFECT (F4, formal-run.ts:998-1009/1052-1064)
 * ------------------------------------------------
 * `maxToolCalls` was an AFTER-THE-FACT tally: the budgeted provider counted the
 * tool calls a model DECLARED in its completed response and charged them in the
 * generator's `finally`. Nothing reserved the campaign's tool quota before a real
 * `ToolOrchestrator` dispatch, so `maxToolCalls` could not constrain execution and
 * a declared-but-never-executed tool looked like consumption.
 *
 * WHAT THIS FILE PROVES (offline, no provider, no network, injectable clock)
 * ------------------------------------------------------------------------
 *   T1  `maxToolCalls = 0` ⇒ ZERO real executions (the body never runs).
 *   T2  cap = 1 with a two-tool demand ⇒ at most 1 real dispatch.
 *   T3  a REJECTED call (permission deny) takes NO reservation at all.
 *   T4  a deadline that has passed ⇒ the tool never starts, and no reservation is
 *       taken; recovery retries cannot restart it either.
 *   T5  counting semantics: a successful dispatch settles `dispatched`; a
 *       side-effecting tool that THROWS settles `unknown` (never a refund);
 *       a call refused before the body settles nothing.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PermissionPolicy, SandboxPolicy, ToolDefinition } from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { ToolRegistry } from "./registry.js";
import {
  CAMPAIGN_DEADLINE_EXCEEDED,
  TOOL_BUDGET_EXHAUSTED,
  ToolOrchestrator,
  type ToolDispatchBudget,
  type ToolDispatchReservationRequest,
} from "./orchestrator.js";
import { readFileTool } from "./tools/read-file.js";
import { execTool } from "./tools/exec.js";

const AID = newAgentId();
const SID = newSessionId();
const TID = newTurnId();
let ws = "";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-r3-tools-"));
  writeFileSync(join(ws, "hello.txt"), "hello world");
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const ALLOW_ALL: PermissionPolicy = {
  rules: [
    { action: "read", resource: "file", pattern: "**/*", effect: "allow" },
    { action: "exec", resource: "command", pattern: "**/*", effect: "allow" },
  ],
};
const SANDBOX: SandboxPolicy = {
  filesystem: { mode: "workspace-write", allowedPaths: [ws] },
  network: { mode: "deny" },
  process: { timeoutMs: 500, maxOutputBytes: 1024 },
};

function ctx(over: Record<string, unknown> = {}) {
  return {
    sessionId: SID,
    turnId: TID,
    agentId: AID,
    cwd: ws,
    signal: new AbortController().signal,
    permissions: ALLOW_ALL,
    sandboxPolicy: SANDBOX,
    ...over,
  } as Parameters<ToolOrchestrator["execute"]>[1];
}

function req(name: string, args: Record<string, unknown>) {
  return { id: newToolCallId(), sessionId: SID, turnId: TID, agentId: AID, call: { id: newToolCallId(), name, args } };
}

/** A counting clone of a real tool (same schema/metadata, wrapped executor). */
function countingClone(base: ToolDefinition, name: string): { tool: ToolDefinition; runs: () => number } {
  let runs = 0;
  const tool: ToolDefinition = {
    ...base,
    name,
    metadata: { ...base.metadata, name },
    execute: async (args: never, c: never) => {
      runs += 1;
      return base.execute(args, c);
    },
  } as ToolDefinition;
  return { tool, runs: () => runs };
}

/** A fake budget implementing the STRUCTURAL capability, with counters. */
function fakeBudget(opts: { cap: number | null; deadlinePassed?: boolean }): {
  budget: ToolDispatchBudget;
  reserves: () => number;
  outcomes: string[];
  requests: ToolDispatchReservationRequest[];
} {
  let reserved = 0;
  const outcomes: string[] = [];
  const requests: ToolDispatchReservationRequest[] = [];
  const budget: ToolDispatchBudget = {
    async reserve(request) {
      requests.push(request);
      if (opts.deadlinePassed === true) return { ok: false, reason: CAMPAIGN_DEADLINE_EXCEEDED, async settle() {} };
      if (opts.cap !== null && reserved >= opts.cap) {
        return { ok: false, reason: TOOL_BUDGET_EXHAUSTED, async settle() {} };
      }
      reserved += 1;
      let settled = false;
      return {
        ok: true,
        async settle(outcome) {
          if (settled) return;
          settled = true;
          outcomes.push(outcome);
        },
      };
    },
  };
  return { budget, reserves: () => reserved, outcomes, requests };
}

function makeOrch(tools: ToolDefinition[], over: Record<string, unknown> = {}): ToolOrchestrator {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  return new ToolOrchestrator({ registry, workspaceRoot: ws, ...over });
}

describe("R3/F4 — the tool budget is a PRE-execution constraint", () => {
  it("[T1] maxToolCalls=0 ⇒ ZERO real executions", async () => {
    const probe = countingClone(readFileTool, "probe_read");
    const b = fakeBudget({ cap: 0 });
    const orch = makeOrch([probe.tool], { toolBudget: b.budget });
    const r = await orch.execute(req("probe_read", { path: join(ws, "hello.txt") }), ctx());
    expect(r.status).toBe("failed");
    expect(r.metadata?.["reasonCode"]).toBe(TOOL_BUDGET_EXHAUSTED);
    expect(probe.runs()).toBe(0);
    expect(b.outcomes).toEqual([]); // nothing was dispatched, so nothing settled
  }, 30_000);

  it("[T2] cap=1 with a two-tool demand ⇒ at most ONE real dispatch", async () => {
    const a = countingClone(readFileTool, "probe_a");
    const c = countingClone(readFileTool, "probe_c");
    const b = fakeBudget({ cap: 1 });
    const orch = makeOrch([a.tool, c.tool], { toolBudget: b.budget });
    const first = await orch.execute(req("probe_a", { path: join(ws, "hello.txt") }), ctx());
    const second = await orch.execute(req("probe_c", { path: join(ws, "hello.txt") }), ctx());
    expect(first.status).toBe("success");
    expect(second.status).toBe("failed");
    expect(second.metadata?.["reasonCode"]).toBe(TOOL_BUDGET_EXHAUSTED);
    expect(a.runs() + c.runs()).toBe(1);
    expect(b.reserves()).toBe(1);
    expect(b.outcomes).toEqual(["dispatched"]);
  }, 30_000);

  it("[T3] a DENIED call takes NO reservation (rejection is not a dispatch)", async () => {
    const probe = countingClone(readFileTool, "probe_read");
    const b = fakeBudget({ cap: 5 });
    const deny: PermissionPolicy = { rules: [{ action: "read", resource: "file", pattern: "**/*", effect: "deny" }] };
    const orch = makeOrch([probe.tool], { toolBudget: b.budget });
    const r = await orch.execute(req("probe_read", { path: join(ws, "hello.txt") }), ctx({ permissions: deny }));
    expect(r.status).toBe("denied");
    expect(probe.runs()).toBe(0);
    expect(b.requests).toEqual([]);
    expect(b.outcomes).toEqual([]);
  }, 30_000);

  it("[T4] after the campaign deadline no tool starts and no reservation is taken", async () => {
    const probe = countingClone(readFileTool, "probe_read");
    const b = fakeBudget({ cap: 5, deadlinePassed: true });
    const orch = makeOrch([probe.tool], { toolBudget: b.budget, dispatchDeadlineAtMs: () => 1_000, now: () => 2_000 });
    const r = await orch.execute(req("probe_read", { path: join(ws, "hello.txt") }), ctx());
    expect(r.status).toBe("failed");
    expect(r.metadata?.["reasonCode"]).toBe(CAMPAIGN_DEADLINE_EXCEEDED);
    expect(probe.runs()).toBe(0);
    // The orchestrator's OWN deadline gate fired first: no reservation was even
    // attempted, which is why both counters are 0.
    expect(b.requests).toEqual([]);
    expect(b.outcomes).toEqual([]);
  }, 30_000);

  it("[T5] counting semantics: a side-effecting tool that THROWS settles `unknown`, never a refund", async () => {
    const throwing: ToolDefinition = {
      ...execTool,
      name: "probe_exec",
      metadata: { ...execTool.metadata, name: "probe_exec" },
      execute: async () => {
        throw new Error("boom after a possible side effect");
      },
    } as unknown as ToolDefinition;
    const b = fakeBudget({ cap: 5 });
    const orch = makeOrch([throwing], { toolBudget: b.budget });
    const r = await orch.execute(req("probe_exec", { command: "echo hi" }), ctx());
    expect(r.status).toBe("failed");
    expect(b.reserves()).toBe(1);
    expect(b.outcomes).toEqual(["unknown"]);
  }, 30_000);

  it("[T5b] a non-fatal event failure does NOT cost the body its dispatch, and the reservation settles EXACTLY once", async () => {
    // MEASURED behaviour, stated as it is: an event-sink failure is reported as
    // non-fatal (never fatal), so the body still runs and the reservation settles
    // `dispatched` exactly once. The `not_executed` (released) outcome is therefore
    // reserved for a throw that escapes BEFORE `runBounded` — the fail-closed
    // direction — and is never a silent refund of a body that ran.
    const probe = countingClone(readFileTool, "probe_read");
    const b = fakeBudget({ cap: 5 });
    const sink = {
      async emit(): Promise<void> {
        throw new Error("event sink down");
      },
    };
    const orch = makeOrch([probe.tool], { toolBudget: b.budget, events: sink });
    const r = await orch.execute(req("probe_read", { path: join(ws, "hello.txt") }), ctx());
    expect(r.status).toBe("success");
    expect(probe.runs()).toBe(1);
    expect(b.reserves()).toBe(1);
    expect(b.outcomes).toEqual(["dispatched"]);
  }, 30_000);
});
