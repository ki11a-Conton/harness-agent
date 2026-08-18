import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HierarchicalInstructionDiscovery } from "./discovery.js";

const discovery = new HierarchicalInstructionDiscovery();

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function freshRoot(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "ctx-discovery-"));
  return tempDir;
}

async function writeDocs(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

describe("HierarchicalInstructionDiscovery (CTX-001)", () => {
  it("returns root first, nested by depth, cwd last", async () => {
    const r = await freshRoot();
    await writeDocs(r, {
      "AGENTS.md": "root",
      "sub/AGENTS.md": "cwd-doc",
      "sub/deep/AGENTS.md": "nested",
    });

    const docs = await discovery.discover(join(r, "sub"));

    expect(docs.map((d) => d.path)).toEqual([
      join(r, "AGENTS.md"),
      join(r, "sub", "deep", "AGENTS.md"),
      join(r, "sub", "AGENTS.md"),
    ]);
    expect(docs.map((d) => d.scope)).toEqual(["root", "nested", "cwd"]);
    expect(docs.map((d) => d.sizeBytes).length).toBe(3);
    expect(docs.every((d) => d.detectedAt > 0)).toBe(true);
  });

  it("sorts nested documents by directory depth, ties by path", async () => {
    const r = await freshRoot();
    await writeDocs(r, {
      "AGENTS.md": "root",
      "sub/x/AGENTS.md": "d1",
      "sub/a/b/AGENTS.md": "d2",
      "sub/a/c/AGENTS.md": "d2",
      "sub/e/f/g/AGENTS.md": "d3",
    });

    const docs = await discovery.discover(join(r, "sub"), { maxDocuments: 20 });

    expect(docs.map((d) => d.path)).toEqual([
      join(r, "AGENTS.md"),
      join(r, "sub", "x", "AGENTS.md"),
      join(r, "sub", "a", "b", "AGENTS.md"),
      join(r, "sub", "a", "c", "AGENTS.md"),
      join(r, "sub", "e", "f", "g", "AGENTS.md"),
    ]);
    expect(docs.map((d) => d.scope)).toEqual([
      "root",
      "nested",
      "nested",
      "nested",
      "nested",
    ]);
  });

  it("reports a single 'cwd' document when cwd is the root", async () => {
    const r = await freshRoot();
    await writeDocs(r, { "AGENTS.md": "root-only" });

    const docs = await discovery.discover(r);

    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      path: join(r, "AGENTS.md"),
      scope: "cwd",
      truncated: false,
      content: "root-only",
    });
  });

  it("limits results to maxDocuments, dropping the last-added documents", async () => {
    const r = await freshRoot();
    await writeDocs(r, {
      "AGENTS.md": "root",
      "sub/AGENTS.md": "cwd-doc",
      "sub/deep/AGENTS.md": "nested",
    });

    const two = await discovery.discover(join(r, "sub"), { maxDocuments: 2 });
    expect(two.map((d) => d.path)).toEqual([
      join(r, "AGENTS.md"),
      join(r, "sub", "deep", "AGENTS.md"),
    ]);

    const one = await discovery.discover(join(r, "sub"), { maxDocuments: 1 });
    expect(one.map((d) => d.path)).toEqual([join(r, "AGENTS.md")]);
  });

  it("truncates oversized documents at a line boundary with a marker", async () => {
    const r = await freshRoot();
    const lines = Array.from(
      { length: 30 },
      (_, i) => "line-" + String(i).padStart(2, "0") + "-abcdefghijklmnopqrstuvwxyz",
    );
    await writeDocs(r, { "AGENTS.md": lines.join("\n") });
    const expectedSize = (await stat(join(r, "AGENTS.md"))).size;

    const docs = await discovery.discover(r, { maxBytesPerFile: 100 });

    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc.truncated).toBe(true);
    expect(doc.sizeBytes).toBe(expectedSize);
    expect(doc.content.endsWith(`# [truncated at ${expectedSize} bytes]`)).toBe(true);
    const beforeMarker = doc.content.slice(0, doc.content.indexOf("# [truncated at "));
    expect(beforeMarker).toBe(lines[0] + "\n" + lines[1] + "\n");
  });

  it("does not truncate documents within the budget", async () => {
    const r = await freshRoot();
    const small = "short\nsecond line\n";
    await writeDocs(r, { "AGENTS.md": small });

    const docs = await discovery.discover(r);

    expect(docs[0]).toMatchObject({ truncated: false, content: small });
    expect(docs[0]!.sizeBytes).toBe((await stat(join(r, "AGENTS.md"))).size);
  });

  it("measures truncation in UTF-8 bytes, not characters", async () => {
    const r = await freshRoot();
    await writeDocs(r, { "AGENTS.md": "ascii-line\n한국어-문자열-라인\nlast" });

    const docs = await discovery.discover(r, { maxBytesPerFile: 30 });

    const doc = docs[0]!;
    expect(doc.truncated).toBe(true);
    expect(doc.content.startsWith("ascii-line")).toBe(true);
    expect(doc.content.includes("한국어")).toBe(false);
  });

  it("returns an empty array when no AGENTS.md exists", async () => {
    const r = await freshRoot();
    await writeDocs(r, { "sub/file.txt": "x" });

    expect(await discovery.discover(r)).toEqual([]);
    expect(await discovery.discover(join(r, "sub"))).toEqual([]);
  });

  it("skips node_modules/.git/dist/out/build/.cache directories", async () => {
    const r = await freshRoot();
    await writeDocs(r, {
      "AGENTS.md": "root",
      "src/AGENTS.md": "nested-kept",
      "node_modules/AGENTS.md": "skip",
      ".git/AGENTS.md": "skip",
      "dist/AGENTS.md": "skip",
      "out/AGENTS.md": "skip",
      "build/AGENTS.md": "skip",
      ".cache/AGENTS.md": "skip",
    });

    const docs = await discovery.discover(r);

    expect(docs.map((d) => d.path)).toEqual([
      join(r, "AGENTS.md"),
      join(r, "src", "AGENTS.md"),
    ]);
    expect(docs.map((d) => d.scope)).toEqual(["cwd", "nested"]);
  });

  it("throws when cwd does not exist or is not a directory", async () => {
    const r = await freshRoot();
    await writeDocs(r, { "file.txt": "x" });

    await expect(discovery.discover(join(r, "missing"))).rejects.toThrow();
    await expect(discovery.discover(join(r, "file.txt"))).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("does not follow directory symlinks", async () => {
    const r = await freshRoot();
    await writeDocs(r, {
      "AGENTS.md": "root",
      "real/AGENTS.md": "target",
    });
    await symlink(join(r, "real"), join(r, "link"), "dir");

    const docs = await discovery.discover(r);

    expect(docs.map((d) => d.path)).toEqual([
      join(r, "AGENTS.md"),
      join(r, "real", "AGENTS.md"),
    ]);
  });
});