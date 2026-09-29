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
 * R0/S1 (F1) — THE TOOL-DISPATCH BUDGET RPC
 * -----------------------------------------
 * The campaign's durable tool cap lives in the PARENT process (one `CostBudget`,
 * one journal). The arm's `ToolOrchestrator`, however, is constructed INSIDE this
 * child, so the budget capability must cross the process boundary. It cannot be
 * serialized: its `reserve()`/`settle()` are methods.
 *
 * The child therefore exports it as a VERSIONED RPC, using the SAME multiplexed
 * stdio channel as the model proxy:
 *
 *   child → parent  {"t":"tool_reserve","id":N,"armRunId":…,"request":{…}}
 *   parent → child  {"t":"tool_grant","id":N,"ok":true,"reservationId":…}
 *                   {"t":"tool_grant","id":N,"ok":false,"reason":"…"}
 *   child → parent  {"t":"tool_settle","id":N,"reservationId":…,"outcome":"…"}
 *   parent → child  {"t":"tool_settled","id":N}
 *                   {"t":"tool_error","id":N,"message":"…"}
 *
 * `id` is a single counter shared with the model proxy, so every frame on the
 * wire carries a UNIQUE correlation id and the router can never confuse a model
 * event with a budget reply.
 *
 * ABI HANDSHAKE (plan §5.6). Before the child runs ANY arm code — and therefore
 * before the first model request — it announces the capability list the ARM
 * BUILD itself declares (`R97_ARM_ABI`) and WAITS for the driver's verdict:
 *
 *   child → parent  {"t":"hello","abi":[…],"entrySha256":…,"probe":…}
 *   parent → child  {"t":"proceed"} | {"t":"abort","reason":"…"}
 *
 * A build with no `R97_ARM_ABI` export reports `[]`, which the driver refuses
 * with `ARM_WORKER_ABI_UNSUPPORTED` before a single model request leaves. The
 * handshake runs ONLY when the driver asked for it (`runOptions.toolBudgetRpc`),
 * so a non-formal caller keeps the legacy straight-to-work protocol.
 *
 * CONTRACT. stdin: line 1 is the options JSON; every later line is a parent
 * frame. stdout: optionally one `hello` frame, then zero or more `request` /
 * `tool_reserve` / `tool_settle` frames, then EXACTLY one
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

/** R0/S1 — the versioned ABI-capability export a budget-aware arm build carries.
 *  A build without it is an OLD-ABI arm and is reported as `[]`. */
const ARM_ABI_EXPORT = "R97_ARM_ABI";

/** R0/S1 — the capability the formal budgeted path requires. */
const ARM_ABI_TOOL_BUDGET = "tool-budget-rpc-v1";

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

/** A per-correlation-id mailbox of parent frames. */
function createMailbox() {
  const queued = [];
  let resolveNext = null;
  let closed = false;
  return {
    push(frame) {
      if (resolveNext !== null) {
        const r = resolveNext;
        resolveNext = null;
        r(frame);
        return;
      }
      queued.push(frame);
    },
    close() {
      closed = true;
      if (resolveNext !== null) {
        const r = resolveNext;
        resolveNext = null;
        r(null);
      }
    },
    next() {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((r) => {
        resolveNext = r;
      });
    },
  };
}

/**
 * R0/S1 — the SINGLE stdout-frame router. Every RPC (a model call, a tool
 * reservation, a tool settlement, the ABI handshake) opens a mailbox under a
 * unique correlation id; the pump delivers each frame to that mailbox and never
 * to anyone else's. A frame whose id has no live mailbox is a LATE frame of an
 * already-terminated request and is dropped — it can never be mistaken for the
 * reply to the request that replaced it.
 */
function createFrameRouter(reader) {
  const mailboxes = new Map();
  const pump = (async () => {
    for (;;) {
      const line = await reader.next();
      if (line === null) break;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // a non-frame line (a stray log) is ignored, never parsed as a frame
      }
      if (frame === null || typeof frame !== "object") continue;
      const box = mailboxes.get(frame.id);
      if (box === undefined) continue;
      box.push(frame);
    }
    for (const box of mailboxes.values()) box.close();
    mailboxes.clear();
  })();
  return {
    open(id) {
      const box = createMailbox();
      mailboxes.set(id, box);
      return box;
    },
    close(id) {
      const box = mailboxes.get(id);
      if (box === undefined) return;
      mailboxes.delete(id);
      box.close();
    },
    settled: () => pump,
  };
}

/**
 * The proxy provider: it owns no transport. Every `generate()` becomes one
 * `request` frame; the driver answers with `event` frames until `completed`.
 * A concurrent request is refused — the driver services one call at a time and
 * a second in-flight call would make the physical-call count ambiguous.
 */
function createProxyProvider(router, write, budget) {
  return {
    id: "prereg-isolated-proxy",
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate(request, _signal) {
          if (budget.modelInFlight) {
            throw new Error("PREREG_WORKER_CONCURRENCY: the isolated worker services one model call at a time");
          }
          budget.modelInFlight = true;
          const id = budget.nextId++;
          const box = router.open(id);
          budget.calls += 1;
          try {
            write({ t: "request", id, request });
            for (;;) {
              const frame = await box.next();
              if (frame === null) throw new Error("PREREG_WORKER_EOF: the driver closed the channel mid-call");
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
            router.close(id);
            budget.modelInFlight = false;
          }
        },
      };
    },
  };
}

/**
 * R0/S1 — the proxy TOOL-DISPATCH budget. It implements the structural
 * `ToolDispatchBudget` `packages/tools` declares, but every reservation is
 * decided by the PARENT's one durable `CostBudget`: this child holds no quota,
 * opens no budget file and reads no allowance from the environment.
 *
 * `reserve()` returning `ok: false` is the campaign cap or deadline refusing the
 * dispatch BEFORE the tool body runs — exactly the semantics the parent's
 * `DurableToolDispatchBudget` already implements.
 */
function createProxyToolBudget(router, write, budget, armRunId) {
  return {
    async reserve(request) {
      const id = budget.nextId++;
      const box = router.open(id);
      budget.reserves += 1;
      try {
        write({ t: "tool_reserve", id, armRunId, request });
        const frame = await box.next();
        if (frame === null) throw new Error("PREREG_WORKER_EOF: the driver closed the channel during a tool reservation");
        if (frame.t === "tool_error") throw new Error(`PREREG_WORKER_BUDGET_ERROR: ${frame.message}`);
        if (frame.t !== "tool_grant") {
          throw new Error(`PREREG_WORKER_BUDGET_PROTOCOL: expected a tool_grant frame, received ${String(frame.t)}`);
        }
        if (frame.ok !== true) {
          return { ok: false, ...(frame.reason ? { reason: frame.reason } : {}), async settle() {} };
        }
        const reservationId = frame.reservationId;
        let settled = false;
        return {
          ok: true,
          async settle(outcome) {
            // Idempotent on BOTH sides: the orchestrator settles once, and a
            // duplicate would be ignored by the parent anyway.
            if (settled) return;
            settled = true;
            const sid = budget.nextId++;
            const sbox = router.open(sid);
            budget.settles += 1;
            try {
              write({ t: "tool_settle", id: sid, armRunId, reservationId, outcome });
              const ack = await sbox.next();
              if (ack !== null && ack.t === "tool_error") {
                throw new Error(`PREREG_WORKER_BUDGET_ERROR: ${ack.message}`);
              }
            } finally {
              router.close(sid);
            }
          },
        };
      } finally {
        router.close(id);
      }
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
    // The options line is read BEFORE the router is created: the router's pump
    // consumes stdin continuously, so creating it first would swallow the very
    // line that carries the case and the checkout.
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

  // R0/S1 — ONE router and ONE counter, shared by the model proxy, the
  // tool-budget RPC and the ABI handshake, so every frame on the wire carries a
  // unique correlation id.
  const router = createFrameRouter(reader);
  const budget = { calls: 0, reserves: 0, settles: 0, nextId: 1, modelInFlight: false };
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
    // R0/S1 — the ARM BUILD's OWN declared capability list. A build predating the
    // budget RPC has no such export and reports `[]`, which the driver refuses.
    const declaredAbi = armBuild[ARM_ABI_EXPORT];
    const abi = Array.isArray(declaredAbi) ? declaredAbi.filter((c) => typeof c === "string") : [];

    const runOptions = { ...(opts.runOptions ?? {}) };
    const wantsBudgetRpc = runOptions.toolBudgetRpc === true;
    // The driver-facing flag is a transport instruction, not an arm input: the
    // arm build sees only the real `toolBudget` capability.
    delete runOptions.toolBudgetRpc;

    if (wantsBudgetRpc) {
      // THE CAPABILITY PRE-CHECK. This runs BEFORE any arm code and before the
      // first model request; the driver answers `proceed` or `abort`.
      const hid = budget.nextId++;
      const hbox = router.open(hid);
      try {
        write({ t: "hello", id: hid, abi, entrySha256, probe });
        const verdict = await hbox.next();
        if (verdict === null) {
          throw Object.assign(new Error("the driver closed the channel during the ABI handshake"), {
            code: "PREREG_WORKER_ABI_REFUSED",
          });
        }
        if (verdict.t !== "proceed") {
          throw Object.assign(new Error(verdict.reason ?? "the driver refused this arm build's ABI"), {
            code: "PREREG_WORKER_ABI_REFUSED",
          });
        }
      } finally {
        router.close(hid);
      }
      runOptions.toolBudget = createProxyToolBudget(router, write, budget, opts.armRunId ?? "");
    }

    const caseDef = opts.case;
    const provider = createProxyProvider(router, write, budget);
    const outcome = await armBuild.runOneCase(caseDef, { ...runOptions, provider }, caseDef.suite ?? "regression");
    result.ok = true;
    delete result.code;
    delete result.error;
    result.armBuildReport = { entryRel: ARM_ENTRY_REL, entrySha256, probe, abi };
    result.outcome = outcome;
    result.proxyBudget = { modelCalls: budget.calls, toolReserves: budget.reserves, toolSettles: budget.settles };
  } catch (err) {
    result.ok = false;
    result.code = err && err.code ? err.code : "PREREG_WORKER_FAILED";
    result.error = err instanceof Error ? err.message : String(err);
    result.armBuildReport = null;
    result.proxyBudget = { modelCalls: budget.calls, toolReserves: budget.reserves, toolSettles: budget.settles };
  }

  process.stdout.write(`${SENTINEL}${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

await main();
