import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { newAgentId, newApprovalId } from "@ar/contracts";
import { createRuntimeRpc, FakeChannel, Gateway } from "@ar/gateway";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "@ar/harness";

it("B15: a restored sender can approve and cancel before sending another chat message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-web-restored-"));
  const harness = await createHarness({ cwd: dir, dataDir: dir, profile: "test", model: { providerId: "scripted", modelId: "scripted-model" }, modelProvider: new ScriptedModelProvider([]) });
  const owner = new FakeChannel("web"); const foreign = new FakeChannel("foreign");
  let gateway: Gateway | undefined;
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: dir });
    const request = { id: newApprovalId(), sessionId: session.id, agentId: newAgentId(), action: "exec", target: "test", reason: "test", createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
    harness.approvalStore.create(request);
    const rpc = createRuntimeRpc(harness.runtime, { sessionService: harness.sessionService, sessions: harness.sessions, approvalStore: harness.approvalStore, events: harness.events });
    gateway = new Gateway({ rpc, channels: [owner, foreign], sessionService: harness.sessionService, approvalStore: harness.approvalStore, events: harness.events,
      restoredBindings: [{ channelId: "web", from: "original-user", sessionId: session.id }], route: () => session.id });
    await gateway.start();
    await foreign.deliver(`approve:${request.id}:allow`, "original-user");
    await owner.deliver(`approve:${request.id}:allow`, "unbound-user");
    expect(harness.approvalStore.listPending()).toHaveLength(1);
    await owner.deliver(`approve:${request.id}:deny`, "original-user");
    expect(harness.approvalStore.listPending()).toHaveLength(0);
    expect(harness.approvalStore.listDecisions()[0]?.value).toBe("deny");
    await owner.deliver("cancel", "original-user");
    expect(owner.sentTexts().at(-1)).toBe("[cancel] not_running");
    expect(await harness.store.listSessions()).toHaveLength(1);
  } finally { await gateway?.stop(); await harness.close(); await rm(dir, { recursive: true, force: true }); }
});
