import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("a real legacy journal keeps an existing follow stream, reload, selected HTTP model and branch provenance across host restarts", async () => {
  const output = await mkdtemp(join(tmpdir(), "pr-upgrade-out-"));
  try {
    await promisify(execFile)(process.execPath, ["scripts/research/pr-blockers-20261017/legacy-model-switch.mjs", output], {
      cwd: process.cwd(), timeout: 30000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
    expect(result.status).toBe("PASS");
    expect(result.externalPaidCalls).toBe(0);
    expect(result.requests).toEqual([{ model: "model-a" }, { model: "model-b" }]);
    expect(result.selectionObservedByOldFollow).toBe(true);
    expect(result.restartPrefixIdentical).toBe(true);
    expect(result.branchAnswerModels).toEqual([{ providerId: "legacy", modelId: "model-a" }, { providerId: "legacy", modelId: "model-b" }]);
  } finally { await rm(output, { recursive: true, force: true }); }
}, 45000);
