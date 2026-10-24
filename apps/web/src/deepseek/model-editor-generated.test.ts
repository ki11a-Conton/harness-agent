import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

it("the shipped reasoning component is reproducible from the retained upstream TSX and CSS/locales", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/research/generate-model-reasoning.mjs", "--check"], { cwd: root, timeout: 15000 });
  expect(stdout).toContain("MODEL_REASONING_GENERATED_SOURCE_MATCH");
}, 20000);

it("retains the recorded MIT source and the same license shipped with the UI", async () => {
  const root = new URL("../../../../", import.meta.url);
  const provenance = JSON.parse(await readFile(new URL("third_party/deepseek-model-reasoning/PROVENANCE.json", root), "utf8"));
  const source = await readFile(new URL("third_party/deepseek-model-reasoning/ModelReasoningEfforts.tsx", root));
  expect(createHash("sha256").update(source).digest("hex")).toBe(provenance.originalFiles.find((file: { path: string }) => file.path.endsWith("/ModelReasoningEfforts.tsx")).sha256);
  const license = await readFile(new URL("third_party/deepseek-model-reasoning/LICENSE", root));
  expect(license).toEqual(await readFile(new URL("apps/web/public/deepseek/licenses/upstream-source-reference/LICENSE", root)));
});
