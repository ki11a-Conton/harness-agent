/**
 * R3-binding — the PRODUCTION harness composition root really supplies the
 * pre-dispatch tool budget and the single campaign deadline.
 * plan(20260928-105425).md §R3 (F4); Runtime Freeze P38.4-11 clause 2.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * R3 landed the seam (`ToolOrchestrator.toolBudget` / `dispatchDeadlineAtMs`) but
 * nothing in production supplied it, so `maxToolCalls` and the campaign deadline
 * were a seam rather than an enforced constraint. A unit test on the seam alone
 * cannot detect that (it passes whether or not production binds it). This test
 * therefore builds a REAL harness through `createHarness` and drives the
 * harness's OWN orchestrator instance:
 *
 *   B1  past `maxToolCalls` the dispatch is REFUSED (the tool body never runs);
 *   B2  the campaign deadline reaches the orchestrator: with the deadline in the
 *       past the tool never starts and NO reservation is even attempted;
 *   B3  negative control: without the binding the same tool runs normally, so the
 *       refusals above come from the binding rather than a blanket failure.
 *
 * OFFLINE: in-process harness, fake model provider, temp workspace; no provider,
 * no network, no cost.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider, ModelRef, PermissionPolicy, SandboxPolicy } from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import type { ToolDispatchBudget } from "@ar/tools";
import { createHarness } from "./create-harness.js";
import type { HarnessConfig } from "./config.js";

const CAMPAIGN_DEADLINE_EXCEEDED = "CAMPAIGN_DEADLINE_EXCEEDED";
const TOOL_BUDGET_EXHAUSTED = "TOOL_BUDGET_EXHAUSTED";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-r3-binding-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)),
  );
  tempDirs = [];
}, 20_000);

function fakeProvider(): { provider: ModelProvider; model: ModelRef } {
  const model: ModelRef = { providerId: "fake", modelId: "test-model" };
  const provider: ModelProvider = {
    id: "fake",
    listModels: async () => [{ id: "test-model", name: "Test Model", capabilities: { contextWindowTokens: 128_000 } }],
    createClient: () => {
      throw new Error("fake provider never streams");
    },
  };
  return { provider, model };
}

/** A TEST budget implementing the real structural capability (harness must not
 *  depend on @ar/evaluation, so the durable impl cannot be imported here). */
function countingBudget(cap: number): { budget: ToolDispatchBudget; reserves: number[]; outcomes: string[] } {
  const reserves: number[] = [];
  const outcomes: string[] = [];
  let held = 0;
  const budget: ToolDispatchBudget = {
    async reserve() {
      reserves.push(held);
      if (held >= cap) return { ok: false, reason: TOOL_BUDGET_EXHAUSTED, async settle() {} };
      held += 1;
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
  return { budget, reserves, outcomes };
}

async function buildHarness(cwd: string, over: Partial<HarnessConfig>): Promise<Awaited<ReturnType<typeof createHarness>>> {
  const { provider, model } = fakeProvider();
  return createHarness({ cwd, profile: "test", modelProvider: provider, model, ...over });
}

const ALLOW_READ: PermissionPolicy = { rules: [{ action: "read", resource: "file", pattern: "**/*", effect: "allow" }] };

function toolRequest(sessionId: string, cwd: string) {
  return {
    id: newToolCallId(),
    sessionId: sessionId as never,
    turnId: newTurnId(),
    agentId: newAgentId(),
    call: { id: newToolCallId(), name: "read_file", args: { path: join(cwd, "hello.txt") } },
  };
}

function contextFor(sessionId: string, cwd: string, sandbox: SandboxPolicy) {
  return {
    sessionId: sessionId as never,
    turnId: newTurnId(),
    agentId: newAgentId(),
    cwd,
    signal: new AbortController().signal,
    permissions: ALLOW_READ,
    sandboxPolicy: sandbox,
  } as Parameters<Awaited<ReturnType<typeof createHarness>>["orchestrator"]["execute"]>[1];
}

describe("R3-binding — createHarness supplies the tool budget and the campaign deadline", () => {
  it("[B1] a production harness REFUSES a tool dispatch past maxToolCalls (the body never runs)", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "hello.txt"), "hello world", "utf8");
    const sandbox: SandboxPolicy = {
      filesystem: { mode: "workspace-write", allowedPaths: [dir] },
      network: { mode: "deny" },
      process: { timeoutMs: 500, maxOutputBytes: 1024 },
    };
    const b = countingBudget(1); // the campaign cap: exactly ONE dispatch
    const harness = await buildHarness(dir, { toolDispatchBudget: b.budget });
    const sessionId = String(newSessionId());
    await harness.store.createSession({
      id: sessionId as never,
      agentId: harness.agents[0]!.id,
      model: harness.config.model,
      cwd: dir,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const first = await harness.orchestrator.execute(toolRequest(sessionId, dir), contextFor(sessionId, dir, sandbox));
    expect(first.status, JSON.stringify(first.error ?? {})).toBe("success");
    const second = await harness.orchestrator.execute(toolRequest(sessionId, dir), contextFor(sessionId, dir, sandbox));
    // The cap is enforced at the composition root's orchestrator, BEFORE the body.
    expect(second.status).toBe("failed");
    expect(second.metadata?.["reasonCode"]).toBe(TOOL_BUDGET_EXHAUSTED);
    expect(b.reserves.length).toBe(2);
    expect(b.outcomes).toEqual(["dispatched"]);
  }, 60_000);

  it("[B2] the campaign deadline reaches the harness orchestrator: no tool starts after it", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "hello.txt"), "hello world", "utf8");
    const sandbox: SandboxPolicy = {
      filesystem: { mode: "workspace-write", allowedPaths: [dir] },
      network: { mode: "deny" },
      process: { timeoutMs: 500, maxOutputBytes: 1024 },
    };
    const b = countingBudget(5);
    // A deadline in the PAST: the harness must forward it and refuse to start.
    const harness = await buildHarness(dir, {
      toolDispatchBudget: b.budget,
      campaignDeadlineAtMs: Date.now() - 1_000,
    });
    const sessionId = String(newSessionId());
    await harness.store.createSession({
      id: sessionId as never,
      agentId: harness.agents[0]!.id,
      model: harness.config.model,
      cwd: dir,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const r = await harness.orchestrator.execute(toolRequest(sessionId, dir), contextFor(sessionId, dir, sandbox));
    expect(r.status).toBe("failed");
    expect(r.metadata?.["reasonCode"]).toBe(CAMPAIGN_DEADLINE_EXCEEDED);
    // The deadline gate fires BEFORE the reservation: nothing was even attempted.
    expect(b.reserves).toEqual([]);
  }, 60_000);

  it("[B3] negative control: WITHOUT the binding the same tool runs normally", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "hello.txt"), "hello world", "utf8");
    const sandbox: SandboxPolicy = {
      filesystem: { mode: "workspace-write", allowedPaths: [dir] },
      network: { mode: "deny" },
      process: { timeoutMs: 500, maxOutputBytes: 1024 },
    };
    const harness = await buildHarness(dir, {});
    const sessionId = String(newSessionId());
    await harness.store.createSession({
      id: sessionId as never,
      agentId: harness.agents[0]!.id,
      model: harness.config.model,
      cwd: dir,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const r = await harness.orchestrator.execute(toolRequest(sessionId, dir), contextFor(sessionId, dir, sandbox));
    expect(r.status, JSON.stringify(r.error ?? {})).toBe("success");
  }, 60_000);
});
