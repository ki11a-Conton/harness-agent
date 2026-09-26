/**
 * B3 — the ISOLATED ARM WORKER for the v2 pre-registered paired campaign.
 *
 * MEASURED GAP (G1, plan(20260926-070459).md §G1):
 *
 *   "两个不同摘要不等于两份冻结构建确实分别运行" — `createPreregArmExecutor`
 *   computed two checkout digests and then ran the DRIVER process's own
 *   `runOneCase` with a `candidate` flag. The arm's own frozen build was never
 *   loaded, so the two arms were ONE build under two names.
 *
 * This file is the child half of the fix. The DRIVER spawns it once per arm-run
 * and hands it, on stdin, the ONE case to execute plus the arm checkout it must
 * load. The child then:
 *
 *   1. loads `apps/cli/dist/benchmark-command.js` FROM ITS OWN CHECKOUT (the
 *      arm's real build — never the driver's), reads the versioned mechanism
 *      probe that build exports, and hashes the entry bytes it actually loaded;
 *   2. runs the ONE case through THAT build's own `runOneCase`, resolving every
 *      model request through a stdio PROXY back to the driver's provider.
 *
 * WHY A PROXY, NOT A PROVIDER (plan §B3 怎么做 3 + 怎么验收):
 *
 *   "不在 worker 内重新读环境密钥或创建第二个未经预算的 provider" and
 *   "每次可能出网的 worker 请求都经 B2 的可计数同一预算渠道".
 *
 * The child therefore owns NO provider and reads NO key. Every `generate()` it
 * needs is a request frame on stdout; the DRIVER services it with the ONE
 * budget-wrapped provider (the A4/B2 channel) and streams the events back. The
 * physical call count is measured WHERE THE CALL REALLY HAPPENS — the driver —
 * so a worker cannot inflate or hide it.
 *
 * CONTRACT. stdin: line 1 is the options JSON; every later line is a parent
 * frame. stdout: zero or more `{"t":"request",...}` frames, then EXACTLY one
 * `__PREREG_ARM_RESULT__<json>` line. The sentinel keeps a stray `console.log`
 * from a third-party module from being parsed as the result. A child killed
 * mid-case reports NO result — the driver classifies the arm from the STOP.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SENTINEL = "__PREREG_ARM_RESULT__";

/** The arm's declared CLI entry, relative to its checkout (POSIX form: this is
 *  the DECLARED identity the driver compares against `R97_ARM_BUILD_ENTRIES`,
 *  and `path.join` accepts forward slashes on Windows too). */
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";

/** The versioned mechanism-probe export every real arm build must carry. */
const ARM_PROBE_EXPORT = "R97_ARM_PROBE";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(code, message) {
  return { ok: false, code, error: message };
}

/** A line-delimited reader over stdin that never loses a frame. */
function createLineReader(stream) {
  let buffer = "";
  const queued = [];
  const waiters = [];
  let ended = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      if (waiters.length > 0) waiters.shift()(line);
      else queued.push(line);
    }
  });
  stream.on("end", () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()(null);
  });
  stream.on("error", () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()(null);
  });
  return {
    next() {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/**
 * The proxy provider: it owns no transport. Every `generate()` becomes one
 * `request` frame; the driver answers with `event` frames until `completed`.
 * A concurrent request is refused — the driver services one call at a time and
 * a second in-flight call would make the physical-call count ambiguous.
 */
function createProxyProvider(reader, write, budget) {
  let nextId = 1;
  let inFlight = false;
  return {
    id: "prereg-isolated-proxy",
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate(request, _signal) {
          if (inFlight) {
            throw new Error("PREREG_WORKER_CONCURRENCY: the isolated worker services one model call at a time");
          }
          inFlight = true;
          const id = nextId++;
          budget.calls += 1;
          try {
            write({ t: "request", id, request });
            for (;;) {
              const line = await reader.next();
              if (line === null) throw new Error("PREREG_WORKER_EOF: the driver closed the channel mid-call");
              let frame;
              try {
                frame = JSON.parse(line);
              } catch {
                continue; // a non-frame line (a stray log) is ignored, never parsed as an event
              }
              if (frame === null || typeof frame !== "object" || frame.id !== id) continue;
              if (frame.t === "event") {
                yield frame.event;
                if (frame.event?.type === "completed" || frame.event?.type === "error") return;
              } else if (frame.t === "done") {
                return;
              } else if (frame.t === "error") {
                throw new Error(`PREREG_WORKER_PROVIDER_ERROR: ${frame.message}`);
              }
            }
          } finally {
            inFlight = false;
          }
        },
      };
    },
  };
}

async function main() {
  const reader = createLineReader(process.stdin);
  const write = (frame) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  };

  const result = { ok: false, code: "PREREG_WORKER_NO_RESULT", error: "the worker produced no result" };
  let opts = null;
  try {
    const first = await reader.next();
    if (first === null) {
      process.stdout.write(`${SENTINEL}${JSON.stringify(fail("PREREG_WORKER_NO_OPTIONS", "no options were supplied on stdin"))}\n`);
      process.exitCode = 1;
      return;
    }
    opts = JSON.parse(first);
  } catch (err) {
    process.stdout.write(
      `${SENTINEL}${JSON.stringify(fail("PREREG_WORKER_BAD_OPTIONS", `options are not valid JSON: ${err instanceof Error ? err.message : String(err)}`))}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const budget = { calls: 0 };
  try {
    const checkoutDir = opts.checkoutDir;
    if (typeof checkoutDir !== "string" || checkoutDir === "") {
      throw Object.assign(new Error("no checkout directory was supplied"), { code: "PREREG_WORKER_NO_CHECKOUT" });
    }
    const entryPath = join(checkoutDir, ARM_ENTRY_REL);
    try {
      if (!statSync(entryPath).isFile()) throw new Error("not a file");
    } catch {
      throw Object.assign(new Error(`the arm's own build entry ${ARM_ENTRY_REL} is not a readable file in its checkout`), {
        code: "PREREG_WORKER_ENTRY_MISSING",
      });
    }
    const entryBytes = readFileSync(entryPath, "utf8");
    const entrySha256 = sha256Hex(entryBytes);

    const armBuild = await import(pathToFileURL(entryPath).href);
    if (typeof armBuild.runOneCase !== "function") {
      throw Object.assign(new Error(`the arm build ${ARM_ENTRY_REL} does not export runOneCase`), {
        code: "PREREG_WORKER_RUN_CASE_MISSING",
      });
    }
    const probe = armBuild[ARM_PROBE_EXPORT];
    if (typeof probe !== "string" || probe.length === 0) {
      throw Object.assign(new Error(`the arm build ${ARM_ENTRY_REL} does not export a non-empty ${ARM_PROBE_EXPORT}`), {
        code: "PREREG_WORKER_PROBE_MISSING",
      });
    }

    const caseDef = opts.case;
    const provider = createProxyProvider(reader, write, budget);
    const outcome = await armBuild.runOneCase(caseDef, { ...(opts.runOptions ?? {}), provider }, caseDef.suite ?? "regression");
    result.ok = true;
    delete result.code;
    delete result.error;
    result.armBuildReport = { entryRel: ARM_ENTRY_REL, entrySha256, probe };
    result.outcome = outcome;
    result.proxyBudget = { modelCalls: budget.calls };
  } catch (err) {
    result.ok = false;
    result.code = err && err.code ? err.code : "PREREG_WORKER_FAILED";
    result.error = err instanceof Error ? err.message : String(err);
    result.armBuildReport = null;
  }

  process.stdout.write(`${SENTINEL}${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

await main();