import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it("edits an 8MiB ordinary source file in an isolated 128MiB Node heap", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-edit-heap-"));
  const target = join(root, "generated.ts");
  const original = "MARKER=1;\n" + "// Ordinary generated source line\n".repeat(254200);
  try {
    await fs.writeFile(target, original);
    // pnpm test builds before Vitest. Use the actual built tool in a separate
    // Node process so the runner's own heap cannot hide per-character maps.
    const program = `
      import { editFileTool } from ${JSON.stringify(new URL("../dist/tools/edit-file.js", import.meta.url).href)};
      const result = await editFileTool.execute({ path: process.argv[1], oldText: "MARKER=1", newText: "MARKER=2" },
        { cwd: process.argv[2], signal: new AbortController().signal });
      if (result.status !== "success" || result.output.replacements !== 1) throw new Error(JSON.stringify(result));
      console.log(JSON.stringify({ status: result.status, replacements: result.output.replacements }));
    `;
    const child = await execute(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", program, target, root], { timeout: 20000, maxBuffer: 64 * 1024 });
    expect(JSON.parse(child.stdout)).toEqual({ status: "success", replacements: 1 }); expect(child.stderr).toBe("");
    expect(await fs.readFile(target, "utf8")).toBe(original.replace("MARKER=1", "MARKER=2"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
