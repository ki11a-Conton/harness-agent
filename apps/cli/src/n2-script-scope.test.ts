/**
 * N2 (F30-3) — THE SCRIPTED PROVIDER'S CURSOR BELONGS TO THE CONVERSATION.
 *
 * THE MEASURED DEFECT
 * -------------------
 * `createOfflineScriptedProvider` kept `let turn = 0` in the PROVIDER INSTANCE.
 * The release driver builds ONE provider for a whole campaign and calls
 * `provider.createClient(...)` for EVERY model request (see
 * `serviceModelRequest` in `prereg-arm-executor.ts`), so two arm-runs shared one
 * cursor: the baseline consumed turns 0/1 and the candidate started at turn 2 —
 * past its "write the file" step — and then ran off the end of the 3-turn table.
 * A resume or a repetition inherited whatever the previous arm had eaten.
 *
 * HOW THE DEFECT IS DRIVEN HERE (old behaviour vs new)
 * ---------------------------------------------------
 * These tests reproduce the DRIVER'S protocol exactly: a FRESH client per model
 * request, with the request carrying the transcript the runtime would send. The
 * old implementation cannot pass them — its cursor is global, so the second
 * conversation starts mid-table. The tests below therefore FAIL on the old code
 * and pass on the new one, and they do so through the same call shape the
 * production driver uses.
 *
 * WHAT IS *NOT* CLAIMED HERE
 * --------------------------
 * This file does not run the runtime, the tool orchestrator or the verifier. The
 * end-to-end release-entry proof (runtime → real tool dispatch → frozen verifier)
 * lives in `n2-release-cli-forward.test.ts`. What this file pins is the SCRIPT's
 * scope: which table entry a given request resolves to.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelEvent, ModelRequest } from "@ar/contracts";
import {
  OFFLINE_CONTENT_SCRIPT_TURNS,
  OFFLINE_CONTENT_TASK,
  OFFLINE_MODEL_ID,
  OFFLINE_PROVIDER_ID,
  OFFLINE_SCRIPT_EXHAUSTED_CODE,
  createOfflineScriptedProvider,
} from "./provider.js";

const REPO_ROOT = process.cwd();
const CASE_DIR = join(REPO_ROOT, "benchmarks", OFFLINE_CONTENT_TASK.suite, OFFLINE_CONTENT_TASK.caseId);

/** Fully consume a stream so every yielded event is observed. */
async function drain(iter: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/**
 * The transcript the runtime sends: real `Message`s with a real session id, so
 * the provider can tell WHICH conversation a request belongs to — which is the
 * whole point of the fix.
 */
interface Turn {
  role: "user" | "assistant" | "tool";
  text: string;
}

function request(sessionId: string, turns: readonly Turn[]): ModelRequest {
  return {
    messages: turns.map((t, i) => ({
      id: `${sessionId}-m${i}`,
      sessionId,
      role: t.role,
      content: t.text,
      createdAt: 0,
    })),
  } as unknown as ModelRequest;
}

/**
 * Drive ONE conversation the way the DRIVER does: a NEW client per model
 * request, growing the transcript with the assistant/tool messages the runtime
 * would have appended. Returns the per-call classification.
 */
async function runConversation(
  provider: ReturnType<typeof createOfflineScriptedProvider>,
  sessionId: string,
): Promise<{ writes: number; terminals: number; exhausted: number; calls: number }> {
  const turns: Turn[] = [{ role: "user", text: "fix parse_csv" }];
  let writes = 0;
  let terminals = 0;
  let exhausted = 0;
  let calls = 0;
  for (let i = 0; i < OFFLINE_CONTENT_SCRIPT_TURNS + 1; i += 1) {
    const client = provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});
    const events = await drain(client.generate(request(sessionId, turns), new AbortController().signal));
    calls += 1;
    if (events.some((e) => e.type === "error" && e.error.message.startsWith(OFFLINE_SCRIPT_EXHAUSTED_CODE))) {
      exhausted += 1;
      break;
    }
    if (events.some((e) => e.type === "tool_call_delta")) {
      writes += 1;
      turns.push({ role: "assistant", text: "writing" }, { role: "tool", text: "ok" });
      continue;
    }
    terminals += 1;
    turns.push({ role: "assistant", text: "done" });
    break;
  }
  return { writes, terminals, exhausted, calls };
}

const dirs: string[] = [];
function scratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `n2-script-${tag}-`));
  dirs.push(d);
  return d;
}

/**
 * The case's OWN committed verifier step, read from `case.json`.
 *
 * Asserted to exist rather than non-null-asserted index access: a case that
 * stopped declaring a `command` verification would otherwise make these tests
 * silently weaker instead of red.
 */
function verifierStepOfCase(): { kind: string; command: string; args: string[] } {
  const caseJson = JSON.parse(readFileSync(join(CASE_DIR, "case.json"), "utf8")) as {
    verification?: { kind?: unknown; command?: unknown; args?: unknown }[];
  };
  const step = caseJson.verification?.[0];
  if (step === undefined) throw new Error(`${OFFLINE_CONTENT_TASK.caseId} declares no verification step`);
  if (typeof step.command !== "string" || !Array.isArray(step.args)) {
    throw new Error(`${OFFLINE_CONTENT_TASK.caseId}'s verification step has no command/args`);
  }
  return { kind: String(step.kind), command: step.command, args: step.args.map((a) => String(a)) };
}

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("N2/F30-3 — two arms on ONE provider instance never share a script cursor", () => {
  it("baseline and candidate EACH start at the script's first step and both complete", async () => {
    const provider = createOfflineScriptedProvider();
    // ONE provider, as the campaign driver builds it.
    const baseline = await runConversation(provider, "session-baseline");
    const candidate = await runConversation(provider, "session-candidate");

    // OLD BEHAVIOUR: candidate.writes === 0 (it began at turn 2 and ran off the
    // table). NEW BEHAVIOUR: each conversation performs the write exactly once.
    expect(baseline.writes).toBe(1);
    expect(candidate.writes).toBe(1);
    expect(baseline.terminals).toBe(1);
    expect(candidate.terminals).toBe(1);
    // No arm ran out of script — the cross-arm exhaustion is gone.
    expect(baseline.exhausted).toBe(0);
    expect(candidate.exhausted).toBe(0);
  });

  it("the candidate is independent of the ARM ORDER (candidate first, then baseline)", async () => {
    const provider = createOfflineScriptedProvider();
    const candidate = await runConversation(provider, "session-candidate");
    const baseline = await runConversation(provider, "session-baseline");
    expect(candidate.writes).toBe(1);
    expect(baseline.writes).toBe(1);
    expect(candidate.exhausted).toBe(0);
    expect(baseline.exhausted).toBe(0);
  });

  it("INTERLEAVED requests from two conversations keep their own positions", async () => {
    const provider = createOfflineScriptedProvider();
    const a = request("session-a", [{ role: "user", text: "goal" }]);
    const b = request("session-b", [{ role: "user", text: "goal" }]);
    const aDone = request("session-a", [
      { role: "user", text: "goal" },
      { role: "assistant", text: "writing" },
      { role: "tool", text: "ok" },
    ]);
    const bDone = request("session-b", [
      { role: "user", text: "goal" },
      { role: "assistant", text: "writing" },
      { role: "tool", text: "ok" },
    ]);
    const client = () => provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});
    const seen: string[] = [];
    for (const req of [a, b, aDone, bDone]) {
      const events = await drain(client().generate(req, new AbortController().signal));
      seen.push(events.some((e) => e.type === "tool_call_delta") ? "write" : "terminal");
    }
    // A-B-A-B interleaving: each conversation advances only on its OWN requests.
    expect(seen).toEqual(["write", "write", "terminal", "terminal"]);
  });

  it("several repetitions of the same case are independent (4 conversations, 4 initial states)", async () => {
    const provider = createOfflineScriptedProvider();
    const results = [];
    for (let rep = 0; rep < 4; rep += 1) results.push(await runConversation(provider, `session-rep-${rep}`));
    expect(results.map((r) => r.writes)).toEqual([1, 1, 1, 1]);
    expect(results.map((r) => r.exhausted)).toEqual([0, 0, 0, 0]);
  });
});

describe("N2/F30-3 — a retry re-sends the same transcript, so it resolves to the same step", () => {
  it("replaying the IDENTICAL request does not advance the script", async () => {
    const turns = (prev: number) =>
      request("session-retry", [
        { role: "user", text: "goal" },
        ...Array.from({ length: prev }, () => [{ role: "assistant" as const, text: "a" }, { role: "tool" as const, text: "t" }]).flat(),
      ]);
    const provider = createOfflineScriptedProvider();
    const client = () => provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});

    const first = await drain(client().generate(turns(0), new AbortController().signal));
    // The FIRST attempt failed after the request was sent (simulated by asking
    // again with the very same transcript) — a retry must not skip a step.
    const retried = await drain(client().generate(turns(0), new AbortController().signal));

    const classify = (events: readonly ModelEvent[]): string =>
      events.some((e) => e.type === "tool_call_delta") ? "write" : "terminal";
    expect(classify(first)).toBe("write");
    expect(classify(retried)).toBe("write");

    // ...and the conversation still continues correctly afterwards.
    const after = await drain(client().generate(turns(1), new AbortController().signal));
    expect(classify(after)).toBe("terminal");
  });
});

describe("N2/F30-3 — the table stays BOUNDED (exhaustion is still explicit)", () => {
  it("a conversation past the table reports OFFLINE_SCRIPT_EXHAUSTED — no fabricated terminal text", async () => {
    const provider = createOfflineScriptedProvider();
    const exhaustedAt: number[] = [];
    const observedProvider = createOfflineScriptedProvider({ onExhausted: (i) => exhaustedAt.push(i) });
    void provider;

    const fullTranscript = request("session-long", [
      { role: "user", text: "goal" },
      ...Array.from({ length: OFFLINE_CONTENT_SCRIPT_TURNS }, () => [
        { role: "assistant" as const, text: "a" },
        { role: "tool" as const, text: "t" },
      ]).flat(),
    ]);
    const events = await drain(
      observedProvider
        .createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {})
        .generate(fullTranscript, new AbortController().signal),
    );
    const err = events.find((e) => e.type === "error");
    expect(err, "past the table the script MUST refuse, not improvise").toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
    expect((err as { error: { message: string } }).error.message.startsWith(OFFLINE_SCRIPT_EXHAUSTED_CODE)).toBe(true);
    // It never fabricates the terminal answer that would look like a completion.
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(exhaustedAt).toEqual([OFFLINE_CONTENT_SCRIPT_TURNS]);
  });

  it("identity-less requests keep the historical sequential table order", async () => {
    // The pinned Phase B contract: a caller that drives the provider directly
    // with NO conversation identity still sees the table advance one step per
    // request. This is the ONE preserved behaviour; it is asserted separately so
    // the conversation-scoped rule above cannot silently change it.
    const provider = createOfflineScriptedProvider();
    const client = provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});
    const seen: string[] = [];
    for (let i = 0; i < OFFLINE_CONTENT_SCRIPT_TURNS + 3; i += 1) {
      const events = await drain(client.generate({ messages: [] } as unknown as ModelRequest, new AbortController().signal));
      seen.push(
        events.some(
          (e) => e.type === "error" && e.error.message.startsWith(OFFLINE_SCRIPT_EXHAUSTED_CODE),
        )
          ? "exhausted"
          : "scripted",
      );
    }
    expect(seen).toEqual(["scripted", "scripted", "scripted", "exhausted", "exhausted", "exhausted"]);
  });
});

// ===========================================================================
// The task the script writes must satisfy a REAL frozen verifier
// ===========================================================================
describe("N2/F30-4 — the scripted content task targets a real, non-holdout frozen case", () => {
  it("the target case is in the COMMITTED frozen selection and is not a holdout case", () => {
    const selection = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs", "evidence", "tool-call-efficiency-case-selection.json"), "utf8"),
    ) as { cases: { caseId: string; suite: string }[] };
    const entry = selection.cases.find((c) => c.caseId === OFFLINE_CONTENT_TASK.caseId);
    expect(entry, "the scripted task must serve a case the frozen selection actually contains").toBeDefined();
    expect(entry?.suite).toBe(OFFLINE_CONTENT_TASK.suite);
    expect(OFFLINE_CONTENT_TASK.suite).not.toBe("holdout");
  });

  it("the script's bytes PASS the case's own committed verifier command", () => {
    const step = verifierStepOfCase();
    expect(step.kind).toBe("command");

    const workspace = scratch("verifier");
    const abs = join(workspace, ...OFFLINE_CONTENT_TASK.outputPath.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, OFFLINE_CONTENT_TASK.content, "utf8");

    const run = spawnSync(step.command, step.args, { cwd: workspace, encoding: "utf8" });
    expect(run.status, `the frozen verifier rejected the scripted content: ${run.stdout}${run.stderr}`).toBe(0);
  });

  it("the ONE-dimension-wrong control really FAILS the same verifier (the negative is not vacuous)", () => {
    const step = verifierStepOfCase();
    const workspace = scratch("verifier-wrong");
    const abs = join(workspace, ...OFFLINE_CONTENT_TASK.outputPath.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, OFFLINE_CONTENT_TASK.wrongContent, "utf8");

    const run = spawnSync(step.command, step.args, { cwd: workspace, encoding: "utf8" });
    expect(run.status, "the wrong-content control must be distinguishable by the verifier").not.toBe(0);
  });
});
