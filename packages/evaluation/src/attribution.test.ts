import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ar/contracts";
import { newEventId, newSessionId } from "@ar/contracts";
import {
  attributeRegression,
  tallyEvents,
  zeroTally,
  type EventTally,
} from "./attribution.js";

const sid = newSessionId();

function ev(
  type: string,
  payload: Record<string, unknown> = {},
  over: Partial<AgentEvent> = {},
): AgentEvent {
  return {
    id: newEventId(),
    sessionId: sid,
    sequence: 0,
    timestamp: 0,
    type: type as AgentEvent["type"],
    payload,
    ...over,
  };
}

describe("tallyEvents (P2-10)", () => {
  it("zeroes every dimension on an empty stream (no fabricated sources)", () => {
    expect(tallyEvents([])).toEqual(zeroTally());
  });

  it("counts model retries, compactions, verification failures and false completes", () => {
    const events = [
      ev("model.retry"),
      ev("retry.provider"),
      ev("retry.stallRecovery"),
      ev("context.compacted", { overflow: true }),
      ev("verification.failed"),
      ev("verification.completed", { passed: false }),
      ev("turn.completed", { falseComplete: true }),
    ];
    const t = tallyEvents(events);
    expect(t.model_retries).toBe(3);
    expect(t.compactions).toBe(1);
    expect(t.verification_failures).toBe(2);
    expect(t.false_complete).toBe(1);
    // context.compacted with overflow=true also counts toward overflow.
    expect(t.context_overflow).toBe(1);
  });

  it("counts repeated tool starts as tool retries and subagent failures", () => {
    const events = [
      ev("tool.started", { toolCallId: "c1" }),
      ev("tool.started", { toolCallId: "c1" }),
      ev("tool.started", { toolCallId: "c2" }),
      ev("subagent.failed"),
    ];
    const t = tallyEvents(events);
    expect(t.tool_retries).toBe(1); // c1 started twice → one retry
    expect(t.subagent_failures).toBe(1);
  });

  it("tallies permission and security failures separately", () => {
    const events = [
      ev("security.permission_denied"),
      ev("security.approval_denied"),
      ev("approval.resolved", { decision: "deny" }),
      ev("security.network_denied"),
      ev("security.injection_denied"),
    ];
    const t = tallyEvents(events);
    expect(t.permission_failures).toBe(3); // permission + approval_denied + resolved deny
    expect(t.security_failures).toBe(4); // only security.* events (not approval.resolved)
  });

  it("counts latency and tokens from model events (P20-1: nested usage record)", () => {
    const events = [
      ev("model.completed", { durationMs: 500, usage: { inputTokens: 200, outputTokens: 100, source: "measured" } }),
      ev("model.completed", { durationMs: 700, usage: { inputTokens: 300, outputTokens: 150, source: "measured" } }),
      ev("model.completed", { durationMs: 900, usage: { source: "unknown" } }), // provider gave nothing
    ];
    const t = tallyEvents(events);
    expect(t.latency_ms).toBe(2100);
    // tokens come ONLY from measured usage records; the unknown record adds 0
    // and is never misread as a free call.
    expect(t.tokens).toBe(250);
  });

  it("counts context-overflow markers from run.limit_reached", () => {
    const events = [
      ev("run.limit_reached", { limit: "context" }),
      ev("run.limit_reached", { limit: "maxTokens" }),
      ev("run.limit_reached", { limit: "maxRetries" }), // not an overflow
    ];
    expect(tallyEvents(events).context_overflow).toBe(2);
  });
});

describe("attributeRegression (P2-10)", () => {
  function base(entries: [string, EventTally][]) {
    return entries.map(([caseId, tally]) => ({ caseId, tally }));
  }

  it("returns regressed=false and no source when the challenger is not worse", () => {
    const clean = zeroTally();
    const baseline = base([["a", { ...clean, model_retries: 2 }]]);
    const challenger = base([["a", { ...clean, model_retries: 0 }]]);

    const attr = attributeRegression(baseline, challenger);
    expect(attr.regressed).toBe(false);
    expect(attr.likelySource).toBe("");
    expect(attr.contributors).toEqual([]);
    expect(attr.affectedCases).toEqual([]);
  });

  it("names the dimension with the largest challenger-over-baseline delta", () => {
    const clean = zeroTally();
    const baseline = base([["a", { ...clean }]]);
    const challenger = base([["a", { ...clean, model_retries: 1, tokens: 2000, compactions: 3 }]]);

    const attr = attributeRegression(baseline, challenger);
    expect(attr.regressed).toBe(true);
    // Deltas are challenger - baseline; tokens delta 2000 is the largest.
    expect(attr.likelySource).toBe("tokens");
    expect(attr.contributors[0]!.delta).toBe(2000);
    expect(attr.contributors.map((c) => c.dimension)).toEqual(["tokens", "compactions", "model_retries"]);
  });

  it("sorts contributors by delta and reports affected case ids (primary dimension only)", () => {
    const clean = zeroTally();
    const baseline = base([["c1", { ...clean }], ["c2", { ...clean }]]);
    const challenger = base([
      ["c1", { ...clean, subagent_failures: 2 }],
      ["c2", { ...clean, verification_failures: 4 }],
    ]);

    const attr = attributeRegression(baseline, challenger);
    expect(attr.likelySource).toBe("verification_failures");
    expect(attr.contributors[0]!.dimension).toBe("verification_failures");
    expect(attr.contributors[0]!.delta).toBe(4);
    // affectedCases filter by the primary dimension ONLY: c1 worsened on
    // subagent_failures (a secondary contributor), not on verification.
    expect(attr.affectedCases).toEqual(["c2"]);
  });

  it("affects a case that worsened on the primary dimension alongside a secondary", () => {
    const clean = zeroTally();
    const baseline = base([["c1", { ...clean }]]);
    const challenger = base([
      ["c1", { ...clean, verification_failures: 1, subagent_failures: 2 }],
    ]);

    const attr = attributeRegression(baseline, challenger);
    expect(attr.likelySource).toBe("subagent_failures");
    expect(attr.affectedCases).toEqual(["c1"]);
    expect(attr.contributors.map((c) => c.dimension)).toEqual(["subagent_failures", "verification_failures"]);
  });

  it("affects only cases where the challenger exceeded the baseline on the primary", () => {
    const clean = zeroTally();
    const baseline = base([["ok", { ...clean, tool_retries: 1 }]]);
    const challenger = base([
      ["ok", { ...clean, tool_retries: 0 }],
      ["bad", { ...clean, tool_retries: 3 }],
    ]);

    const attr = attributeRegression(baseline, challenger);
    expect(attr.likelySource).toBe("tool_retries");
    expect(attr.affectedCases).toEqual(["bad"]);
  });
});