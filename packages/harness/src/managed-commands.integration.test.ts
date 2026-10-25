import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness, type Harness } from "./create-harness.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function create(
  enabled: boolean,
  mode: "finish" | "premature" | "cancel" = "finish",
  overrides: Record<string, unknown> = {},
  duration = 900,
) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "managed-host-")));
  const requests: ModelRequest[] = [];
  let h: Harness;
  let step = 0,
    jobId = "",
    state = "",
    pollToken = 0;
  const authority = new AbortController();
  await writeFile(join(cwd, "source"), "RELATED");
  const code =
    "const fs=require('node:fs');fs.appendFileSync('starts','1');fs.writeFileSync('started','1');setTimeout(()=>{fs.writeFileSync('complete','1');console.log('CHECK_OK')}," +
    duration +
    ")";
  const provider: ModelProvider = {
    id: "managed-host-offline",
    listModels: async () => [
      { id: "scripted", capabilities: { contextWindowTokens: 128000 } },
    ],
    createClient: () => ({
      async *generate(request) {
        requests.push(structuredClone(request));
        step++;
        // Consume only actual model-facing tool messages; event previews are
        // intentionally withheld by the production output security boundary.
        for (const message of request.messages.filter(
          (m) => m.role === "tool",
        )) {
          jobId =
            [...message.content.matchAll(/"jobId"\s*:\s*"([^"]+)"/g)].at(
              -1,
            )?.[1] ?? jobId;
          pollToken = Number(
            [...message.content.matchAll(/"pollToken"\s*:\s*(\d+)/g)].at(
              -1,
            )?.[1] ?? pollToken,
          );
          state =
            [...message.content.matchAll(/"state"\s*:\s*"([^"]+)"/g)].at(
              -1,
            )?.[1] ?? state;
        }
        if (step === 1)
          yield* ScriptedModelProvider.toolCall(
            enabled ? "exec_start" : "exec",
            {
              command: process.execPath,
              args: ["-e", code],
              ...(enabled ? { yieldMs: 0 } : {}),
            },
          );
        else if (mode === "cancel") {
          authority.abort();
          yield* ScriptedModelProvider.text("Cancelled.");
        } else if (step === 2)
          yield* ScriptedModelProvider.toolCall("read_file", {
            path: "source",
          });
        else if (enabled && mode === "finish" && state !== "succeeded")
          yield* ScriptedModelProvider.toolCall("exec_poll", {
            jobId,
            pollToken,
            waitMs: 1000,
          });
        else yield* ScriptedModelProvider.text("Checks complete.");
      },
    }),
  };
  h = await createHarness({
    cwd,
    dataDir: join(cwd, "state"),
    profile: "test",
    modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted" },
    featureFlags: {
      skills: false,
      delegation: false,
      mcp: false,
      memory: false,
    },
    limits: { maxDurationMs: 10000, maxToolCalls: 15 },
    task: {
      id: "managed-check",
      goal: "Run check and read related source",
      completionPolicy: { requiresVerification: true },
      verification: [
        {
          kind: "command",
          command: process.execPath,
          args: [
            "-e",
            "if(require('node:fs').readFileSync('complete','utf8')!=='1')process.exit(1)",
          ],
        },
      ],
    },
    ...(enabled ? { managedCommands: { enabled: true, maxJobMs: 5000 } } : {}),
    ...overrides,
  });
  const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
  const turn = await h.runtime.startTurn(
    session.id,
    "Run the long project check and inspect the source.",
  );
  return {
    h,
    cwd,
    requests,
    authority,
    session,
    turn,
    run: () => h.runtime.runTurn(session.id, turn.id, authority.signal),
    close: async () => {
      await h.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
it("default-off leaves the old tool list, prompt and blocking execution unchanged", async () => {
  const f = await create(false);
  try {
    expect(f.h.managedCommands).toBeUndefined();
    expect(f.h.registry.has("exec_start")).toBe(false);
    expect(f.h.agents[0]!.systemPrompt).not.toContain("Managed commands:");
    expect((await f.run()).status).toBe("completed");
    expect(await readFile(join(f.cwd, "starts"), "utf8")).toBe("1");
  } finally {
    await f.close();
  }
});
it("real production runtime performs start -> read -> poll -> original command verification", async () => {
  const f = await create(true);
  try {
    expect(f.h.agents[0]!.tools.allow).toContain("exec_poll");
    expect(f.h.agents[0]!.systemPrompt).toContain("not completion");
    const result = await f.run();
    expect(result.status).toBe("completed");
    expect(await readFile(join(f.cwd, "starts"), "utf8")).toBe("1");
    const events = await f.h.events.list(f.session.id);
    expect(
      events.some(
        (e) =>
          e.type === "verification.step_completed" && e.payload.passed === true,
      ),
    ).toBe(true);
    expect(
      f.requests.some((r) =>
        r.messages.some(
          (m) => m.role === "tool" && m.content.includes("CHECK_OK"),
        ),
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        await readFile(join(f.cwd, "state/managed-commands-v1.json"), "utf8"),
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
it("a premature model completion cannot verify an active command and the finite budget stays final", async () => {
  const f = await create(true, "premature", {
    limits: { maxDurationMs: 10000, maxToolCalls: 15 },
    maxIterationsPerTurn: 4,
  });
  try {
    const result = await f.run();
    expect(result.status).not.toBe("completed");
    const events = await f.h.events.list(f.session.id);
    expect(
      events.some(
        (e) => e.type === "tool.started" && e.payload.tool === "exec",
      ),
    ).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === "turn.completed" &&
          e.payload.completionStatus === "verified_complete",
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
it("owner cancellation after a returned start cleans up before the turn acknowledgement", async () => {
  const f = await create(true, "cancel");
  try {
    expect((await f.run()).status).toBe("cancelled");
    await delay(1000);
    expect(await readFile(join(f.cwd, "complete")).catch(() => null)).toBe(
      null,
    );
  } finally {
    await f.close();
  }
});
it("refuses enabling without trusted finite deadline and real task verification", async () => {
  for (const overrides of [
    { task: undefined },
    { limits: undefined },
    { limits: { maxDurationMs: Infinity } },
    {
      task: {
        id: "fake",
        goal: "fake",
        verification: [{ kind: "requirement", statement: "trust me" }],
      },
    },
  ]) {
    await expect(create(true, "finish", overrides)).rejects.toThrow(
      /managed commands require/,
    );
  }
});

it("quiet long command polls advance real observation tokens without triggering identical-call recovery", async () => {
  const f = await create(true, "finish", {}, 3700);
  try {
    expect((await f.run()).status).toBe("completed");
    const polls = f.requests
      .flatMap((r) => r.messages)
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.toolCalls ?? [])
      .filter((c) => c.name === "exec_poll");
    expect(
      new Set(polls.map((c) => c.args.pollToken)).size,
    ).toBeGreaterThanOrEqual(4);
  } finally {
    await f.close();
  }
});
