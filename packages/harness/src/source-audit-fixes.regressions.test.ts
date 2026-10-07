/** The 21 audit counterexamples now assert the required behavior, using real
 * composed Runtime, filesystem operations and production Web processes. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let output = "";
const records = new Map<string, { passed: boolean; error?: string }>();
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "harness-audit-acceptance-"));
  for (const script of ["acceptance.mjs", "web-acceptance.mjs"]) {
    await promisify(execFile)(process.execPath, [join(root, "scripts/research/source-audit-20261007", script)], {
      cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, OPENAI_API_KEY: "", OPENAI_MODEL: "", HARNESS_SOURCE_AUDIT_OUT: output },
    });
  }
  for (const filename of ["acceptance-results.json", "web-acceptance-results.json"]) {
    const result = JSON.parse(await readFile(join(output, filename), "utf8"));
    expect(result.paidProviderCalls).toBe(0);
    for (const record of result.records) records.set(record.id.split("-")[0], record);
  }
}, 90_000);
afterAll(async () => { if (output) await rm(output, { recursive: true, force: true }); });

for (let number = 1; number <= 21; number++) {
  const id = `B${String(number).padStart(2, "0")}`;
  it(`${id}: the audit's real counterexample now observes the required behavior`, () => {
    expect(records.has(id)).toBe(true);
    expect(records.get(id)?.passed, records.get(id)?.error).toBe(true);
  });
}
