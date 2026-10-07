import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let output = "";
let records: Array<{ id: string; passed: boolean }> = [];
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "audit-recovery-test-"));
  await promisify(execFile)(process.execPath, [join(root, "scripts/research/source-audit-20261007/recovery-acceptance.mjs")], {
    cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, HARNESS_SOURCE_AUDIT_OUT: output, OPENAI_API_KEY: "" },
  });
  const result = JSON.parse(await readFile(join(output, "recovery-acceptance-results.json"), "utf8"));
  expect(result.modelCalls).toBe(0); expect(result.paidProviderCalls).toBe(0); records = result.records;
}, 90_000);
afterAll(async () => { if (output) await rm(output, { recursive: true, force: true }); });
for (const mode of ["committed", "unknown", "tampered"]) {
  it(`B13: real killed process recovery handles ${mode} without resetting grants or adopting unknown dispatch`, () => {
    expect(records.find((record) => record.id === mode)?.passed).toBe(true);
  });
}
