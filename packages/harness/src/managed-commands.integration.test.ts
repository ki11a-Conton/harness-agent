import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness, type Harness } from "./create-harness.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function heldCommand() {
  const responses = new Set<ServerResponse>();
  let connected!: () => void;
  const connection = new Promise<void>((resolve) => {
    connected = resolve;
  });
  let released = false;
  const server = createServer((_request, response) => {
    responses.add(response);
    connected();
    response.once("close", () => responses.delete(response));
    if (released) response.end("release");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hold`;
  return {
    code: `const fs=require('node:fs');fs.appendFileSync('starts','1');fs.writeFileSync('started','1');require('node:http').get(${JSON.stringify(url)},response=>{response.resume();response.on('end',()=>{fs.writeFileSync('complete','1');console.log('CHECK_OK')})}).on('error',error=>{console.error(error);process.exitCode=1});`,
    release: () => {
      released = true;
      for (const response of responses) response.end("release");
    },
    waitUntilConnected: (deadlineAt: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Held command did not connect within the original turn budget")),
          Math.max(0, deadlineAt - Date.now()),
        );
        void connection.then(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
    connectedNow: () => responses.size > 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
async function create(
  enabled: boolean,
  mode: "finish" | "premature" | "cancel" = "finish",
  overrides: Record<string, unknown> = {},
  duration = 900,
  controlled?: {
    code: string;
    observe?: (token: number) => void;
    ready?: (deadlineAt: number) => Promise<void>;
    pollWaitMs?: (token: number) => number;
  },
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
    controlled?.code ??
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
        if (step === 2 && state === "running" && controlled?.ready !== undefined)
          await controlled.ready(
            turn.startedAt + (h.config.limits?.maxDurationMs ?? 10000),
          );
        controlled?.observe?.(pollToken);
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
            waitMs: controlled?.pollWaitMs?.(pollToken) ?? 1000,
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
    ...(controlled
      ? {
          sandboxPolicy: {
            filesystem: {
              mode: "workspace-write" as const,
              allowedPaths: [cwd],
            },
            network: { mode: "allowlist" as const, hosts: ["127.0.0.1"] },
            process: { timeoutMs: 10000, maxOutputBytes: 65536 },
          },
        }
      : {}),
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
  const controlled = await heldCommand();
  let f: Awaited<ReturnType<typeof create>> | undefined;
  try {
    f = await create(
      true,
      "premature",
      {
        limits: { maxDurationMs: 10000, maxToolCalls: 15 },
        maxIterationsPerTurn: 4,
      },
      900,
      controlled,
    );
    const result = await f.run();
    expect(result.status).not.toBe("completed");
    expect(result.grade).not.toBe("verified_complete");
    expect(await f.h.store.listTurns(f.session.id)).toHaveLength(1);
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
          e.payload.grade === "verified_complete",
      ),
    ).toBe(false);
  } finally {
    try {
      await f?.close();
    } finally {
      await controlled.close();
    }
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
  const controlled = await heldCommand();
  const liveObservations = new Map<number, boolean>();
  let f: Awaited<ReturnType<typeof create>> | undefined;
  try {
    f = await create(
      true,
      "finish",
      { managedCommands: { enabled: true, maxJobMs: 8000 } },
      900,
      {
        ...controlled,
        // First prove the actual child is connected and quiet, then collect
        // four nonblocking observations. Four artificial one-second waits
        // consume the original 10s turn on a busy native Windows runner.
        ready: controlled.waitUntilConnected,
        pollWaitMs: (token) => (token < 4 ? 0 : 1000),
        // Four actual observations, independent of machine speed or sleep timing.
        observe: (token) => {
          if (token > 0 && token <= 4)
            liveObservations.set(token, controlled.connectedNow());
          if (token >= 4) controlled.release();
        },
      },
    );
    const outcome = await f.run();
    expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    expect(liveObservations.size).toBe(4);
    expect([...liveObservations.values()].every(Boolean)).toBe(true);
    expect(await readFile(join(f.cwd, "starts"), "utf8")).toBe("1");
    const polls = f.requests
      .flatMap((r) => r.messages)
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.toolCalls ?? [])
      .filter((c) => c.name === "exec_poll");
    expect(
      new Set(polls.map((c) => c.args.pollToken)).size,
    ).toBeGreaterThanOrEqual(4);
  } finally {
    try {
      await f?.close();
    } finally {
      await controlled.close();
    }
  }
});
