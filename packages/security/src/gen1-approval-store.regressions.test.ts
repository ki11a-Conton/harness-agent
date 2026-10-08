import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newAgentId, newApprovalId, newSessionId, type ApprovalRequest } from "@ar/contracts";
import { DurableApprovalStore } from "./approval.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gen1-approval-")); dirs.push(dir);
  return join(dir, "approval-store.json");
}
function request(): ApprovalRequest {
  return { id: newApprovalId(), sessionId: newSessionId(), agentId: newAgentId(), action: "edit", target: "a.ts", reason: "edit", createdAt: 1, expiresAt: 100, scope: "one_call" };
}

describe("Gen1 approval persistence fails closed", () => {
  it("propagates a non-ENOENT read failure instead of inventing a fresh store", async () => {
    const file = await fixture(); await mkdir(file);
    expect(() => new DurableApprovalStore(file)).toThrow();
  });

  it.each([
    { version: 999, pending: [], decisions: [] },
    { version: 1, pending: "not-an-array", decisions: [] },
    { version: 1, pending: [], decisions: "not-an-array" },
    { version: 1, pending: [null], decisions: [] },
    { version: 1, pending: [], decisions: [null] },
  ])("rejects unsupported or corrupt approval state %# without changing its bytes", async (record) => {
    const file = await fixture(); const bytes = JSON.stringify(record); await writeFile(file, bytes);
    expect(() => new DurableApprovalStore(file)).toThrow(/approval store/);
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("treats an existing empty file as lost approval state and keeps it untouched", async () => {
    const file = await fixture(); await writeFile(file, "");
    expect(() => new DurableApprovalStore(file)).toThrow(/approval store/);
    expect(await readFile(file, "utf8")).toBe("");
  });

  it("keeps a historically unversioned valid approval file usable and upgrades it on a real decision", async () => {
    const file = await fixture(); const pending = request();
    await writeFile(file, JSON.stringify({ pending: [pending], decisions: [] }));
    const store = new DurableApprovalStore(file, { now: () => 2 });
    expect(store.listPending()).toEqual([pending]);
    store.resolve(pending.id, "deny", "user");
    const reopened = new DurableApprovalStore(file, { now: () => 3 });
    expect(reopened.listDecisions()[0]?.value).toBe("deny");
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  });
});
