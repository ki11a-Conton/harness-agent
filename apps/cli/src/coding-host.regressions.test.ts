import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { ApprovalRequest, Session, TurnId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createDefaultDeps, type DefaultDepsOptions } from "./main.js";
import { runCommand, type CommandDeps } from "./commands.js";
import { REAL_PROVIDER_ID } from "./provider.js";

const roots: string[] = [];
async function closeDeps(deps: CommandDeps) { await (deps as CommandDeps & { close?: () => Promise<void> }).close?.(); }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("C01: an explicit coding project is the host's tool/sandbox/doctor root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coding-root-")); roots.push(cwd);
  const deps = await createDefaultDeps({ cwd, provider: new ScriptedModelProvider([]) } as DefaultDepsOptions);
  try { expect(deps.doctor.workspaceRoot).toBe(cwd); }
  finally { await closeDeps(deps); }
});

it("C02: a live CLI host can approve a write in the same running session", async () => {
  const scratch = join(process.cwd(), ".ci"); await mkdir(scratch, { recursive: true });
  const cwd = await mkdtemp(join(scratch, "coding-approval-")); roots.push(cwd);
  const path = relative(process.cwd(), join(cwd, "result.txt"));
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("write_file", { path, content: "approved write" }),
    ScriptedModelProvider.text("done"),
  ]);
  const deps = await createDefaultDeps({ provider });
  let sessionId: Session["id"] | undefined; let turnId: TurnId | undefined; let approvals = 0;
  const original = deps.rpc.request.bind(deps.rpc);
  deps.rpc.request = async (method, params, ctx) => {
    const result = await original(method, params, ctx);
    if (method === "session.create") sessionId = (result as Session).id;
    if (method === "session.send") turnId = (result as { turnId: TurnId }).turnId;
    return result;
  };
  const hostDeps = Object.assign(deps, { runHost: {
    async approve(_request: ApprovalRequest, _signal: AbortSignal) { approvals++; return "allow" as const; },
  } }) as CommandDeps;
  const timer = setTimeout(() => {
    if (sessionId && turnId) void original("session.cancel", { sessionId, turnId });
  }, 5_000);
  try {
    const result = await runCommand(["run", process.cwd(), "write the result"], hostDeps);
    expect(approvals).toBe(1); expect(result.exitCode).toBe(0);
    expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("approved write");
  } finally { clearTimeout(timer); await closeDeps(deps); }
});
it("C06: configured interactive model identity is preserved in session metadata", async () => {
  const previous = process.env.OPENAI_MODEL;
  process.env.OPENAI_MODEL = "coding-model-selected-by-user";
  const provider = new ScriptedModelProvider([]);
  try {
    const realProvider = { ...provider, id: REAL_PROVIDER_ID, listModels: provider.listModels.bind(provider), createClient: provider.createClient.bind(provider) };
    const deps = await createDefaultDeps({ provider: realProvider });
    try {
      const agents = await deps.rpc.request("agent.list") as { id: string }[];
      const session = await deps.rpc.request("session.create", { agentId: agents[0]!.id, cwd: process.cwd() }) as Session;
      expect(session.model.modelId).toBe("coding-model-selected-by-user");
    } finally { await closeDeps(deps); }
  } finally { if (previous === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous; }
});
