/**
 * E4-R51 (F51) — the artifact read MUST always settle.
 *
 * Pre-R51 `readArtifact` wired its completion to `stream.on("end")` ONLY, while
 * the `error` handler merely recorded the message and called `stream.destroy()`.
 * A destroyed stream does NOT emit `end`, so a read error that happens AFTER a
 * successful `stat` (the only errors `stat` can no longer intercept) left the
 * Promise pending forever. The consequence was not cosmetic: `captureFailure`
 * awaits `readArtifact` per registered artifact, so the failure-forensics path
 * itself hung, and the test's `afterEach` never got to run its cleanup.
 *
 * Fault injection happens at the I/O boundary ONLY: `node:fs.createReadStream`
 * is wrapped so that a path registered in the fault table yields a REAL
 * `Readable` we drive by hand (real `data`/`error`/`close` events). Everything
 * else — the recorder, `captureFailure`, `stat`, the bundle writer — is the
 * production module, unmodified.
 *
 * The `settledWithin` guard is a HANG PROTECTOR for the assertion, not the fix:
 * the pre-R51 implementation never resolves at all, so without it the failure
 * would surface as a bare framework timeout instead of a discriminating
 * "never settled" assertion. No production timeout is added.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

/** Fault table: absolute path -> factory producing the stream to hand back. */
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

const TEST_FILE = "apps/cli/src/e4-r51-read-settle.test.ts";
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

const makeRecorder = (label: string, testName: string): InstanceType<typeof E4DiagnosticRecorder> =>
  new E4DiagnosticRecorder({ label, testFile: TEST_FILE, testedSha, testName });

/** A REAL Readable whose event sequence we control precisely. */
function faultStream(plan: { data?: Buffer; error?: Error; closeWithoutEnd?: boolean }): Readable {
  let started = false;
  return new Readable({
    read() {
      if (started) return;
      started = true;
      if (plan.data !== undefined) this.push(plan.data);
      // Defer so an attached consumer has already seen 'data' before the
      // terminal event fires — this is the "partial data, then failure" shape.
      setImmediate(() => {
        if (plan.error !== undefined) this.destroy(plan.error);
        else if (plan.closeWithoutEnd === true) this.destroy();
        else this.push(null);
      });
    },
  });
}

/**
 * HANG PROTECTOR (assertion-level, not a production timeout). Returns
 * `settled: false` if the capture never resolves inside `ms`.
 */
async function settledWithin<T>(p: Promise<T>, ms = 2000): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<{ settled: false }>((res) => {
    timer = setTimeout(() => res({ settled: false }), ms);
  });
  try {
    const raced = await Promise.race([
      p.then((value) => ({ settled: true as const, value })),
      guard,
    ]);
    return raced;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const nextPath = (name: string): string => join(root, `f${seq++}-${name}`);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "e4-r51-root-"));
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

const artifactsOf = (bundle: Record<string, unknown>): Array<Record<string, unknown>> =>
  bundle.artifacts as Array<Record<string, unknown>>;

describe("E4-R51 artifact read always settles (real recorder, I/O-boundary injection)", () => {
  it("1: stat succeeds, then an async EIO — capture settles, artifact captured=false with the EIO reason", async () => {
    const rec = makeRecorder("r51-1", "async EIO after stat");
    const p = nextPath("eio.json");
    // The file REALLY exists so `stat` passes; only the read stream is faulted.
    await writeFile(p, Buffer.from('{"decision":"ACCEPT"}', "utf8"));
    faultTable.streams.set(p, () =>
      faultStream({ data: Buffer.from('{"decision":', "utf8"), error: new Error("EIO: simulated read failure") }),
    );
    rec.registerArtifacts([{ role: "eio", path: p }]);

    const raced = await settledWithin(rec.captureFailure({ stage: "diag", error: new Error("original boom") }));
    expect(raced.settled, "captureFailure never settled — readArtifact Promise is still pending").toBe(true);
    if (!raced.settled) return;

    expect(raced.value).not.toBeNull();
    const art = artifactsOf(raced.value!.bundle).find((a) => a.role === "eio");
    expect(art).toBeDefined();
    expect(art!["captured"]).toBe(false);
    expect(String(art!["error"])).toMatch(/EIO/);
  });

  it("2: partial data then error is NOT reported as a complete capture", async () => {
    const rec = makeRecorder("r51-2", "partial then error");
    const p = nextPath("partial.json");
    await writeFile(p, Buffer.alloc(4096, 0x41));
    faultTable.streams.set(p, () =>
      faultStream({ data: Buffer.from("PARTIAL-BODY", "utf8"), error: new Error("EIO: mid-stream failure") }),
    );
    rec.registerArtifacts([{ role: "partial", path: p }]);

    const raced = await settledWithin(rec.captureFailure({ stage: "diag", error: new Error("original boom") }));
    expect(raced.settled).toBe(true);
    if (!raced.settled) return;

    const art = artifactsOf(raced.value!.bundle).find((a) => a.role === "partial");
    expect(art!["captured"]).toBe(false);
    expect(art!["sourceDigest"]).toBeUndefined();
    expect(String(art!["error"])).toMatch(/EIO/);
  });

  it("3: close before end settles and records the premature close (no hang, not a success)", async () => {
    const rec = makeRecorder("r51-3", "close before end");
    const p = nextPath("premature.json");
    await writeFile(p, Buffer.from("0123456789", "utf8"));
    faultTable.streams.set(p, () => faultStream({ data: Buffer.from("0123", "utf8"), closeWithoutEnd: true }));
    rec.registerArtifacts([{ role: "premature", path: p }]);

    const raced = await settledWithin(rec.captureFailure({ stage: "diag", error: new Error("original boom") }));
    expect(raced.settled, "a stream that closed before 'end' must not leave the read pending").toBe(true);
    if (!raced.settled) return;

    const art = artifactsOf(raced.value!.bundle).find((a) => a.role === "premature");
    expect(art!["captured"]).toBe(false);
    expect(String(art!["error"])).toMatch(/close|closed|premature|incomplete/i);
  });

  it("4: a normal data/end/close read completes exactly once with a correct summary", async () => {
    const rec = makeRecorder("r51-4", "normal read");
    const p = nextPath("normal.json");
    const body = JSON.stringify({ decision: "REJECT", reasonCodes: ["R1"] });
    await writeFile(p, body, "utf8");
    const buf = Buffer.from(body, "utf8");
    rec.registerArtifacts([
      { role: "normal", path: p, summarize: (x) => ({ decision: (x as Record<string, unknown>).decision }) },
    ]);

    const raced = await settledWithin(rec.captureFailure({ stage: "diag", error: new Error("original boom") }));
    expect(raced.settled).toBe(true);
    if (!raced.settled) return;

    const arts = artifactsOf(raced.value!.bundle).filter((a) => a.role === "normal");
    // "exactly once": a single record, not one per lifecycle event.
    expect(arts).toHaveLength(1);
    expect(arts[0]!["captured"]).toBe(true);
    expect(arts[0]!["sourceBytes"]).toBe(buf.byteLength);
    expect(arts[0]!["sourceDigest"]).toBe(shaOf(buf));
    expect((raced.value!.bundle.summary as Record<string, unknown>)["normal"]).toEqual({ decision: "REJECT" });
    const copied = await readFile(join(raced.value!.dir, "artifacts", "normal.json"), "binary");
    expect(Buffer.from(copied, "binary").equals(buf)).toBe(true);
  });

  it("5: one failed + one successful artifact — bundle is written, success readable, failure carries its reason", async () => {
    const rec = makeRecorder("r51-5", "mixed");
    const bad = nextPath("bad.json");
    const good = nextPath("good.json");
    await writeFile(bad, Buffer.from("x".repeat(64), "utf8"));
    await writeFile(good, Buffer.from('{"ok":true}', "utf8"));
    faultTable.streams.set(bad, () => faultStream({ error: new Error("EIO: simulated") }));
    rec.registerArtifacts([{ role: "bad", path: bad }]);
    rec.registerArtifacts([{ role: "good", path: good, summarize: (x) => ({ ok: (x as Record<string, unknown>).ok }) }]);

    const raced = await settledWithin(rec.captureFailure({ stage: "diag", error: new Error("original boom") }));
    expect(raced.settled, "one bad artifact must not abort the remaining captures").toBe(true);
    if (!raced.settled) return;

    const out = raced.value!;
    const arts = artifactsOf(out.bundle);
    const badRec = arts.find((a) => a.role === "bad");
    const goodRec = arts.find((a) => a.role === "good");
    expect(badRec!["captured"]).toBe(false);
    expect(String(badRec!["error"])).toMatch(/EIO/);
    expect(goodRec!["captured"]).toBe(true);
    // the successful artifact is still readable from the bundle
    const copiedGood = await readFile(join(out.dir, "artifacts", "good.json"), "binary");
    expect(JSON.parse(Buffer.from(copiedGood, "binary").toString("utf8"))).toEqual({ ok: true });
    // and the bundle itself exists on disk
    const onDisk = JSON.parse(await readFile(join(out.dir, "diagnostic.json"), "utf8"));
    expect(onDisk.kind).toBe("e4-09-diagnostic");
  });

  it("6: the original business exception is preserved alongside the read failure", async () => {
    const rec = makeRecorder("r51-6", "original failure kept");
    const p = nextPath("eio2.json");
    await writeFile(p, Buffer.from("{}", "utf8"));
    faultTable.streams.set(p, () => faultStream({ error: new Error("EIO: simulated") }));
    rec.registerArtifacts([{ role: "eio2", path: p }]);

    const raced = await settledWithin(rec.captureFailure({ stage: "e4-09-main", error: new Error("original assertion failure") }));
    expect(raced.settled).toBe(true);
    if (!raced.settled) return;

    const fail = raced.value!.bundle.failure as Record<string, unknown>;
    expect(fail.message).toBe("original assertion failure");
    expect(fail.stage).toBe("e4-09-main");
    expect(artifactsOf(raced.value!.bundle).find((a) => a.role === "eio2")!["captured"]).toBe(false);
  });
});
