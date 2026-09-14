/**
 * E4-R40 (K01) — attribution diagnostics for the E4-09 production E2E.
 *
 * R39 recorded three Windows `buildRealChain` failures — a chain that should
 * ACCEPT was judged INVALID — and all that survived was the bare framework line
 * `expected 'INVALID' to be 'ACCEPT'`. The temp roots are deleted by `afterEach`
 * and no decision / violation / paired / V3 payload was kept, so the failure
 * could not be attributed to a mechanism.
 *
 * This module is the MINIMAL capture path. On a FAILED run it persists, BEFORE
 * any cleanup, the evidence that actually decided the outcome:
 *
 *   - test/run identity + tested SHA + working-tree identity;
 *   - OS / arch / kernel release / Node / pnpm / CPU count / total memory;
 *   - the real DecisionArtifactV3 (decision, reasonCodes, gates, statistics);
 *   - the evaluator's derived gate inputs (pairComplete / pairingViolations /
 *     incomparabilityReasons / infra failure counts);
 *   - the paired artifact's own pair accounting + per-arm status/reason/
 *     securityOutcome + the E2-09 host-mutation before/after probe records;
 *   - both V3 manifests (promotionEligible / isolationStrength / complete);
 *   - the stage timeline (which production stage the run reached).
 *
 * It NEVER runs on the success path, NEVER changes a decision or an assertion,
 * and NEVER fabricates a value: a field that could not be read is recorded as
 * `null` next to the error that prevented reading it.
 *
 * Output root (independent of the source tree, invisible to the test collector):
 *   `E4_09_DIAG_DIR` if set (CI points it at the gitignored `.ci/diagnostics`),
 *   otherwise `<os.tmpdir()>/harness-agent-e4-09-diagnostics`.
 * Each attempt gets its own `…__attempt-<n>` directory, so a retry or a second
 * run can never overwrite the previous attempt's bytes.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";

export const E4_DIAGNOSTIC_SCHEMA_VERSION = "1.0.0";

/** Per-process capture counter. Used ONLY as a human-readable "capture N"
 *  identity inside a recorder's own bundle (see `captureIdentity`); the OUTPUT
 *  DIRECTORY uniqueness NEVER depends on it. E4-R46: a module-level counter is
 *  per-process, so two independent processes with the same run ID + label both
 *  start at 1 — the directory must instead be allocated atomically (mkdtemp).
 */
let CAPTURE_SEQ = 0;

/** Per-file copy cap. A failing run wants the real payload, but an unbounded
 *  artifact must not be able to fill the disk; an over-cap file is recorded with
 *  its size + digest and a head/tail excerpt instead of the full bytes. */
const MAX_COPY_BYTES = 16 * 1024 * 1024;

export interface E4DiagStage {
  stage: string;
  ok: boolean;
  startedAtIso: string;
  durationMs: number;
  detail?: string;
}

export interface E4DiagArtifactSpec {
  /** Stable role name used as the copy filename, e.g. "decision-artifact". */
  role: string;
  /** Absolute path the production stage wrote (may not exist yet at capture). */
  path: string;
  /** Optional parser that reduces the artifact for the inline `diagnostic.json`
   *  summary. Receives the parsed JSON; must never throw (parsing is guarded). */
  summarize?: (parsed: unknown) => Record<string, unknown>;
}

export interface E4DiagGateRecord {
  label: string;
  gate: string;
  command: string[];
  exitCode: number | null;
  passed: boolean;
  state: string;
  gitSha: string | null;
  /** E4-R12 failure classification (spawn/timeout/maxBuffer/signal), if any. */
  failure: unknown;
  errorSummary: string | null;
  /** The REAL stderr/stdout captured by the runner — the whole point of R40's
   *  gate requirement (never just `expected false to be true`). */
  stderrExcerpt: string | null;
  stdoutExcerpt: string | null;
}

export interface E4DiagOptions {
  /** Short label, e.g. "e4-09-main" — the leading part of the bundle dir name. */
  label: string;
  testFile: string;
  testName: string;
  testedSha: string | null;
}

const msg = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    // A framework error crossing a worker boundary may be a null-prototype
    // object with no primitive coercion (`String(x)` would THROW). Read the
    // fields directly, then fall back to a safe structural dump.
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m !== "") return m;
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  try {
    return String(err);
  } catch {
    return "<unprintable error>";
  }
};
const errName = (err: unknown): string => {
  if (err instanceof Error) return err.name;
  if (typeof err === "object" && err !== null && typeof (err as { name?: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return typeof err;
};
const errStack = (err: unknown): string | undefined => {
  if (err instanceof Error) return err.stack;
  if (typeof err === "object" && err !== null) {
    const s = (err as { stack?: unknown }).stack;
    if (typeof s === "string") return s;
  }
  return undefined;
};
const nowIso = (): string => new Date().toISOString();

/** Keep a bounded excerpt of a potentially huge child-process log. */
function excerpt(text: string | null | undefined, maxChars = 4000): string | null {
  if (typeof text !== "string") return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

export function resolveDiagnosticRoot(): string {
  const override = process.env.E4_09_DIAG_DIR;
  if (override !== undefined && override.trim() !== "") return resolve(override.trim());
  return join(tmpdir(), "harness-agent-e4-09-diagnostics");
}

/** Read the workspace's package manager name@version without shelling out. */
function packageManagerVersion(): string | null {
  const ua = process.env.npm_config_user_agent;
  if (typeof ua === "string" && ua.includes("pnpm/")) {
    const m = /pnpm\/([^\s]+)/.exec(ua);
    if (m !== null) return m[1] ?? null;
  }
  return null;
}

/** Probe the working tree for the failure record. Errors are RETURNED, never
 *  swallowed into a fake "clean" value (the same principle E4-R41 applies to the
 *  production sentinel). */
export function captureGitFacts(cwd: string): {
  headSha: string | null;
  statusPorcelain: string | null;
  dirty: boolean | null;
  error: string | null;
} {
  try {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const statusPorcelain = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    return { headSha, statusPorcelain, dirty: statusPorcelain.trim() !== "", error: null };
  } catch (err) {
    return { headSha: null, statusPorcelain: null, dirty: null, error: msg(err) };
  }
}

export class E4DiagnosticRecorder {
  readonly runId: string;
  /** E4-R46: a per-recorder capture ordinal (human-readable only). TWO
   *  recorders with the same label + runId in the SAME process get distinct
   *  ordinals; across processes the ordinal may collide, which is fine because
   *  the OUTPUT directory is allocated atomically (mkdtemp), never by ordinal. */
  readonly captureOrdinal: number;
  /** A string uniquely identifying this recorder instance in a bundle — ties the
   *  on-disk directory back to the logical capture. */
  readonly captureIdentity: string;
  private readonly stages: E4DiagStage[] = [];
  private readonly gates: E4DiagGateRecord[] = [];
  private readonly notes: string[] = [];
  private artifactSpecs: E4DiagArtifactSpec[] = [];
  /** Free-form stage facts recorded during the run and folded into the bundle
   *  (e.g. a benchmark's real CLI exit code + output lines) — unlike `notes`
   *  these are structured values and are always persisted. */
  private readonly facts: Record<string, unknown> = {};
  private currentStage = "start";
  private capturedDirs: string[] = [];

  constructor(private readonly opts: E4DiagOptions) {
    this.captureOrdinal = ++CAPTURE_SEQ;
    const envRunId = process.env.E2E_OBSERVATION_RUN_ID;
    this.runId = envRunId !== undefined && envRunId.trim() !== "" ? envRunId.trim() : `${process.pid}-${Date.now()}`;
    this.captureIdentity = `${process.pid}-${Date.now()}-${this.captureOrdinal}`;
  }

  /** Note the stage the run is currently in (cheap; no timing bookkeeping). */
  mark(stage: string): this {
    this.currentStage = stage;
    return this;
  }

  /** Register an artifact path that a later production stage will write. Paths
   *  may not exist yet — a missing one is recorded as a fact at capture time. */
  registerArtifacts(specs: E4DiagArtifactSpec[]): this {
    this.artifactSpecs.push(...specs);
    return this;
  }

  /** Run one production stage under the recorder: on failure the stage timeline
   *  records WHERE it died before the error propagates unchanged. */
  async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.currentStage = name;
    const startedAt = Date.now();
    try {
      const out = await fn();
      this.stages.push({ stage: name, ok: true, startedAtIso: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
      return out;
    } catch (err) {
      this.stages.push({
        stage: name,
        ok: false,
        startedAtIso: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        detail: msg(err),
      });
      throw err;
    }
  }

  addNote(note: string): this {
    this.notes.push(note);
    return this;
  }

  /** Record a structured stage fact (never fabricated; overwrites same key). */
  addFact(key: string, value: unknown): this {
    this.facts[key] = value;
    return this;
  }

  /** Record a real gate child-process result, keeping its raw stderr/stdout. */
  recordGate(label: string, evidence: {
    gate: string;
    command: string[];
    exitCode: number | null;
    passed: boolean;
    state: string;
    gitSha?: string;
    failure?: unknown;
    errorSummary?: string;
  }, raw?: { stderr?: string; stdout?: string }): this {
    this.gates.push({
      label,
      gate: evidence.gate,
      command: evidence.command,
      exitCode: evidence.exitCode,
      passed: evidence.passed,
      state: evidence.state,
      gitSha: evidence.gitSha ?? null,
      failure: evidence.failure ?? null,
      errorSummary: evidence.errorSummary ?? null,
      stderrExcerpt: excerpt(raw?.stderr),
      stdoutExcerpt: excerpt(raw?.stdout),
    });
    return this;
  }

  /** Directories written so far (for the operator / CI upload path). */
  get bundles(): readonly string[] {
    return this.capturedDirs;
  }

  /**
   * Persist the failure bundle. This is called from the test's failure path
   * BEFORE `afterEach` cleans the temp roots. It is best-effort by design: a
   * capture error is reported on stderr and returned in `notes`, and NEVER
   * replaces the test's original failure.
   */
  async captureFailure(input: {
    stage?: string;
    error: unknown;
    artifacts?: E4DiagArtifactSpec[];
    /** Extra stage-specific facts to fold into the bundle. */
    extra?: Record<string, unknown>;
  }): Promise<{ dir: string; bundle: Record<string, unknown> } | null> {
    const stage = input.stage ?? this.currentStage;
    try {
      const root = resolveDiagnosticRoot();
      const osSlug = platform() === "win32" ? "windows" : platform();
      const safeRunId = this.runId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
      const safeLabel = this.opts.label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
      const prefix = join(root, `${safeLabel}__${osSlug}__${safeRunId}__`);
      // E4-R46: allocate the directory ATOMICALLY via mkdtemp. Two independent
      // processes with the same runId + label (CI: e4-r24-<os>-<run_id>) used to
      // both compute some `attempt-1` path and — because mkdir was recursive and
      // writeFile overwrites — could clobber each other's evidence. mkdtemp
      // guarantees a unique directory at creation time; the human-readable
      // `captureIdentity` (pid-timestamp-ordinal) is carried INSIDE the bundle,
      // not used to name the directory. The `attempt-` suffix is retained purely
      // for stable ordering/readability in listings, never for uniqueness.
      // E4-R46 (fixup): `mkdtemp` does NOT create the parent directory. On CI
      // `E4_09_DIAG_DIR` points at `.ci/diagnostics` (only `mkdir -p .ci` ran),
      // so `mkdtemp(prefix)` fails ENOENT if the root does not exist yet. Make
      // the root first (recursive + idempotent), then allocate the unique leaf.
      await mkdir(root, { recursive: true });
      const dir = await mkdtemp(prefix);
      await mkdir(join(dir, "artifacts"), { recursive: true });

      const artifactRecords: Array<Record<string, unknown>> = [];
      const summaries: Record<string, Record<string, unknown> | null> = {};
      const specs = [...this.artifactSpecs, ...(input.artifacts ?? [])];
      for (const spec of specs) {
        const rec: Record<string, unknown> = { role: spec.role, sourcePath: spec.path };
        const read = await readArtifact(spec.path);
        if (!read.ok) {
          rec["captured"] = false;
          rec["error"] = read.error;
          artifactRecords.push(rec);
          summaries[spec.role] = null;
          continue;
        }
        rec["captured"] = true;
        // E4-R47: report the SOURCE bytes and the source digest (raw bytes,
        // streamed over the whole file), then the retained-head bytes and the
        // head digest (over exactly the bytes we copy) — a digest is never a
        // single field with two meanings.
        rec["sourceBytes"] = read.sourceBytes;
        rec["sourceDigest"] = read.sourceDigest;
        const name = `${spec.role}${extOf(spec.path)}`;
        const target = join(dir, "artifacts", name);
        if (read.truncated === true) {
          // E4-R47: copy ONLY the bounded head BYTES (byte-accurate: headBytes
          // is the cap, headDigest is over exactly those bytes). The copy is
          // bounded by the cap, NOT by character count; an over-cap file's full
          // body is never JSON.parsed (see parseError below).
          if (read.headBuf !== undefined) {
            await writeFile(target, read.headBuf, "binary");
          }
          rec["truncated"] = true;
          rec["sourceBytes"] = read.sourceBytes;
          rec["headBytes"] = read.headBytes;
          rec["headDigest"] = read.headDigest;
          rec["capturedPath"] = join("artifacts", name);
        } else {
          // Small file: write the verbatim bytes; digest stays the source digest.
          const text = read.headText ?? "";
          await writeFile(target, text, "utf8");
          rec["truncated"] = false;
          rec["headBytes"] = read.headBytes;
          rec["headDigest"] = read.headDigest;
          rec["capturedPath"] = join("artifacts", name);
        }
        // Reduce for the inline summary; parsing a body is always guarded. For a
        // TRUNCATED artifact we do NOT JSON.parse the whole source — the head is
        // not a valid JSON body, so a parse is skipped and the reason noted.
        if (read.truncated === true) {
          rec["parseError"] = "source truncated — body exceeds MAX_COPY_BYTES; full JSON.parse skipped (bounded capture)";
          summaries[spec.role] = null;
        } else {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(read.headText ?? "");
          } catch (err) {
            rec["parseError"] = msg(err);
          }
          if (parsed !== null && spec.summarize !== undefined) {
            try {
              summaries[spec.role] = spec.summarize(parsed);
            } catch (err) {
              summaries[spec.role] = { summarizeError: msg(err) };
            }
          } else if (parsed !== null) {
            summaries[spec.role] = null;
          }
        }
        artifactRecords.push(rec);
      }

      const bundle: Record<string, unknown> = {
        schemaVersion: E4_DIAGNOSTIC_SCHEMA_VERSION,
        kind: "e4-09-diagnostic",
        capturedAtIso: nowIso(),
        label: this.opts.label,
        captureOrdinal: this.captureOrdinal,
        captureIdentity: this.captureIdentity,
        ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        runId: this.runId,
        test: { file: this.opts.testFile, name: this.opts.testName, frameworkStateAtCapture: "failing" },
        environment: {
          platform: platform(),
          arch: arch(),
          kernelRelease: release(),
          nodeVersion: process.version,
          pnpmVersion: packageManagerVersion(),
          cpuCount: cpus().length,
          totalMemoryBytes: totalmem(),
          cwd: process.cwd(),
          ci: process.env.CI === "true" || process.env.CI === "1",
          // NEVER the full env: only the class of run, no secrets.
          observationRunId: process.env.E2E_OBSERVATION_RUN_ID ?? null,
        },
        source: {
          testedSha: this.opts.testedSha,
          ...captureGitFacts(process.cwd()),
        },
        failure: {
          stage,
          name: errName(input.error),
          message: msg(input.error),
          stack: excerpt(errStack(input.error), 6000),
        },
        stages: [...this.stages],
        summary: summaries,
        artifacts: artifactRecords,
        gateEvidence: [...this.gates],
        extra: { ...this.facts, ...(input.extra ?? {}) },
        notes: [...this.notes],
      };

      const bundlePath = join(dir, "diagnostic.json");
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      this.capturedDirs.push(dir);
      return { dir, bundle };
    } catch (err) {
      // A capture failure must never mask the original test failure.
      const note = `e4-09 diagnostic capture failed at stage "${stage}": ${msg(err)}`;
      this.notes.push(note);
      process.stderr.write(`[degraded] ${note}\n`);
      return null;
    }
  }
}

/**
 * E4-R47 — bounded, byte-conscious artifact read.
 *
 * The old path read the WHOLE file into memory, then base64'd / trimmed by CHAR
 * count and hashed the decoded text — so a huge artifact's memory use grew
 * linearly with the file, an over-cap trim was not byte-accurate, and the digest
 * was over the UTF-8 text, not the source bytes.
 *
 * This is the MINIMAL bounded read: a single streaming pass.
 *   - `sourceBytes` / `sourceDigest` are computed over the WHOLE source file's
 *     raw bytes via a read stream (streamed sha256 — memory does NOT grow with
 *     the file; only the bounded head is materialized).
 *   - `headBytes` / `headDigest` cover ONLY the bytes we actually copy to the
 *     bundle (`MAX_COPY_BYTES` head), so "the digest of what we kept" is a
 *     distinct, true fact — it is never conflated with the source digest.
 *   - `truncated: true` when the source is larger than the cap (head only);
 *   - a parse is attempted ONLY when the full body fit (not truncated), so an
 *     over-cap file is never JSON.parsed as a whole.
 */
interface BoundedRead {
  ok: boolean;
  error?: string;
  /** Full source size in bytes (accurate for both small and huge files). */
  sourceBytes?: number;
  /** sha256 over the FULL source's raw bytes (streamed). */
  sourceDigest?: string;
  /** The bytes we actually hold / copy (≤ MAX_COPY_BYTES head). */
  headBytes?: number;
  /** sha256 over `headBytes` ONLY (the copy we keep, not the whole source). */
  headDigest?: string;
  /** true when the source exceeded the cap and we only kept the head. */
  truncated?: boolean;
  /** The retained head as a string (only meaningful when not truncated, and
   *  only used to write the small-file copy verbatim / parse an in-budget body). */
  headText?: string;
  /** E4-R47: the retained head BYTES (only set when truncated) so the caller
   *  can write the bounded copy byte-for-byte. */
  headBuf?: Buffer;
}

async function readArtifact(path: string): Promise<BoundedRead> {
  // E4-R47 (F/G): stat FIRST so a missing path (ENOENT) or a directory (EISDIR)
  // fails DETERMINISTICALLY. Opening a read stream on a directory can hang on
  // some platforms (no data, no 'end', no 'error'), and a missing file must be
  // a recorded fact, not an unresolved promise.
  let size = 0;
  try {
    const st = await stat(path);
    size = st.size;
    if (st.isDirectory()) {
      return { ok: false, error: "EISDIR: path is a directory, not a file" };
    }
    if (!st.isFile()) {
      return { ok: false, error: "path is not a regular file" };
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return { ok: false, error: msg(err) };
    return { ok: false, error: msg(err) };
  }
  // E4-R47: cap the HEAD buffer allocation to the copy cap (already bounded).
  const cap = Math.min(MAX_COPY_BYTES, size);
  return new Promise((resolvePromise) => {
    let stream: import("node:fs").ReadStream;
    try {
      stream = createReadStream(path);
    } catch (err) {
      resolvePromise({ ok: false, error: msg(err) });
      return;
    }
    // E4-R51 (F51) — ONE settle-once completion protocol.
    //
    // Pre-R51 the promise resolved ONLY from `stream.on("end")`, while the error
    // handler merely recorded the message and called `stream.destroy()`. A
    // destroyed stream never emits `end`, so any read error that occurs AFTER a
    // successful `stat` — i.e. every error `stat` cannot intercept (EIO, a
    // mid-stream failure, a delete racing the open) — left this promise pending
    // forever. Because `captureFailure` awaits this per registered artifact, the
    // failure-forensics path itself hung and the test's `afterEach` never ran.
    //
    // Every terminal event now has an explicit, once-only outcome:
    //   'error' -> structured read failure carrying the real error;
    //   'end'   -> success (or the recorded error, if one arrived first);
    //   'close' -> arriving BEFORE 'end' is a FAILURE (premature close), never a
    //              silent success;
    //   'close' AFTER 'end'/'error' is a no-op, so the stream's own teardown can
    //   never flip an already-successful capture into a failure.
    // This is a completion protocol, not a timeout: nothing waits on wall-clock
    // time and no error is swallowed.
    let settled = false;
    const srcHash = createHash("sha256");
    const headBuf = Buffer.alloc(cap);
    let headUsed = 0;
    let total = 0;
    let readError: string | undefined;

    function settle(result: BoundedRead): void {
      if (settled) return;
      settled = true;
      // Release the listeners this read owns. The 'error' listener is REPLACED
      // by a no-op guard rather than removed: a late error on the torn-down
      // stream would otherwise be an unhandled 'error' event and crash the
      // process (Node throws when 'error' has no listener).
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
      stream.on("error", () => {});
      resolvePromise(result);
    }
    function fail(error: string): void {
      if (settled) return;
      settle({ ok: false, error });
      if (!stream.destroyed) stream.destroy();
    }
    function onData(chunk: Buffer): void {
      srcHash.update(chunk);
      total += chunk.length;
      if (headUsed < cap) {
        const want = Math.min(cap - headUsed, chunk.length);
        chunk.copy(headBuf, headUsed, 0, want);
        headUsed += want;
      }
    }
    function onError(err: unknown): void {
      if (settled) return;
      readError = msg(err);
      fail(readError);
    }
    function onEnd(): void {
      if (readError !== undefined) {
        fail(readError);
        return;
      }
      const truncated = total > MAX_COPY_BYTES;
      const head = headBuf.subarray(0, headUsed);
      const headText = truncated ? undefined : head.toString("utf8");
      const headDigest = createHash("sha256").update(head).digest("hex");
      const out: BoundedRead = {
        ok: true,
        sourceBytes: total,
        sourceDigest: srcHash.digest("hex"),
        headBytes: headUsed,
        headDigest,
        truncated,
        ...(headText !== undefined ? { headText } : {}),
      };
      if (truncated) {
        // E4-R47: keep the actual head BYTES so the caller can write the bounded
        // copy byte-for-byte (a digest alone cannot reconstruct the copy).
        out.headBuf = Buffer.from(head);
      }
      settle(out);
    }
    function onClose(): void {
      if (settled) return; // close after 'end'/'error' — never a re-decision
      if (readError !== undefined) {
        fail(readError);
        return;
      }
      fail("stream closed before 'end' (premature close) — artifact read did not complete");
    }

    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("end", onEnd);
    stream.on("close", onClose);
  });
}

function extOf(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : ".json";
}

// ---------------------------------------------------------------------------
// Reusable summarizers for the artifacts R40 must explain
// ---------------------------------------------------------------------------

/** Reduce a DecisionArtifactV3 body to the fields that decide the outcome. */
export function summarizeDecisionArtifact(parsed: unknown): Record<string, unknown> {
  const d = (parsed ?? {}) as Record<string, unknown>;
  return {
    decision: d["decision"] ?? null,
    reasonCodes: d["reasonCodes"] ?? null,
    gates: d["gates"] ?? null,
    statistics: d["statistics"] ?? null,
    perRepetitionDeltas: d["perRepetitionDeltas"] ?? null,
    repetitions: d["repetitions"] ?? null,
    contentDigest: d["contentDigest"] ?? null,
    policyVersion: d["policyVersion"] ?? null,
    evaluatorVersion: d["evaluatorVersion"] ?? null,
  };
}

/** Reduce a paired-experiment artifact to its pair accounting + the per-arm
 *  facts that explain an infrastructure/invalid arm, INCLUDING the E2-09
 *  sentinel's own before/after probe records (R40's whole point: the post-run
 *  `git status` reread is not the same observation). */
export function summarizePairedArtifact(parsed: unknown): Record<string, unknown> {
  const a = (parsed ?? {}) as Record<string, unknown>;
  const arm = (rec: unknown): Record<string, unknown> | null => {
    if (rec === null || typeof rec !== "object") return null;
    const r = rec as Record<string, unknown>;
    const outcome = (r["outcome"] ?? {}) as Record<string, unknown>;
    return {
      armId: (r["arm"] as Record<string, unknown> | undefined)?.["armId"] ?? null,
      valid: r["valid"] ?? null,
      status: outcome["status"] ?? null,
      actualStatus: outcome["actualStatus"] ?? null,
      failureCategory: outcome["failureCategory"] ?? null,
      reason: outcome["reason"] ?? null,
      securityOutcome: outcome["securityOutcome"] ?? null,
      hostMutation: outcome["hostMutation"] ?? null,
    };
  };
  const finalized = Array.isArray(a["finalizedPairs"]) ? (a["finalizedPairs"] as unknown[]) : [];
  const partial = Array.isArray(a["partialPairs"]) ? (a["partialPairs"] as unknown[]) : [];
  return {
    complete: a["complete"] ?? null,
    promotionEligible: a["promotionEligible"] ?? null,
    isolationStrength: a["isolationStrength"] ?? null,
    incompleteReason: a["incompleteReason"] ?? null,
    haltedByBudget: a["haltedByBudget"] ?? null,
    interrupted: a["interrupted"] ?? null,
    counters: a["counters"] ?? null,
    finalizedPairCount: finalized.length,
    partialPairCount: partial.length,
    partialPairs: partial.map((p) => ({
      pairId: (p as Record<string, unknown>)["pairId"] ?? null,
      caseId: (p as Record<string, unknown>)["caseId"] ?? null,
      repetition: (p as Record<string, unknown>)["repetition"] ?? null,
      reason: (p as Record<string, unknown>)["reason"] ?? null,
      baseline: arm((p as Record<string, unknown>)["baseline"]),
      candidate: arm((p as Record<string, unknown>)["candidate"]),
    })),
    finalizedPairs: finalized.map((p) => ({
      pairId: (p as Record<string, unknown>)["pairId"] ?? null,
      caseId: (p as Record<string, unknown>)["caseId"] ?? null,
      repetition: (p as Record<string, unknown>)["repetition"] ?? null,
      baseline: arm((p as Record<string, unknown>)["baseline"]),
      candidate: arm((p as Record<string, unknown>)["candidate"]),
    })),
  };
}

/** Reduce a V3 experiment artifact to its manifest identity + outcome tally. */
export function summarizeV3Artifact(parsed: unknown): Record<string, unknown> {
  const a = (parsed ?? {}) as Record<string, unknown>;
  const manifest = (a["manifest"] ?? {}) as Record<string, unknown>;
  const outcomes = Array.isArray(a["outcomes"]) ? (a["outcomes"] as unknown[]) : [];
  const passed = outcomes.filter((o) => (o as Record<string, unknown>)["passed"] === true).length;
  return {
    promotionEligible: manifest["promotionEligible"] ?? null,
    isolationStrength: manifest["isolationStrength"] ?? null,
    complete: manifest["complete"] ?? null,
    incompleteReason: manifest["incompleteReason"] ?? null,
    gitSha: manifest["gitSha"] ?? null,
    dirty: manifest["dirty"] ?? null,
    candidateId: manifest["candidateId"] ?? null,
    outcomeCount: outcomes.length,
    passedCount: passed,
    failedCount: outcomes.length - passed,
  };
}
