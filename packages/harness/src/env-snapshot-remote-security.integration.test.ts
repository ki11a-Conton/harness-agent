import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

it.each(["interactive", "test"] as const)("%s: native Git URL credentials cannot reach the next model request", async profile => {
  const cwd = await mkdtemp(join(tmpdir(), "harness-env-remote-"));
  const genericPassword = "opaqueFixturePass9q", queryCredential = "opaqueQueryCredential9q";
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let approvalTimer: ReturnType<typeof setInterval> | undefined;
  let approved = 0;
  const approvalReasons: string[] = [];
  try {
    git("init", "-q");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    git("remote", "add", "origin", `https://build-user:${genericPassword}@example.invalid/org/repo.git?access_token=${queryCredential}#private-fragment`);
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "env-remote-offline",
      listModels: async () => [{ id: "scripted", capabilities: { contextWindowTokens: 128000 } }],
      createClient: () => ({ async *generate(request) {
        requests.push(structuredClone(request));
        yield* requests.length === 1
          ? ScriptedModelProvider.toolCall("env_snapshot", { probeLimit: 0 })
          : ScriptedModelProvider.text("Inspected environment.");
      } }),
    };
    harness = await createHarness({ cwd, dataDir: join(cwd, "state"), profile, modelProvider: provider,
      model: { providerId: provider.id, modelId: "scripted" },
      featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false },
    });
    // The interactive profile asks before process-capable env_snapshot. Grant
    // the real pending request through its store; never bypass the approval.
    approvalTimer = setInterval(() => {
      for (const request of harness!.approvalStore.listPending()) {
        approvalReasons.push(request.reason);
        harness!.approvalStore.resolve(request.id, "allow", "test");
        approved++;
      }
    }, 5);
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const turn = await harness.runtime.startTurn(session.id, "Inspect the selected workspace environment.");
    const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(approved).toBe(profile === "interactive" ? 1 : 0);
    if (profile === "interactive") expect(approvalReasons).toEqual([expect.stringContaining("env_snapshot")]);
    expect(requests).toHaveLength(2);
    const modelToolText = requests[1]!.messages.filter(message => message.role === "tool").map(message => message.content).join("\n");
    expect(modelToolText).toContain('"remote":"https://example.invalid/org/repo.git"');
    const allModelRequests = JSON.stringify(requests);
    for (const secret of [genericPassword, queryCredential, "build-user", "private-fragment"]) {
      expect(allModelRequests).not.toContain(secret);
    }
  } finally {
    if (approvalTimer !== undefined) clearInterval(approvalTimer);
    await harness?.close(); await rm(cwd, { recursive: true, force: true });
  }
});
