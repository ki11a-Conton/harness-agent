import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, StepExecutionSnapshot } from "@ar/contracts";
import { createHarness } from "./create-harness.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(body: string | Buffer): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-scoped-capture-harness-")); roots.push(root);
  await fs.writeFile(join(root, "AGENTS.md"), body);
  await fs.mkdir(join(root, "selected"));
  await fs.writeFile(join(root, "selected/AGENTS.md"), "SELECTED_VALID_RULE");
  await fs.writeFile(join(root, "selected/file.ts"), "selected data");
  await fs.mkdir(join(root, "other"));
  await fs.writeFile(join(root, "other/AGENTS.md"), "OTHER_UNSELECTED_RULE");
  return root;
}

function hook(root: string, mode: "zero" | "close-error") {
  const original = fs.open;
  const spy = vi.spyOn(fs, "open").mockImplementation((async (path: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
    const handle = await (original as (...args: unknown[]) => ReturnType<typeof fs.open>)(path, ...args);
    if (String(path) === join(root, "AGENTS.md")) {
      if (mode === "zero") handle.read = (async (buffer: Buffer) => ({ bytesRead: 0, buffer })) as typeof handle.read;
      else { const close = handle.close.bind(handle); handle.close = async () => { await close(); throw Object.assign(new Error("actual close then EIO"), { code: "EIO" }); }; }
    }
    return handle;
  }) as typeof fs.open); syncBuiltinESMExports(); return spy;
}

async function harness(root: string, cap = 100, optIn = true) {
  const requests: ModelRequest[] = []; const snapshots: StepExecutionSnapshot[] = [];
  const model = { providerId: "scoped-read-integration", modelId: "scripted" };
  const provider: ModelProvider = {
    id: model.providerId,
    listModels: async () => [{ id: model.modelId, name: "scripted", capabilities: { contextWindowTokens: 128_000 } }],
    createClient: () => ({ async *generate(request) {
      requests.push(request);
      const events: ModelEvent[] = [{ type: "started", timestamp: 0 }, { type: "completed", timestamp: 0, result: { finishReason: "stop", text: "capture verified" } }];
      yield* events;
    } }),
  };
  const h = await createHarness({ cwd: root, profile: "test", modelProvider: provider, model,
    ...(optIn ? { instructionDiscovery: { strategy: "path_scoped_instructions_v1", initialTargets: ["selected/file.ts"], maxDocuments: 4, maxBytesPerFile: cap } } : {}),
  });
  const runtime = h.runtime as unknown as { buildStepContext: (...args: unknown[]) => Promise<StepExecutionSnapshot> };
  const build = runtime.buildStepContext.bind(h.runtime);
  vi.spyOn(runtime, "buildStepContext").mockImplementation(async (...args) => { const snapshot = await build(...args); snapshots.push(snapshot); return snapshot; });
  const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd: root });
  const run = async () => {
    const turn = await h.runtime.startTurn(session.id, "Verify instruction capture; mentioning other/file.ts does not authorize scope.");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    return { request: requests.at(-1)!, projects: snapshots.at(-1)!.instructions.sources.filter(source => source.kind === "project_instruction") };
  };
  return { h, run, session };
}

describe("actual Harness opt-in instruction capture admission", () => {
  it("omits malformed documents from both model context and pinned source identity", async () => {
    const root = await fixture(Buffer.from([0xff])); const { h, run } = await harness(root);
    try {
      const result = await run();
      expect(result.request.system).toContain("SELECTED_VALID_RULE");
      expect(result.request.system).not.toContain("\uFFFD");
      expect(result.request.system).not.toContain("OTHER_UNSELECTED_RULE");
      expect(result.projects.map(source => source.path)).toEqual([join(root, "selected/AGENTS.md")]);
    } finally { await h.close(); }
  });
  it("does not pin incomplete captures or reuse them on the next actual turn", async () => {
    const root = await fixture("ROOT_VALID_RULE"); const openSpy = hook(root, "zero"); const { h, run } = await harness(root);
    try {
      const first = await run();
      expect(first.projects.map(source => source.path)).toEqual([join(root, "selected/AGENTS.md")]);
      expect(first.request.system).not.toContain("ROOT_VALID_RULE");
      openSpy.mockRestore(); syncBuiltinESMExports();
      const second = await run();
      expect(second.request.system).toContain("ROOT_VALID_RULE");
      expect(second.projects.map(source => source.path)).toEqual([join(root, "AGENTS.md"), join(root, "selected/AGENTS.md")]);
    } finally { await h.close(); }
  });
  it("keeps an actual turn running after a descriptor closes and then reports EIO", async () => {
    const root = await fixture("ROOT_VALID_RULE"); hook(root, "close-error"); const { h, run, session } = await harness(root);
    try {
      const result = await run();
      expect(result.request.system).toContain("ROOT_VALID_RULE"); expect(result.request.system).toContain("SELECTED_VALID_RULE");
      expect(result.projects.map(source => source.path)).toEqual([join(root, "AGENTS.md"), join(root, "selected/AGENTS.md")]);
      expect((await h.events.list(session.id)).some(event => event.type === "model.completed")).toBe(true);
    } finally { await h.close(); }
  });
  it("preserves BOM and existing bounded marker in an admitted model request", async () => {
    const root = await fixture("\uFEFFROOT_VALID_RULE\n".repeat(100)); const { h, run } = await harness(root, 64);
    try {
      const result = await run();
      expect(result.request.system).toContain("\uFEFFROOT_VALID_RULE"); expect(result.request.system).toContain("\n# [truncated]");
      expect(result.projects.map(source => source.path)).toEqual([join(root, "AGENTS.md"), join(root, "selected/AGENTS.md")]);
    } finally { await h.close(); }
  });
  it("retains the unchanged default subtree policy when no opt-in strategy is configured", async () => {
    const root = await fixture("ROOT_VALID_RULE"); const { h, run } = await harness(root, 100, false);
    try {
      const result = await run();
      expect(result.request.system).toContain("ROOT_VALID_RULE"); expect(result.request.system).toContain("SELECTED_VALID_RULE");
      expect(result.request.system).toContain("OTHER_UNSELECTED_RULE");
    } finally { await h.close(); }
  });
});
