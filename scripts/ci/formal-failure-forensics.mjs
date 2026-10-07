/** Recover an existing, non-paid formal failure; do not rerun or revise it. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export function failureReceipt(root) {
  function locate(dir) {
    if (readdirSync(dir).includes("commands.json")) return dir;
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) {
      const found = locate(join(dir, entry.name)); if (found) return found;
    }
  }
  const directory = locate(root); if (!directory) throw new Error("FORMAL_COMMAND_RECEIPT_MISSING");
  const raw = readFileSync(join(directory, "commands.json"));
  const commands = JSON.parse(raw); const failed = commands.find(c => c.exitCode !== 0);
  if (!failed || !/^[a-z-]+$/.test(failed.label)) throw new Error("FORMAL_FAILED_PHASE_MISSING");
  const log = readFileSync(join(directory, `${failed.label}.log`));
  const text = log.toString("utf8");
  const marker = text.lastIndexOf("Failed Tests");
  const excerpt = (marker >= 0 ? text.slice(Math.max(0, marker - 150)) : text).slice(-64000);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  return { schemaVersion: "formal-failure-forensics-v1", originalRunId: "37615393968",
    originalSourceSha: "21fa7436b1abdcbc0dcd4f8a300f171b1a35f8e0", commands,
    commandReceipt: { bytes: raw.length, sha256: hash(raw) },
    failedPhase: failed.label, log: { file: `${failed.label}.log`, bytes: log.length, sha256: hash(log) },
    excerpt, excerptSha256: hash(Buffer.from(excerpt)), paidCalls: 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = failureReceipt(resolve(process.argv[2]));
  const encoded = gzipSync(Buffer.from(JSON.stringify(receipt))).toString("base64");
  const total = Math.ceil(encoded.length / 2500);
  if (total > 9) throw new Error("FORMAL_FORENSICS_EXCEEDS_PUBLIC_PACKET_LIMIT");
  const escape = value => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (let index = 0; index < total; index++) console.log(`::notice title=Original formal failure ${index + 1}/${total}::${escape(JSON.stringify({ encoding: "gzip+base64", index, total, data: encoded.slice(index * 2500, (index + 1) * 2500) }))}`);
}
