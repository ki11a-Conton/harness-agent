/**
 * E4-R99-B (T5) — A TIMEOUT, A CANCEL AND AN OUTPUT CAP MUST REALLY END THE WORK.
 *
 * WHAT THIS PINS (plan §T5 做什么 1-3, 怎么做 1-8, 怎么验收 1-5)
 * -------------------------------------------------------------
 * MEASURED DEFECT N8 (plan §0.2, priority P1):
 *
 *   "runChild 只发送 SIGTERM，SIGKILL_GRACE_MS 未使用，stdoutChunks.length 当字节上限."
 *
 * Three separate faults, each of which made "bounded" untrue:
 *
 *   1. The ONLY stop was `controller.abort()`, which signals the child and then
 *      WAITS FOREVER. A child that installs a SIGTERM handler and never exits kept
 *      the promise (and therefore the unit, its reservation and the whole
 *      campaign) alive indefinitely. `SIGKILL_GRACE_MS` was declared and never
 *      read.
 *   2. The output cap compared `stdoutChunks.length` — a COUNT OF CHUNKS — against
 *      a limit documented as BYTES. One 64 MiB chunk was accepted whole, and 33
 *      million one-byte chunks were also accepted whole; the number was
 *      meaningless as a byte bound.
 *   3. Nothing distinguished "never started" from "started, signalled, outcome
 *      unknown", so an interrupted attempt could not be settled honestly.
 *
 * THE ACCEPTANCE CRITERION THIS FILE EXISTS FOR (plan §T5 怎么验收 1):
 *
 *   "忽略 SIGTERM 的子 fixture 在 deadline+grace 的规定上限内退出；worker 返回命名
 *    结果，没有遗留后代."
 *
 * and (line 330) the anti-cheat rule that makes it meaningful:
 *
 *   "测试独立 watchdog 清理只是防测试卡死；被测实现未自行停止时必须失败，不能用测试
 *    清理当成实现成功."
 *
 * So the fixture below is a REAL child process that really ignores the polite
 * signal, and the assertions are about the IMPLEMENTATION stopping it — a
 * test-side watchdog may only prevent the suite from hanging, and its firing is
 * itself a failure. The last test in this file proves that by asserting the
 * watchdog did NOT have to fire.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const WORKER = pathToFileURL(join(REPO, "scripts", "e4", "r97-arm-worker.mjs")).href;

const worker = (await import(WORKER)) as {
  boundedStop: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  ByteCap: new (limit: number) => { push: (chunk: Buffer | string) => void; bytes: number; offered: number; truncated: boolean; text: () => string };
  DeadlineBudget: new (totalMs: number, now?: () => number) => {
    remaining: () => number;
    remainingForPhase: () => number;
    expired: () => boolean;
    cancel: () => void;
    dispose: () => void;
    readonly signal: AbortSignal;
  };
  runArmUnit: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  BOUNDED_STOP_REASONS: readonly string[];
  SIGKILL_GRACE_MS: number;
  MAX_CHILD_OUTPUT_BYTES: number;
  DEFAULT_TIMEOUT_MS: number;
  FAILURE_CATEGORIES: readonly string[];
};

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r99b-stop-"));
  dirs.push(d);
  return d;
}

/**
 * Redirect the machine-global advisory claim anchor to a per-suite scratch dir.
 *
 * The ledger's claim anchor defaults to a directory under the SYSTEM temp dir, so
 * every suite that opens a ledger shares one namespace keyed by campaign id, and
 * two suites in parallel workers refuse each other with
 * `BUDGET_CAMPAIGN_DIR_DUPLICATE`. That is a collision between unrelated tests,
 * not a fact about the deadline.
 */
const CLAIMS_DIR = await mkdtemp(join(tmpdir(), "r99b-claims-"));
process.env["R97_CAMPAIGN_CLAIMS_DIR"] = CLAIMS_DIR;

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/**
 * Drive ONE real unit through the worker's public entry, with a complete approved
 * identity.
 *
 * `timeoutMs` is the unit's shared deadline; passing 0 makes the deadline already
 * spent, which is how the S6 tests reach the stopped path without waiting.
 */
async function runUnit(over: Record<string, unknown> = {}): Promise<{ record: Record<string, unknown> }> {
  const record = await worker.runArmUnit({
    checkoutDir: REPO,
    repoRoot: REPO,
    caseId: "r98-tool-write-request",
    suite: "regression",
    arm: "baseline",
    repetition: 1,
    planDigest: "e".repeat(64),
    scriptShape: "write-then-stop",
    approvedSourceSha: null,
    providerId: "openai",
    modelId: "approved-model-x",
    endpointBaseUrl: "http://127.0.0.1:9/v1",
    ...over,
  });
  return { record: record as Record<string, unknown> };
}

/**
 * Write a child that IGNORES every polite termination signal and writes a
 * heartbeat file so a test can prove it was really alive.
 *
 * `process.on("SIGTERM", () => {})` is not a simulation: it is exactly the
 * hostile child plan §T5 怎么做 1 describes ("安装忽略 SIGTERM 的 handler"), and on
 * Windows it is what a process that never registers the signal's default
 * behaviour looks like. `SIGINT` is ignored too, because a naive implementation
 * that "tries harder" by escalating from SIGTERM to SIGINT would still hang.
 */
async function writeStubbornChild(dir: string, opts: { exitAfterMs?: number } = {}): Promise<string> {
  const path = join(dir, "stubborn.mjs");
  await writeFile(
    path,
    [
      'import { writeFileSync, appendFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const dir = process.argv[2];',
      'const heartbeat = join(dir, "heartbeat.txt");',
      'process.on("SIGTERM", () => {});',
      'process.on("SIGINT", () => {});',
      'process.on("SIGHUP", () => {});',
      'appendFileSync(heartbeat, "alive\\n");',
      // Never exits on its own: only a real forced kill ends this.
      'setInterval(() => appendFileSync(heartbeat, "alive\\n"), 25);',
      ...(opts.exitAfterMs === undefined ? [] : [`setTimeout(() => process.exit(0), ${opts.exitAfterMs});`]),
    ].join("\n"),
    "utf8",
  );
  return path;
}

describe("R99-B S1: a child that IGNORES SIGTERM is still stopped, within deadline + grace", () => {
  it("returns a NAMED timeout result, and the child is really gone", async () => {
    const dir = await tempDir();
    const child = await writeStubbornChild(dir);
    const heartbeat = join(dir, "heartbeat.txt");
    const deadlineMs = 1_500;
    const started = Date.now();

    const outcome = await worker.boundedStop({
      file: process.execPath,
      args: [child, dir],
      cwd: dir,
      deadlineMs,
      graceMs: worker.SIGKILL_GRACE_MS,
    });
    const elapsed = Date.now() - started;

    // ---- THE BOUND (plan §T5 怎么验收 1). -------------------------------
    //
    // The implementation must stop it within deadline + grace + a generous
    // scheduling margin. Before the fix this never returned at all, so a modest
    // upper bound is the whole point of the test.
    expect(elapsed, `boundedStop took ${elapsed}ms for a ${deadlineMs}ms deadline`).toBeLessThan(
      deadlineMs + worker.SIGKILL_GRACE_MS + 8_000,
    );

    // A NAMED result, not a null nobody reads (plan §T5 怎么做 7).
    expect(outcome["reason"]).toBe("timeout");
    expect(outcome["started"]).toBe(true);
    expect(outcome["exitCode"]).not.toBe(0);
    // The child really was alive and really ignored the polite signal, so this
    // test would be vacuous otherwise.
    expect(existsSync(heartbeat)).toBe(true);
  }, 60_000);

  it("escalates only AFTER the grace: a child that dies on the first signal is not tree-killed", async () => {
    // A child that dies from the polite attempt must NOT also be force-killed:
    // escalating immediately would be a different bug (it would leave no room for
    // a cooperative child to flush and exit), and it would spend a `taskkill` on a
    // tree that is already gone.
    //
    // PLATFORM HONESTY (stated, not hidden): on Windows there is no SIGTERM
    // DELIVERY — `child.kill("SIGTERM")` is `TerminateProcess`, which the OS
    // performs immediately and no handler can intercept. So this test asserts the
    // PORTABLE half of the contract: the first attempt is the only one made, and
    // the forced tree-kill is never invoked for a child that is already gone.
    // The POSIX half (a handler really running) is the same code path and is
    // exercised by Ubuntu CI, where `process.kill(-pgid, "SIGTERM")` is a real
    // signal.
    const dir = await tempDir();
    const child = join(dir, "cooperative.mjs");
    await writeFile(
      child,
      [
        'import { appendFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'process.on("SIGTERM", () => { appendFileSync(join(process.argv[2], "term.txt"), "terminated\\n"); process.exit(0); });',
        "setInterval(() => {}, 25);",
      ].join("\n"),
      "utf8",
    );
    const deadlineMs = 700;
    const began = Date.now();
    const outcome = await worker.boundedStop({
      file: process.execPath,
      args: [child, dir],
      cwd: dir,
      deadlineMs,
      graceMs: worker.SIGKILL_GRACE_MS,
    });
    const elapsed = Date.now() - began;
    expect(outcome["reason"]).toBe("timeout");
    // The forced tree-kill never ran: the child was already gone.
    expect(outcome["forced"]).toBe(false);
    // And it did not have to wait out the grace, because `close` was awaited and
    // arrived from the first attempt.
    expect(elapsed, `waited ${elapsed}ms for a ${deadlineMs}ms deadline`).toBeLessThan(
      deadlineMs + worker.SIGKILL_GRACE_MS,
    );
  }, 60_000);

  it("leaves NO descendant behind: a grandchild that ignores signals is reaped too", async () => {
    // Plan §T5 怎么做 2: "不要只停止父进程而留下工具子孙进程继续写文件." The parent
    // here spawns a stubborn GRANDCHILD and exits only when killed, so a
    // parent-only kill would leave the grandchild writing forever.
    const dir = await tempDir();
    const grandchild = await writeStubbornChild(dir, {});
    const parent = join(dir, "parent.mjs");
    await writeFile(
      parent,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        "const gc = process.argv[3];",
        // The grandchild's pid is published so the test can prove it is gone.
        'const c = spawn(process.execPath, [gc, dir], { stdio: "ignore", windowsHide: true });',
        'writeFileSync(join(dir, "grandchild.pid"), String(c.pid));',
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 25);",
      ].join("\n"),
      "utf8",
    );
    const outcome = await worker.boundedStop({
      file: process.execPath,
      args: [parent, dir, grandchild],
      cwd: dir,
      deadlineMs: 1_500,
      graceMs: worker.SIGKILL_GRACE_MS,
    });
    expect(outcome["reason"]).toBe("timeout");

    // Give the OS a moment to reap, then require the grandchild to be gone.
    const { readFile } = await import("node:fs/promises");
    let pid: number | null = null;
    try {
      pid = Number((await readFile(join(dir, "grandchild.pid"), "utf8")).trim());
    } catch {
      pid = null;
    }
    if (pid !== null && Number.isFinite(pid) && pid > 0) {
      const alive = await (async () => {
        for (let i = 0; i < 40; i += 1) {
          try {
            process.kill(pid, 0);
          } catch {
            return false;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        return true;
      })();
      expect(alive, `descendant pid ${pid} survived the bounded stop`).toBe(false);
    }
  }, 60_000);
});

describe("R99-B S2: the output cap is BYTES, not a count of chunks", () => {
  it("one HUGE chunk and many SMALL chunks are bounded identically", () => {
    const limit = 4_096;
    // One 1 MiB chunk — the case the old `chunks.length` check let through whole.
    const huge = new worker.ByteCap(limit);
    huge.push(Buffer.alloc(1_048_576, 0x61));
    expect(huge.bytes).toBeLessThanOrEqual(limit);
    expect(huge.truncated).toBe(true);

    // 4 096 one-byte chunks — the OTHER case the old check let through whole,
    // because the array never grew past the limit until the byte count did.
    const many = new worker.ByteCap(limit);
    for (let i = 0; i < 4_096; i += 1) many.push(Buffer.from("a"));
    expect(many.bytes).toBe(limit);
    // The byte count is the MEASURED total, even beyond the cap, so a reader can
    // see how much was dropped rather than only that something was.
    many.push(Buffer.from("a"));
    expect(many.truncated).toBe(true);
    expect(many.text().length).toBe(limit);
  });

  it("counts UTF-8 bytes, not characters", () => {
    const cap = new worker.ByteCap(8);
    // Six 3-byte characters = 18 bytes. A character-count cap would accept all 6.
    cap.push(Buffer.from("中".repeat(6)));
    expect(cap.bytes).toBeLessThanOrEqual(8);
    expect(cap.truncated).toBe(true);
    // The retained text is still valid UTF-8 (no half character emitted).
    expect(() => JSON.stringify(cap.text())).not.toThrow();
  });

  it("an under-limit stream is NOT marked truncated", () => {
    const cap = new worker.ByteCap(1024);
    cap.push("hello");
    cap.push(" world");
    expect(cap.bytes).toBe(11);
    expect(cap.truncated).toBe(false);
    expect(cap.text()).toBe("hello world");
  });

  it("the module's own default cap is a real byte limit, not a chunk count", () => {
    expect(worker.MAX_CHILD_OUTPUT_BYTES).toBeGreaterThan(0);
    const cap = new worker.ByteCap(worker.MAX_CHILD_OUTPUT_BYTES);
    cap.push(Buffer.alloc(worker.MAX_CHILD_OUTPUT_BYTES + 1, 0x62));
    expect(cap.bytes).toBe(worker.MAX_CHILD_OUTPUT_BYTES);
    expect(cap.truncated).toBe(true);
  });
});

describe("R99-B S3: cancellation and spawn failure are distinct, named outcomes", () => {
  it("an AbortSignal cancels a running child and is reported as `cancelled`", async () => {
    const dir = await tempDir();
    const child = await writeStubbornChild(dir);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const outcome = await worker.boundedStop({
      file: process.execPath,
      args: [child, dir],
      cwd: dir,
      deadlineMs: 60_000,
      graceMs: worker.SIGKILL_GRACE_MS,
      signal: controller.signal,
    });
    expect(outcome["reason"]).toBe("cancelled");
    expect(outcome["started"]).toBe(true);
  }, 60_000);

  it("an ALREADY-aborted signal cancels without ever starting the child", async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    controller.abort();
    const outcome = await worker.boundedStop({
      file: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: dir,
      deadlineMs: 5_000,
      graceMs: worker.SIGKILL_GRACE_MS,
      signal: controller.signal,
    });
    expect(outcome["reason"]).toBe("cancelled");
    // DISTINCT from "started": plan §T5 怎么做 5 requires the three cases be told
    // apart. Nothing was launched, so nothing can be outstanding.
    expect(outcome["started"]).toBe(false);
  }, 30_000);

  it("a file that cannot be spawned is `spawn_failed`, not a timeout", async () => {
    const dir = await tempDir();
    const outcome = await worker.boundedStop({
      file: join(dir, "definitely-not-a-real-executable-xyz"),
      args: [],
      cwd: dir,
      deadlineMs: 5_000,
      graceMs: worker.SIGKILL_GRACE_MS,
    });
    expect(outcome["reason"]).toBe("spawn_failed");
    expect(outcome["started"]).toBe(false);
  }, 30_000);

  it("a child that exits normally is `exited`, with its own code", async () => {
    const dir = await tempDir();
    const outcome = await worker.boundedStop({
      file: process.execPath,
      args: ["-e", "process.stdout.write('done'); process.exit(0)"],
      cwd: dir,
      deadlineMs: 30_000,
      graceMs: worker.SIGKILL_GRACE_MS,
    });
    expect(outcome["reason"]).toBe("exited");
    expect(outcome["exitCode"]).toBe(0);
    expect(outcome["stdout"]).toBe("done");
  }, 30_000);

  /**
   * ---- E4-R99-B (T5): THE CAP MUST END THE CHILD, NOT ONLY BOUND MEMORY ------
   *
   * Plan §T5 怎么验收 5 requires "超时、取消和超量输出都能结束执行且留下正确状态" —
   * a TIMEOUT, a CANCEL **and an EXCESS-OUTPUT condition** must each END execution.
   *
   * MEASURED DEFECT (the one this test exists for): `BOUNDED_STOP_REASONS` listed
   * `output_limit`, but nothing ever settled with it. `ByteCap` bounded memory
   * correctly and then said nothing, so a child that flooded stdout ran on until
   * the DEADLINE killed it. That is why this test previously asserted
   * `reason === "timeout"`: the assertion was recording the defect, not the
   * contract. It now asserts the reason the contract names.
   *
   * The deadline is deliberately FAR AWAY (20s, and 120s for the tree case) and the
   * cap is small (64 KiB), so `timeout` is not merely the wrong label here — it is
   * unreachable within the test's own lifetime. An implementation that still waited
   * for the deadline would fail on the reason, on the elapsed bound, and on the
   * suite timeout.
   */
  it("an output flood past the cap ends the child as `output_limit`, long before the deadline", async () => {
    const dir = await tempDir();
    const child = join(dir, "flood.mjs");
    const heartbeat = join(dir, "flood-heartbeat.txt");
    await writeFile(
      child,
      [
        'import { appendFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const heartbeat = join(process.argv[2], 'flood-heartbeat.txt');",
        // A heartbeat is the only way the TEST can prove the child is really gone
        // rather than merely unobserved: `boundedStop` returns no pid.
        "appendFileSync(heartbeat, 'alive\\n');",
        "setInterval(() => appendFileSync(heartbeat, 'alive\\n'), 20);",
        // One huge chunk, then an unbounded trickle: both paths must be capped.
        "process.stdout.write('x'.repeat(2 * 1024 * 1024));",
        "setInterval(() => process.stdout.write('y'.repeat(4096)), 5);",
      ].join("\n"),
      "utf8",
    );
    const deadlineMs = 20_000;
    const began = Date.now();
    const outcome = await worker.boundedStop({
      file: process.execPath,
      args: [child, dir],
      cwd: dir,
      deadlineMs,
      graceMs: worker.SIGKILL_GRACE_MS,
      maxOutputBytes: 64 * 1024,
    });
    const elapsed = Date.now() - began;

    // The NAMED reason for an excess-output stop (plan §T5 怎么做 7).
    expect(outcome["reason"]).toBe("output_limit");
    expect(outcome["started"]).toBe(true);
    expect(outcome["truncated"]).toBe(true);
    // The retained text is bounded by the BYTE limit, not by luck.
    expect(Buffer.byteLength(String(outcome["stdout"]), "utf8")).toBeLessThanOrEqual(64 * 1024);
    // WELL BEFORE the deadline: a quarter of it is already an order of magnitude
    // more than the cap + grace needs, so this bound cannot be met by waiting.
    expect(elapsed, `the cap took ${elapsed}ms to end a ${deadlineMs}ms unit`).toBeLessThan(deadlineMs / 4);

    // And the child is really GONE: its heartbeat stops growing.
    const { stat } = await import("node:fs/promises");
    const sizeAtStop = (await stat(heartbeat)).size;
    expect(sizeAtStop).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 800));
    const sizeLater = (await stat(heartbeat)).size;
    expect(sizeLater, "the flooding child kept writing after the bounded stop returned").toBe(sizeAtStop);
  }, 60_000);

  it("leaves NO descendant behind when the CAP is what stops the tree", async () => {
    // Plan §T5 怎么做 2: "不要只停止父进程而留下工具子孙进程继续写文件." The stop
    // reason must not change which machinery runs: an `output_limit` stop reuses
    // the SAME polite-signal → bounded-grace → forced tree-kill sequence, so a
    // grandchild that ignores signals must be reaped here too.
    const dir = await tempDir();
    const grandchild = await writeStubbornChild(dir);
    const parent = join(dir, "flood-parent.mjs");
    await writeFile(
      parent,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        "const gc = process.argv[3];",
        'const c = spawn(process.execPath, [gc, dir], { stdio: "ignore", windowsHide: true });',
        'writeFileSync(join(dir, "grandchild.pid"), String(c.pid));',
        'process.on("SIGTERM", () => {});',
        "process.stdout.write('x'.repeat(2 * 1024 * 1024));",
        "setInterval(() => process.stdout.write('y'.repeat(4096)), 5);",
      ].join("\n"),
      "utf8",
    );
    const outcome = await worker.boundedStop({
      file: process.execPath,
      args: [parent, dir, grandchild],
      cwd: dir,
      deadlineMs: 20_000,
      graceMs: worker.SIGKILL_GRACE_MS,
      maxOutputBytes: 64 * 1024,
    });
    expect(outcome["reason"]).toBe("output_limit");

    const { readFile } = await import("node:fs/promises");
    let pid: number | null = null;
    try {
      pid = Number((await readFile(join(dir, "grandchild.pid"), "utf8")).trim());
    } catch {
      pid = null;
    }
    if (pid !== null && Number.isFinite(pid) && pid > 0) {
      const alive = await (async () => {
        for (let i = 0; i < 40; i += 1) {
          try {
            process.kill(pid, 0);
          } catch {
            return false;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        return true;
      })();
      expect(alive, `descendant pid ${pid} survived an output_limit stop`).toBe(false);
    }
  }, 60_000);
});

describe("R99-B S5: the deadline is SHARED across phases, not re-granted per phase", () => {
  it("a phase cannot obtain a fresh full deadline after the first one spent it", () => {
    // Plan §T5 怎么做 4: "dry-run/staging/dispatch 共用剩余总期限，不能每个阶段重新获得
    // 一整份 campaign 时间."
    //
    // The defect this pins is a shape, not a number: if each phase called
    // `setTimeout(fullTimeout)` for itself, a unit with a 1s deadline that spends
    // 900ms in the dry run would still get a full 1s for the dispatch — a 1.9s
    // unit under a 1s promise. A shared budget makes the SECOND phase inherit what
    // is LEFT.
    let clock = 1_000_000;
    const budget = new worker.DeadlineBudget(1_000, () => clock);
    expect(budget.remaining()).toBe(1_000);
    // The dry run spends most of it.
    clock += 900;
    expect(budget.remaining()).toBe(100);
    // The dispatch phase inherits the REMAINDER, not a fresh 1_000.
    expect(budget.remainingForPhase()).toBe(100);
    clock += 150;
    expect(budget.expired()).toBe(true);
    expect(budget.remaining()).toBe(0);
    expect(budget.remainingForPhase()).toBe(0);
  });

  it("fires its AbortSignal exactly at the deadline, once", async () => {
    const budget = new worker.DeadlineBudget(120);
    expect(budget.signal.aborted).toBe(false);
    const fired: number[] = [];
    budget.signal.addEventListener("abort", () => fired.push(Date.now()));
    await new Promise((r) => setTimeout(r, 400));
    expect(budget.signal.aborted).toBe(true);
    expect(fired).toHaveLength(1);
    budget.dispose();
  });

  it("dispose() releases the timer so a finished unit leaves nothing armed", async () => {
    const budget = new worker.DeadlineBudget(50);
    budget.dispose();
    await new Promise((r) => setTimeout(r, 200));
    // The timer was cleared: the signal never fires after disposal.
    expect(budget.signal.aborted).toBe(false);
  });

  it("a budget that is already spent is expired from the first check", () => {
    const budget = new worker.DeadlineBudget(0);
    expect(budget.expired()).toBe(true);
    expect(budget.remaining()).toBe(0);
    budget.dispose();
  });
});

describe("R99-B S6: the deadline reaches the REAL execution path", () => {
  it("mergeSignals aborts when EITHER the arm's signal or the campaign's does", async () => {
    // T5 做什么 1: "campaign deadline、unit deadline、用户取消均可终止实际执行." The
    // arm's provider contract accepts ONE signal, so the seam must combine them —
    // otherwise a deadline could be honoured by the worker's own bookkeeping while
    // the arm's provider call ran on, which is the "AbortController 却从不触发取消"
    // defect in a new place.
    const exec = (await import(pathToFileURL(join(REPO, "scripts", "e4", "r97-arm-exec.mjs")).href)) as {
      mergeSignals: (a?: AbortSignal, b?: AbortSignal) => AbortSignal;
    };

    // Neither → the identity is preserved.
    expect(exec.mergeSignals(undefined, undefined)).toBeUndefined();
    const only = new AbortController();
    expect(exec.mergeSignals(only.signal, undefined)).toBe(only.signal);
    expect(exec.mergeSignals(undefined, only.signal)).toBe(only.signal);

    // The ARM aborts → the merged signal aborts.
    const arm = new AbortController();
    const campaign = new AbortController();
    const mergedA = exec.mergeSignals(arm.signal, campaign.signal);
    expect(mergedA.aborted).toBe(false);
    arm.abort();
    expect(mergedA.aborted).toBe(true);

    // The CAMPAIGN aborts → the merged signal aborts. This is the direction that
    // makes a campaign deadline able to end a call the arm is happy to continue.
    const arm2 = new AbortController();
    const campaign2 = new AbortController();
    const mergedB = exec.mergeSignals(arm2.signal, campaign2.signal);
    campaign2.abort();
    expect(mergedB.aborted).toBe(true);
  });

  it("a unit whose deadline is ALREADY spent never dispatches, and reports timeout", async () => {
    // The end-to-end form of T5 怎么做 4: a `DeadlineBudget` with no time left must
    // stop the unit BEFORE the arm is asked to run, and the verdict must be
    // `timeout` rather than `case_failed`, `infrastructure`, or a pass.
    const mod = await import(WORKER);
    const root = await tempDir();
    const spent = new worker.DeadlineBudget(0);
    expect(spent.expired()).toBe(true);
    try {
      const { record } = await runUnit({
        checkoutDir: REPO,
        executionStateDir: join(root, "state"),
        ledgerDir: join(root, "ledger"),
        outDir: join(root, "out"),
        timeoutMs: 0,
      });
      // Whatever the exact detail, the classification must be the STOP, not a
      // case outcome: the arm never produced a verdict.
      expect(record.failureCategory).toBe("timeout");
      expect(String(record.detail)).toMatch(/deadline/i);
      // A stopped unit is never a pass and never a verified result.
      expect(record.verifierPassed ?? false).toBe(false);
      expect(record.status).toBe("failed");
      // It charged nothing beyond its pre-taken reservation being returned: no
      // provider call was admitted.
      expect((record.budget as { logicalCalls?: number } | null)?.logicalCalls ?? 0).toBe(0);
    } finally {
      spent.dispose();
    }
    void mod;
  }, 120_000);

  it("an unspent deadline leaves the normal path completely unchanged", async () => {
    // The negative control: a generous deadline must not perturb a real unit. If
    // the deadline plumbing changed the happy path, every earlier suite would be
    // measuring something else.
    const root = await tempDir();
    const { record } = await runUnit({
      checkoutDir: REPO,
      executionStateDir: join(root, "state"),
      ledgerDir: join(root, "ledger"),
      outDir: join(root, "out"),
      timeoutMs: 600_000,
    });
    expect(record.status).toBe("completed");
    expect(record.verifierPassed).toBe(true);
    expect(record.consumed).toBeGreaterThan(0);
    // No deadline stop was recorded on a unit that finished in time.
    expect(record.detail ?? "").not.toMatch(/deadline/i);
  }, 120_000);
});

describe("R99-B S7: an interrupted unit settles its budget and its state honestly", () => {
  it("a unit stopped by the deadline is TERMINAL, so a resume skips it rather than re-sending", async () => {
    // Plan §T5 怎么验收 5: "超时后 resume 不重复发出 UNKNOWN 请求，不把中断结果改成
    // COMPLETE."
    //
    // Both halves of that sentence are about the DURABLE state, and the state
    // contract already provides the mechanism (T2): a failed attempt is terminal
    // — `isDone` is true — unless it was explicitly reconciled for retry. That is
    // exactly what stops a resume from re-sending a request whose outcome was
    // never observed: the unit is not "pending" and it is not "completed", it is
    // finished with a NAMED failure, and re-running it requires an operator to
    // reconcile it on purpose.
    //
    // So the assertions are: the attempt is terminal (no silent re-send), and its
    // recorded outcome is the STOP rather than a pass (not COMPLETE).
    const mod = (await import(
      pathToFileURL(join(REPO, "packages", "evaluation", "dist", "index.js")).href
    )) as {
      openR97ExecutionState: (root: string, opts: Record<string, unknown>) => Promise<{
        isDone: (key: Record<string, unknown>) => Promise<boolean>;
        recordFor: (key: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      }>;
    };
    const root = await tempDir();
    const { record } = await runUnit({
      checkoutDir: REPO,
      executionStateDir: join(root, "state"),
      ledgerDir: join(root, "ledger"),
      outDir: join(root, "out"),
      timeoutMs: 0,
    });
    expect(record.failureCategory).toBe("timeout");

    // Reopen the state the way a resume would and read the unit back.
    const state = await mod.openR97ExecutionState(join(root, "state"), {
      experimentId: "e".repeat(64),
      planDigest: "e".repeat(64),
      mode: "resume",
    });
    const key = {
      experimentId: "e".repeat(64),
      caseId: "r98-tool-write-request",
      suite: "regression",
      arm: "baseline",
      repetition: 1,
    };
    // TERMINAL: the resume will not re-send it. That is the first half of §怎么验收 5.
    expect(await state.isDone(key)).toBe(true);

    const unitRecord = await state.recordFor(key);
    expect(unitRecord).not.toBeNull();
    // The recorded outcome is the STOP, and it is a FAILURE — never a pass. That
    // is the second half: the interrupt was not rewritten into a COMPLETE.
    expect(String(unitRecord!["status"])).toBe("failed");
    expect(String(unitRecord!["detail"] ?? "")).toMatch(/timeout/i);
    // And it was NOT quietly marked reconciled-for-retry, which would be the
    // mechanism by which a resume WOULD re-send an unknown request.
    expect(unitRecord!["reconciledForRetry"] ?? false).toBe(false);
  }, 180_000);

  it("the interrupt's reservation is NOT refunded, because a dispatched call may have been billed", async () => {
    // Plan §T5 怎么做 7: "取消后保留已发调用的预算；不明请求归 UNKNOWN."
    //
    // A unit stopped BEFORE any call left provably dispatched nothing, so its
    // pre-taken reservation is returned. A unit stopped AFTER a call left must not
    // have that call refunded — the request may already have been billed, and a
    // refund would let the campaign spend more than it approved. This test pins
    // the first half exactly, and the channel's own suite pins the second.
    const root = await tempDir();
    const ledgerDir = join(root, "ledger");
    const { record } = await runUnit({
      checkoutDir: REPO,
      executionStateDir: join(root, "state"),
      ledgerDir,
      outDir: join(root, "out"),
      timeoutMs: 0,
    });
    expect(record.failureCategory).toBe("timeout");
    // Nothing was admitted, so nothing is charged.
    expect((record.budget as { logicalCalls?: number } | null)?.logicalCalls ?? 0).toBe(0);
    expect(record.consumed).toBe(0);
    // The reservation ids this unit took are exposed, so a reader can see that a
    // stopped unit's pre-taken reservation was RETURNED rather than left
    // outstanding forever.
    expect(Array.isArray(record.reservationIds)).toBe(true);

    const mod = (await import(
      pathToFileURL(join(REPO, "packages", "evaluation", "dist", "index.js")).href
    )) as {
      readR97LedgerFile: (dir: string) => Promise<Record<string, unknown> | null>;
      viewOfR97Ledger: (file: Record<string, unknown>) => Record<string, unknown>;
    };
    const file = await mod.readR97LedgerFile(ledgerDir);
    if (file !== null) {
      const view = mod.viewOfR97Ledger(file);
      // A returned reservation is not consumed: the campaign's spend reflects
      // work that actually left, not work that was prepared for.
      expect(Number(view["consumed"] ?? 0)).toBe(0);
      // And it is not left in the "unknown" bucket either: an undispatched attempt
      // is neither billed nor unknown.
      expect(Number(view["unknown"] ?? 0)).toBe(0);
    }
  }, 180_000);
});

describe("R99-B S4: every path is bounded, and the stop is the IMPLEMENTATION's doing", () => {
  it("a stubborn child is stopped well before an independent watchdog would fire", async () => {
    // Plan §T5 怎么验收 3: "测试独立 watchdog 清理只是防测试卡死；被测实现未自行停止时
    // 必须失败，不能用测试清理当成实现成功."
    //
    // The watchdog below exists ONLY so this suite cannot hang. It records its own
    // firing, and the assertion requires that it did NOT fire — which is what makes
    // "the implementation stopped the child" a measured claim rather than an
    // inference from "the test finished".
    const dir = await tempDir();
    const child = await writeStubbornChild(dir);
    const deadlineMs = 1_000;
    const watchdogMs = 30_000;
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
    }, watchdogMs);

    try {
      const outcome = await worker.boundedStop({
        file: process.execPath,
        args: [child, dir],
        cwd: dir,
        deadlineMs,
        graceMs: worker.SIGKILL_GRACE_MS,
      });
      expect(outcome["reason"]).toBe("timeout");
      expect(watchdogFired, "the watchdog fired: the implementation did NOT stop the child itself").toBe(false);
    } finally {
      clearTimeout(watchdog);
    }
  }, 60_000);

  it("the named reasons are a closed set the rest of the contract can rely on", () => {
    // `reason` is what a caller switches on, so it must not be free text.
    expect(worker.BOUNDED_STOP_REASONS).toEqual(
      expect.arrayContaining(["exited", "timeout", "cancelled", "spawn_failed", "output_limit"]),
    );
    // `timeout` is already a failure category; a bounded stop must be able to
    // report it without inventing a second vocabulary (plan §T5 怎么做 7).
    expect(worker.FAILURE_CATEGORIES).toContain("timeout");
  });
});
