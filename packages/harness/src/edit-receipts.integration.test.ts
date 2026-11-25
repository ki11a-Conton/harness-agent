import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

it("a coding turn recovers from no-op feedback and chains actual edit versions with one read", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "edit-receipt-runtime-")));
  const before = "exports.first = 1;\r\nexports.second = 2;\n"; const requests: ModelRequest[] = []; let version = "";
  await writeFile(join(cwd, "values.cjs"), before);
  await writeFile(join(cwd, "check.cjs"), "require('node:assert/strict').deepEqual(require('./values.cjs'),{first:10,second:20});console.log('EDIT_RECEIPTS_CHECK_PASSED');\n");
  const provider: ModelProvider = { id: "edit-receipt-replay", listModels: async () => [{ id: "offline", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      requests.push(structuredClone(request)); const last = request.messages.filter(m => m.role === "tool").at(-1)?.content ?? "";
      if (requests.length === 1) yield* ScriptedModelProvider.toolCall("read_file", { path: "values.cjs", versioned: true });
      else if (requests.length === 2) {
        version = /"sha256"\s*:\s*"([a-f0-9]{64})"/.exec(last)![1]!;
        yield* ScriptedModelProvider.toolCall("edit_file", { path: "values.cjs", expectedSha256: version, oldText: "first = 1", newText: "first = 1" });
      } else if (requests.length === 3) {
        expect(last).toContain("[failed]"); expect(last).toMatch(/no change|identical/i); expect(await readFile(join(cwd, "values.cjs"), "utf8")).toBe(before);
        yield* ScriptedModelProvider.toolCall("edit_file", { path: "values.cjs", expectedSha256: version, oldText: "first = 1", newText: "first = 10" });
      } else if (requests.length === 4) {
        const next = /"sha256"\s*:\s*"([a-f0-9]{64})"/.exec(last); expect(next).not.toBeNull();
        expect(next![1]).not.toBe(version); version = next![1]!;
        yield* ScriptedModelProvider.toolCall("edit_file", { path: "values.cjs", expectedSha256: version, oldText: "second = 2", newText: "second = 20" });
      } else if (requests.length === 5) {
        const actual = createHash("sha256").update(await readFile(join(cwd, "values.cjs"))).digest("hex"); expect(last).toContain(actual);
        yield* ScriptedModelProvider.toolCall("exec", { command: process.execPath, args: ["check.cjs"] });
      } else {
        expect(requests).toHaveLength(6); expect(last).toContain("EDIT_RECEIPTS_CHECK_PASSED");
        yield* ScriptedModelProvider.text("Applied the two edits and verified the actual file.");
      }
    } }),
  };
  const h = await createHarness({ cwd, dataDir: join(cwd, "state"), profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "offline" }, limits: { maxDurationMs: 30000, maxToolCalls: 15 },
    featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [cwd] }, network: { mode: "deny" }, process: { timeoutMs: 10000 } },
    task: { id: "edit-receipts", goal: "Apply and verify both values", completionPolicy: { requiresVerification: true },
      verification: [{ kind: "command", command: process.execPath, args: ["check.cjs"] }] },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd }); const turn = await h.runtime.startTurn(session.id, "Fix and verify the two values.");
    const result = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.status).toBe("completed"); expect(result.grade).toBe("verified_complete"); expect(requests).toHaveLength(6);
    expect(await readFile(join(cwd, "values.cjs"), "utf8")).toBe("exports.first = 10;\r\nexports.second = 20;\n");
    const events = await h.events.list(session.id); expect(events.filter(e => e.type === "tool.started" && e.payload.tool === "read_file")).toHaveLength(1);
    expect(events.some(e => e.type === "tool.completed" && e.payload.status === "failed")).toBe(true);
    expect(events.some(e => e.type === "verification.completed")).toBe(true);
  } finally { await h.close(); await rm(cwd, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 8 : 0, retryDelay: 50 }); }
}, 30000);

it.each([
  { reason: "ambiguous anchor", anchor: " = 1;" },
  { reason: "indentation mismatch", anchor: "    exports.secondary = 1;" },
])("recovers from a strict edit's $reason using the model-visible location and real verification", async ({ reason, anchor }) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "edit-disambiguation-")));
  const path = join(cwd, "defaults.cjs");
  const before = "exports.primary = 1;\r\nexports.secondary = 1;\n";
  const after = before.replace("secondary = 1", "secondary = 2");
  await writeFile(path, before);
  await writeFile(join(cwd, "check.cjs"), "require('node:assert/strict').deepEqual(require('./defaults.cjs'), {primary: 1, secondary: 2});\n");
  let step = 0;
  const provider: ModelProvider = {
    id: "strict-edit-replay", listModels: async () => [{ id: "offline", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      const last = request.messages.filter(message => message.role === "tool").at(-1)?.content ?? "";
      switch (++step) {
        case 1:
          yield* ScriptedModelProvider.toolCall("edit_file", { path: "defaults.cjs", oldText: anchor, newText: " = 2;", profile: "strict" });
          break;
        case 2: {
          expect(last).toContain("[failed]");
          expect(await readFile(path, "utf8")).toBe(before);
          let offset: number, limit: number;
          if (reason === "ambiguous anchor") {
            const positions = Array.from(last.matchAll(/line (\d+), column (\d+)/g));
            expect(positions.map(match => match[1])).toEqual(["1", "2"]);
            offset = Number(positions[1]![1]); limit = 1;
          } else {
            const hint = /read_file with offset=(\d+), limit=(\d+), versioned=true/.exec(last);
            expect(hint?.slice(1)).toEqual(["2", "1"]);
            offset = Number(hint![1]); limit = Number(hint![2]);
          }
          yield* ScriptedModelProvider.toolCall("read_file", { path: "defaults.cjs", offset, limit, versioned: true });
          break;
        }
        case 3: {
          const oldText = /"content":"([^"]+)"/.exec(last)?.[1];
          const expectedSha256 = /"sha256":"([a-f0-9]{64})"/.exec(last)?.[1];
          expect(oldText).toBe("exports.secondary = 1;");
          expect(expectedSha256).toBe(createHash("sha256").update(before).digest("hex"));
          yield* ScriptedModelProvider.toolCall("edit_file", { path: "defaults.cjs", oldText, newText: "exports.secondary = 2;", profile: "strict", expectedSha256 });
          break;
        }
        case 4:
          expect(last).toContain(createHash("sha256").update(after).digest("hex"));
          yield* ScriptedModelProvider.text("Updated the secondary default.");
          break;
        default: throw new Error("unexpected model request");
      }
    } }),
  };
  const h = await createHarness({
    cwd, dataDir: join(cwd, "state"), profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "offline" },
    featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [cwd] }, network: { mode: "deny" }, process: { timeoutMs: 10000 } },
    task: { id: "strict-edit", goal: "Change only the secondary default", completionPolicy: { requiresVerification: true },
      verification: [{ kind: "command", command: process.execPath, args: ["check.cjs"] }] },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "Change the secondary default to 2 and verify.");
    const result = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.grade).toBe("verified_complete");
    expect(step).toBe(4);
    expect(await readFile(path, "utf8")).toBe(after);
    expect((await h.events.list(session.id)).some(event => event.type === "verification.completed")).toBe(true);
  } finally { await h.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }
}, 30000);
