/**
 * E4-R52 (F52) — the captured copy must be the REAL bytes, and the copy's
 * declared size/digest must describe the bytes actually on disk.
 *
 * Pre-R52 the small-file branch of `readArtifact` produced `headText` via
 * `head.toString("utf8")` and `captureFailure` wrote that STRING back with
 * `writeFile(target, text, "utf8")`. Any byte sequence that is not valid UTF-8
 * was silently transcoded: the 4-byte source `ff fe 00 61` landed as the 8-byte
 * `ef bf bd ef bf bd 00 61` (two U+FFFD). Meanwhile `headBytes` stayed 4 and
 * `headDigest` stayed the digest of the ORIGINAL bytes — so the recorded digest
 * provably did not describe the copy that was written. Evidence that lies is
 * worse than no evidence.
 *
 * The second defect (plan §4 item 5) is a stat/stream disagreement: `cap` was
 * derived from the FIRST `stat().size`, while `truncated` was derived from the
 * final streamed `total`. A file that grows between stat and read therefore
 * produced `sourceBytes > headBytes` with `truncated === false` — a record that
 * claims a COMPLETE capture while the copy is missing its tail.
 *
 * Fault injection for that growth case happens at the I/O boundary only: the
 * file really exists (so `stat` returns its real size) while the read stream is
 * replaced by a real `Readable` that emits MORE bytes than stat reported.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

const faultTable = vi.hoisted(() => ({ streams: new Map<string, () => unknown>() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (path: unknown, opts?: unknown) => {
      const make = faultTable.streams.get(String(path));
      if (make !== undefined) return make();
      return (actual.createReadStream as (a: unknown, b?: unknown) => unknown)(path, opts);
    },
  };
});

const { E4DiagnosticRecorder } = await import("./e4-09-diagnostics.js");

const TEST_FILE = "apps/cli/src/e4-r52-raw-bytes.test.ts";
const CAP = 16 * 1024 * 1024; // MAX_COPY_BYTES (not exported; see R47)
let testedSha: string | null = null;
try {
  testedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
} catch {
  testedSha = null;
}

let root: string;
let prevDiag: string | undefined;
let seq = 0;

const shaOf = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const nextPath = (name: string): string => join(root, `r52-${seq++}-${name}`);

const makeRecorder = (label: string, testName: string): InstanceType<typeof E4DiagnosticRecorder> =>
  new E4DiagnosticRecorder({ label, testFile: TEST_FILE, testedSha, testName });

const artOf = (bundle: Record<string, unknown>, role: string): Record<string, unknown> => {
  const found = (bundle.artifacts as Array<Record<string, unknown>>).find((a) => a.role === role);
  expect(found, `artifact record for role ${role}`).toBeDefined();
  return found!;
};

/** Read back the copied file from the bundle as raw bytes. */
async function copiedBytes(dir: string, name: string): Promise<Buffer> {
  const raw = await readFile(join(dir, "artifacts", name), "binary");
  return Buffer.from(raw, "binary");
}

/** A real Readable that emits a fixed byte sequence (optionally more than stat saw). */
function fixedStream(bytes: Buffer): Readable {
  let done = false;
  return new Readable({
    read() {
      if (done) return;
      done = true;
      this.push(bytes);
      setImmediate(() => this.push(null));
    },
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "e4-r52-root-"));
  prevDiag = process.env.E4_09_DIAG_DIR;
  process.env.E4_09_DIAG_DIR = root;
});

afterEach(() => {
  faultTable.streams.clear();
});

afterAll(async () => {
  if (prevDiag === undefined) delete process.env.E4_09_DIAG_DIR;
  else process.env.E4_09_DIAG_DIR = prevDiag;
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("E4-R52 raw byte fidelity (real recorder)", () => {
  it("1/2: non-UTF-8 4-byte source is copied byte-identically; copy digest and source digest both verified independently", async () => {
    const rec = makeRecorder("r52-1", "raw bytes");
    const p = nextPath("raw.json");
    const src = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    await writeFile(p, src);
    rec.registerArtifacts([{ role: "raw", path: p }]);

    const out = await rec.captureFailure({ stage: "s", error: new Error("boom") });
    expect(out).not.toBeNull();
    const art = artOf(out!.bundle, "raw");
    expect(art["captured"]).toBe(true);

    const copy = await copiedBytes(out!.dir, "raw.json");
    // The copy IS the source, byte for byte — no U+FFFD substitution.
    expect(copy.equals(src)).toBe(true);
    expect(copy.byteLength).toBe(4);
    // Independently computed digests must agree with the declared ones.
    expect(art["headBytes"]).toBe(4);
    expect(art["headDigest"]).toBe(shaOf(copy));
    expect(art["sourceBytes"]).toBe(4);
    expect(art["sourceDigest"]).toBe(shaOf(src));
  });

  it("3: valid CJK UTF-8 round-trips, unparseable JSON keeps the real file + parseError, empty file is coherent", async () => {
    const rec = makeRecorder("r52-3", "utf8 / bad json / empty");
    const cjk = nextPath("cjk.json");
    const badJson = nextPath("badjson.json");
    const empty = nextPath("empty.json");
    const cjkBody = Buffer.from(JSON.stringify({ msg: "中文内容" }), "utf8");
    await writeFile(cjk, cjkBody);
    const badBody = Buffer.from("{ not valid json !!", "utf8");
    await writeFile(badJson, badBody);
    await writeFile(empty, Buffer.alloc(0));
    rec.registerArtifacts([
      { role: "cjk", path: cjk, summarize: (x) => ({ msg: (x as Record<string, unknown>).msg }) },
      { role: "badjson", path: badJson },
      { role: "empty", path: empty },
    ]);

    const out = await rec.captureFailure({ stage: "s", error: new Error("boom") });
    expect(out).not.toBeNull();
    const dir = out!.dir;

    // valid CJK: bytes preserved and the summary decodes correctly
    const cjkCopy = await copiedBytes(dir, "cjk.json");
    expect(cjkCopy.equals(cjkBody)).toBe(true);
    expect((out!.bundle.summary as Record<string, unknown>)["cjk"]).toEqual({ msg: "中文内容" });

    // invalid JSON: the REAL original bytes are kept, and the failure is a
    // parseError — never reported as a missing/uncaptured artifact
    const badArt = artOf(out!.bundle, "badjson");
    expect(badArt["captured"]).toBe(true);
    expect(String(badArt["parseError"])).toMatch(/JSON|Unexpected|Expected|parse/i);
    const badCopy = await copiedBytes(dir, "badjson.json");
    expect(badCopy.equals(badBody)).toBe(true);

    // empty file: 0 bytes, still a coherent, captured record
    const emptyArt = artOf(out!.bundle, "empty");
    expect(emptyArt["captured"]).toBe(true);
    expect(emptyArt["sourceBytes"]).toBe(0);
    expect(emptyArt["headBytes"]).toBe(0);
    expect(emptyArt["truncated"]).toBe(false);
    expect((await copiedBytes(dir, "empty.json")).byteLength).toBe(0);
  });

  it("4: cap-1 / cap / cap+1 boundaries stay correct, and a multi-byte char straddling the cut is preserved as BYTES", async () => {
    // A 3-byte UTF-8 char ("中") placed so that the copy cap cuts it AFTER its
    // first byte — the exact shape a string round-trip would corrupt into U+FFFD.
    const straddle = Buffer.from("中", "utf8"); // 3 bytes
    expect(straddle.byteLength).toBe(3);
    const mk = (total: number): Buffer => {
      const b = Buffer.alloc(total, 0x41);
      if (total > CAP) {
        // start the char on the LAST byte we keep, so bytes 2..3 fall outside
        straddle.copy(b, CAP - 1);
      }
      return b;
    };

    for (const [name, size, expectTrunc] of [
      ["cap-1", CAP - 1, false],
      ["cap", CAP, false],
      ["cap+1", CAP + 1, true],
    ] as Array<[string, number, boolean]>) {
      const rec = makeRecorder(`r52-4-${name}`, `boundary ${name}`);
      const p = nextPath(`${name}.bin`);
      const buf = mk(size);
      await writeFile(p, buf);
      rec.registerArtifacts([{ role: name, path: p }]);
      const out = await rec.captureFailure({ stage: "s", error: new Error("boom") });
      expect(out).not.toBeNull();
      const art = artOf(out!.bundle, name);
      expect(art["captured"]).toBe(true);
      expect(art["sourceBytes"]).toBe(size);
      expect(art["truncated"]).toBe(expectTrunc);
      const kept = expectTrunc ? CAP : size;
      expect(art["headBytes"]).toBe(kept);
      const copy = await copiedBytes(out!.dir, `${name}.bin`);
      // byte-exact prefix — the half-kept multi-byte char stays a raw byte
      expect(copy.equals(buf.subarray(0, kept))).toBe(true);
      expect(art["headDigest"]).toBe(shaOf(copy));
      // no U+FFFD substitution character was introduced anywhere in the copy
      expect(copy.includes(Buffer.from("\uFFFD", "utf8"))).toBe(false);
      if (expectTrunc) {
        // prove the cut really fell INSIDE the 3-byte char: the last kept byte
        // is the char's first byte, and its continuation bytes were dropped
        expect(copy[CAP - 1]).toBe(straddle[0]);
        expect(copy.byteLength).toBe(CAP);
      }
    }
  });

  it("5: a source that grows between stat and read is NOT reported as a complete capture", async () => {
    const rec = makeRecorder("r52-5", "grow during read");
    const p = nextPath("grow.json");
    // stat sees 10 bytes...
    const statBytes = Buffer.alloc(10, 0x42);
    await writeFile(p, statBytes);
    // ...but the read stream delivers 60 bytes.
    const grown = Buffer.alloc(60, 0x43);
    faultTable.streams.set(p, () => fixedStream(grown));
    rec.registerArtifacts([{ role: "grow", path: p }]);

    const out = await rec.captureFailure({ stage: "s", error: new Error("boom") });
    expect(out).not.toBeNull();
    const art = artOf(out!.bundle, "grow");
    expect(art["captured"]).toBe(true);
    expect(art["sourceBytes"]).toBe(60); // what was actually read
    expect(art["headBytes"]).toBe(10); // what the pre-read stat allowed us to keep
    // THE regression: a copy that is a strict prefix of what was read must never
    // be declared complete.
    expect(art["truncated"]).toBe(true);
    const copy = await copiedBytes(out!.dir, "grow.json");
    expect(copy.byteLength).toBe(10);
    expect(copy.equals(grown.subarray(0, 10))).toBe(true);
    expect(art["headDigest"]).toBe(shaOf(copy));
  });
});
