import { promises as fs } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { ModelProvider, ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

it.each(["interactive", "test"] as const)("%s: turn cancellation stops source indexing and the next turn restarts cleanly", async profile => {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "harness-nav-cancel-")));
  const authority = new AbortController(), requests: ModelRequest[] = [];
  let sourceReads = 0;
  for (let i = 0; i < 12; i++) await fs.writeFile(join(cwd, `source-${String(i).padStart(2, "0")}.ts`), `export const SharedSymbol = ${i};\n`);
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args);
    if (/^source-\d+\.ts$/.test(basename(String(args[0])))) {
      let counted = false;
      handle.read = new Proxy(handle.read, { apply(target, _thisArg, readArgs) {
        return Reflect.apply(target, handle, readArgs).then((result: { bytesRead: number }) => {
          if (!counted && result.bytesRead > 0) {
            counted = true; sourceReads++;
            if (sourceReads === 1) authority.abort();
          }
          return result;
        });
      } });
    }
    return handle;
  });
  const provider: ModelProvider = {
    id: "navigation-cancellation-offline",
    listModels: async () => [{ id: "scripted", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      requests.push(structuredClone(request));
      yield* requests.length <= 2
        ? ScriptedModelProvider.toolCall("symbol_search", { symbol: "SharedSymbol" })
        : ScriptedModelProvider.text("Located the actual declarations in the selected workspace.");
    } }),
  };
  let h: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    h = await createHarness({ cwd, dataDir: join(cwd, "state"), profile, modelProvider: provider,
      model: { providerId: provider.id, modelId: "scripted" },
      featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false },
    });
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "Locate SharedSymbol in this project.");
    const cancelled = await h.runtime.runTurn(session.id, turn.id, authority.signal);
    expect(cancelled.status).toBe("cancelled");
    await yieldToEventLoop();
    expect(requests).toHaveLength(1); expect(sourceReads).toBe(1);

    const next = await h.runtime.startTurn(session.id, "Continue locating SharedSymbol after my stop.");
    const resumed = await h.runtime.runTurn(session.id, next.id, new AbortController().signal);
    expect(resumed.status).toBe("completed");
    expect(requests).toHaveLength(3); expect(sourceReads).toBe(13);
    const actualToolMessages = requests[2]!.messages.filter(message => message.role === "tool").map(message => message.content).join("\n");
    expect(actualToolMessages).toContain("source-11.ts");
    expect(actualToolMessages).toContain("SharedSymbol");
  } finally {
    await h?.close(); vi.mocked(open).mockReset().mockImplementation(actualFs.open);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
