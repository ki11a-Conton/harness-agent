import { readFile } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const indexPath = resolve(process.argv[2] ?? resolve(repo, "docs/evidence/agent-measurement-20261003/artifact-index.json"));
const base = dirname(indexPath);
const index = JSON.parse(await readFile(indexPath, "utf8"));
if (!Array.isArray(index.files) || index.files.length === 0) throw new Error("Nonempty artifact files are required");
const seen = new Set();
for (const entry of index.files) {
  if (typeof entry.path !== "string" || isAbsolute(entry.path)) throw new Error("Artifact path must be relative");
  const path = resolve(base, entry.path);
  const rel = relative(base, path);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("Artifact path escapes the evidence root");
  if (seen.has(path)) throw new Error("Duplicate artifact path");
  seen.add(path);
  const bytes = await readFile(path);
  if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error(`Artifact integrity mismatch: ${entry.path}`);
  }
}
console.log(JSON.stringify({ status: "PASS", files: seen.size, bytes: index.files.reduce((n, f) => n + f.bytes, 0) }));
