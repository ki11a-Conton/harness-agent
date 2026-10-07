import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ScriptedModelProvider } from "@ar/model";
import { assertToolProtocol, type ModelRequest } from "@ar/contracts";
import { createHarness } from "./create-harness.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coding-verification-")); roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  return root;
}
async function harness(root: string, count = 1) {
  return createHarness({ cwd: root, profile: "test", model: { providerId: "scripted", modelId: "scripted-model" },
    modelProvider: new ScriptedModelProvider(Array.from({ length: count * 8 }, () => ScriptedModelProvider.text("done"))),
    task: { id: "coding", goal: "verify the current project" },
  });
}
it("C03: verification discovers the session project rather than the host parent", async () => {
  const root = await fixture(); const cwd = join(root, "child"); await mkdir(cwd);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(7)"' } }));
  const h = await harness(root);
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "verify");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.terminationReason).toBe("verification_failed");
  } finally { await h.close(); }
});
it("C05: a failed verification command's diagnostics reach the next model request as protected tool data", async () => {
  const cwd = await fixture();
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "console.error(\'ASSERTION_EXPECTED_42_AT_MATH_LINE_7\'); process.exit(8)"' } }));
  const seen: ModelRequest[] = [];
  const provider = new ScriptedModelProvider(Array.from({ length: 8 }, () => ScriptedModelProvider.text("done")));
  const original = provider.createClient.bind(provider);
  provider.createClient = (model, config) => {
    const client = original(model, config);
    return { async *generate(request, signal) { seen.push(request as ModelRequest); yield* client.generate(request, signal); } };
  };
  const h = await createHarness({ cwd, profile: "test", model: { providerId: provider.id, modelId: "scripted-model" }, modelProvider: provider, task: { id: "coding", goal: "fix the failing assertion" } });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "fix");
    await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    for (const request of seen) assertToolProtocol(request.messages);
    expect(seen.slice(1).some(request => request.messages.some(message => message.role === "tool" && message.content.includes("ASSERTION_EXPECTED_42_AT_MATH_LINE_7")))).toBe(true);
  } finally { await h.close(); }
});
it("C04: changing the project test recipe invalidates the previous passing verification", async () => {
  const cwd = await fixture(); const h = await harness(cwd, 2);
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    async function run() { const turn = await h.runtime.startTurn(session.id, "verify"); return h.runtime.runTurn(session.id, turn.id, new AbortController().signal); }
    expect((await run()).terminationReason).toBe("verified_complete");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(9)"' } }));
    expect((await run()).terminationReason).toBe("verification_failed");
  } finally { await h.close(); }
});
