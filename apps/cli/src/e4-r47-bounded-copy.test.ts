/**
 * E4-R47 — bounded, byte-conscious artifact capture (real recorder).
 *
 * The pre-R47 path read the WHOLE artifact into memory, hashed the decoded text
 * (not the source bytes), and trimmed over-cap copies by CHARACTER count. This
 * test proves the bounded streaming capture is byte-accurate and honestly
 * reports source vs captured head:
 *
 *   A. under-cap valid JSON   -> captured verbatim, truncated=false,
 *                                sourceDigest === independent sha256 of bytes;
 *   B. exactly at the cap     -> NOT truncated;
 *   C. over-cap               -> truncated=true, headBytes === cap,
 *                                captured copy === first `cap` bytes of source,
 *                                sourceDigest is the FULL-file digest (streamed),
 *                                headDigest is over the kept head only, and the
 *                                full body is NOT JSON.parsed (parseError notes it);
 *   D. multi-byte UTF-8       -> sourceBytes is a BYTE count, not a char count;
 *   E. invalid JSON           -> parseError recorded, failure preserved;
 *   F. missing file           -> captured=false + real read error;
 *   G. read error             -> captured=false (dir-as-file yields EISDIR/EPERM).
 *
 * The recorder unit proofs here are separate from the E2E wiring proofs (the
 * production chain actually populating dirs is covered by e4-09-production-e2e
 * itself) — see the E4-R47 report's evidence classification.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { E4DiagnosticRecorder } from "./e4-09-diagnostics.js";

const TEST_FILE = "apps/cli/src/e4-r47-bounded-copy.test.ts";
const TESTED_SHA = null; // unit-level; no git checkout required
let root: string;
let prevDiag: string | undefined;

const shaOf = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function makeRecorder(label: string, testName: string): E4DiagnosticRecorder {
  return new E4DiagnosticRecorder({ label, testFile: TEST_FILE, testedSha: TESTED_SHA, testName });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "e4-r47-root-"));
  prevDiag = process.env.E4_09_DIAG_DIR;
  process.env.E4_09_DIAG_DIR = root;
});

afterAll(async () => {
  if (prevDiag === undefined) delete process.env.E4_09_DIAG_DIR;
  else process.env.E4_09_DIAG_DIR = prevDiag;
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("E4-R47 bounded byte capture (recorder unit)", () => {
  it("A: under-cap valid JSON is copied verbatim and sourceDigest matches the bytes", async () => {
    const rec = makeRecorder("r47-a", "A under-cap");
    const p = join(root, "small.json");
    const body = JSON.stringify({ decision: "ACCEPT", reasonCodes: [] });
    await writeFile(p, body, "utf8");
    const buf = Buffer.from(body, "utf8");
    rec.registerArtifacts([{ role: "small", path: p, summarize: (x) => ({ decision: (x as Record<string, unknown>).decision }) }]);
    const out = await rec.captureFailure({ stage: "s", error: new Error("boom") });
    expect(out).not.toBeNull();
    const art = (out!.bundle.artifacts as Array<Record<string, unknown>>).find((a) => a.role === "small");
    expect(art).toBeDefined();
    expect(art!["captured"]).toBe(true);
    expect(art!["truncated"]).toBe(false);
    expect(art!["sourceBytes"]).toBe(buf.byteLength);
    expect(art!["sourceDigest"]).toBe(shaOf(buf));
    expect(art!["headBytes"]).toBe(buf.byteLength);
    expect(art!["headDigest"]).toBe(shaOf(buf));
    // the copied artifact file equals the source bytes verbatim
    const copied = await readFile(join(out!.dir, "artifacts", "small.json"), "binary");
    expect(Buffer.from(copied, "binary").equals(buf)).toBe(true);
    expect((out!.bundle.summary as Record<string, unknown>)["small"]).toEqual({ decision: "ACCEPT" });
  });

  it("B: exactly-at-cap file is NOT truncated", async () => {
    const rec = makeRecorder("r47-b", "B exact cap");
    // MAX_COPY_BYTES = 16*1024*1024; writing that whole buffer is heavy — use a
    // sparse 16 MiB payload via Buffer.alloc (zeros) so the test stays fast.
    const p = join(root, "exact.json");
    const buf = Buffer.alloc(16 * 1024 * 1024); // EXACTLY the cap
    await writeFile(p, buf);
    rec.registerArtifacts([{ role: "exact", path: p }]);
    const out = await rec.captureFailure({ stage: "s", error: new Error("boom") });
    expect(out).not.toBeNull();
    const art = (out!.bundle.artifacts as Array<Record<string, unknown>>).find((a) => a.role === "exact");
    expect(art!["truncated"]).toBe(false);
    expect(art!["sourceBytes"]).toBe(16 * 1024 * 1024);
  });

  it("C: over-cap file is truncated to the byte cap; full body is NOT JSON.parsed", async () => {
    const rec = makeRecorder("r47-c", "C over-cap");
    const cap = 16 * 1024 * 1024;
    // a body larger than the cap: cap + 1 bytes. Buffer.alloc zeros; write raw.
    const p = join(root, "big.bin");
    const buf = Buffer.alloc(cap + 1);
    buf.write("ABCD", 0, "utf8"); // distinguishable head
    await writeFile(p, buf);
    rec.registerArtifacts([{ role: "big", path: p }]);
    const out = await rec.captureFailure({ stage: "s", error: new Error("boom") });
    expect(out).not.toBeNull();
    const art = (out!.bundle.artifacts as Array<Record<string, unknown>>).find((a) => a.role === "big");
    expect(art!["captured"]).toBe(true);
    expect(art!["truncated"]).toBe(true);
    expect(art!["sourceBytes"]).toBe(cap + 1); // full size known
    expect(art!["headBytes"]).toBe(cap); // we keep exactly the cap
    expect(art!["sourceDigest"]).toBe(shaOf(buf)); // FULL-file digest (streamed)
    // headDigest is over the KEPT head only (first cap bytes)
    expect(art!["headDigest"]).toBe(shaOf(buf.subarray(0, cap)));
    // the copied artifact file IS the first cap bytes
    const copied = await readFile(join(out!.dir, "artifacts", "big.bin"), "binary");
    const copiedBuf = Buffer.from(copied, "binary");
    expect(copiedBuf.byteLength).toBe(cap);
    expect(copiedBuf.subarray(0, 4).toString("utf8")).toBe("ABCD");
    // full body was NOT JSON.parsed -> a parseError is recorded, summary null
    expect(String(art!["parseError"])).toMatch(/truncated|exceeds|bounded/i);
    expect((out!.bundle.summary as Record<string, unknown>)["big"]).toBeNull();
  });

  it("D: multi-byte UTF-8 content reports BYTE counts, not char counts", async () => {
    const rec = makeRecorder("r47-d", "D multibyte");
    const p = join(root, "mj.json");
    const body = JSON.stringify({ msg: "中文内容汉字示例" }); // 4-byte chars per some glyphs
    await writeFile(p, body, "utf8");
    const buf = Buffer.from(body, "utf8");
    rec.registerArtifacts([{ role: "mj", path: p }]);
    const out = await rec.captureFailure({ stage: "s", error: new Error("boom") });
    expect(out).not.toBeNull();
    const art = (out!.bundle.artifacts as Array<Record<string, unknown>>).find((a) => a.role === "mj");
    // bytes > chars for CJK; the count must be byte-accurate
    expect(art!["sourceBytes"]).toBe(buf.byteLength);
    expect(art!["sourceBytes"]).toBeGreaterThan(body.length); // CJK => bytes > chars
  });

  it("E: invalid JSON records a parseError and keeps the original failure", async () => {
    const rec = makeRecorder("r47-e", "E invalid json");
    const p = join(root, "bad.json");
    await writeFile(p, "{ not valid json !!", "utf8");
    rec.registerArtifacts([{ role: "bad", path: p, summarize: (x) => ({ decision: (x as Record<string, unknown>).decision }) }]);
    const out = await rec.captureFailure({ stage: "s", error: new Error("assertion failed") });
    expect(out).not.toBeNull();
    const art = (out!.bundle.artifacts as Array<Record<string, unknown>>).find((a) => a.role === "bad");
    expect(art!["captured"]).toBe(true);
    expect(String(art!["parseError"])).toMatch(/JSON|json|parse|Unexpected|Expected/i);
    // original failure + stage preserved
    const fail = out!.bundle.failure as Record<string, unknown>;
    expect(fail.message).toBe("assertion failed");
    expect(fail.stage).toBe("s");
  });

  it("F: a missing file is captured=false with a real read error; G: a directory-as-file yields an error", async () => {
    const rec = makeRecorder("r47-fg", "F missing G dir");
    const absent = join(root, "nope.json");
    rec.registerArtifacts([{ role: "missing", path: absent }]);
    const dirAsFile = join(root, "adirsample");
    await (await import("node:fs/promises")).mkdir(dirAsFile, { recursive: true });
    rec.registerArtifacts([{ role: "dirfile", path: dirAsFile }]);
    const out = await rec.captureFailure({ stage: "s", error: new Error("boom") });
    expect(out).not.toBeNull();
    const arts = out!.bundle.artifacts as Array<Record<string, unknown>>;
    const missing = arts.find((a) => a.role === "missing");
    expect(missing!["captured"]).toBe(false);
    expect(String(missing!["error"])).toMatch(/ENOENT|no such file/i);
    const dirf = arts.find((a) => a.role === "dirfile");
    expect(dirf!["captured"]).toBe(false);
    expect(String(dirf!["error"])).not.toBe("");
    // the recorder still produced a bundle (capture never masks the failure)
    expect((out!.bundle.failure as Record<string, unknown>).message).toBe("boom");
  });
});
