import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import type { SessionId } from "@ar/contracts";
import { createDeepseekComposition } from "./composition.js";
import { allocateAvailableLeaseFixture } from "./test-support/lease-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function fixture() {
  return allocateAvailableLeaseFixture(async () => {
    const root = await mkdtemp(join(tmpdir(), "ar-plan-approval-")); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8 }));
    const cwd = join(root, "work"), dataDir = join(root, "data"); await mkdir(cwd);
    const provider = new ScriptedModelProvider([ScriptedModelProvider.text("Plan: create approved.txt, then inspect its contents."),
      ScriptedModelProvider.toolCall("write_file", { path: "approved.txt", content: "approved change" }), ScriptedModelProvider.text("Implemented the plan.")]);
    const base = await createHarness({ cwd, dataDir, profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "test" } });
    cleanup.push(() => base.close());
    const composition = await createDeepseekComposition(base, dataDir); cleanup.push(() => composition.close());
    const { sessionId } = await composition.sessions.call("session/create", { request: {} }, signal()) as { sessionId: SessionId };
    const command = (line: string) => composition.activity.call("commands/execute", { agentId: sessionId, line, submittedAttachments: [] }, signal());
    await command("/plan on");
    const owner = await composition.owners.ownerOf(sessionId), nativeId = composition.owners.nativeSessionId(sessionId);
    const actor = await owner.sessions.load(nativeId), turn = await actor.createTurn({ sessionId: nativeId, text: "Prepare the implementation plan." });
    expect((await actor.runTurn(turn.id)).status).toBe("completed");
    await expect.poll(async () => (await composition.controls.read(sessionId)).plan.status, { timeout: 10000 }).toBe("review");
    const plan = (await composition.controls.read(sessionId)).plan;
    return { root, cwd, composition, sessionId, provider, command, plan };
  }, cleanup);
}

describe("plan approval consumes only an explicit complete command", () => {
  it.each([
    ["misspelled verb", (revision: number) => `approve-now ${revision}`],
    ["trailing words", (revision: number) => `approve ${revision} later`],
    ["hexadecimal revision", (revision: number) => `approve 0x${revision.toString(16)}`],
    ["exponent revision", (revision: number) => `approve ${revision}e0`],
    ["fractional spelling", (revision: number) => `approve ${revision}.0`],
  ] as const)("rejects %s without approving or dispatching work", async (_name, argument) => {
    const f = await fixture();
    await expect(f.command(`/plan ${argument(f.plan.revision)}`)).rejects.toMatchObject({ code: "plan/invalid" });
    expect((await f.composition.controls.read(f.sessionId)).plan).toEqual(f.plan);
    expect(await f.composition.harness.inbox.listAll(f.sessionId)).toHaveLength(0);
    expect(f.provider.calls).toHaveLength(1);
    await expect(readFile(join(f.cwd, "approved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the exact decimal revision and idempotent retry, then executes one real write", async () => {
    const f = await fixture(), line = `/plan approve ${f.plan.revision}`;
    expect(await f.command(line)).toMatchObject({ result: { kind: "success" } });
    expect(await f.command(line)).toMatchObject({ result: { kind: "success" } });
    await expect.poll(async () => (await f.composition.harness.inbox.listAll(f.sessionId)).map(row => row.status), { timeout: 15000 }).toEqual(["consumed"]);
    expect(await readFile(join(f.cwd, "approved.txt"), "utf8")).toBe("approved change");
    expect((await f.composition.harness.events.list(f.sessionId)).filter(event => event.type === "tool.requested" && event.payload.name === "write_file")).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(3);
  });
});
