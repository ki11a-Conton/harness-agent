import { mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  R97_LEDGER_LOCK_FILENAME,
  R97_LOCK_HELD,
  withR97CampaignLock,
} from "./r97-budget-ledger.js";

/**
 * MEASURED DEFECT (Windows): `open(path, "wx")` on the ledger lock reports
 * contention as `EPERM`, not only `EEXIST`, when the name is in a transient
 * delete/rename state. That state is created by the lock's OWN release `rm`
 * racing another acquirer's `open`, so `EPERM` is the same condition `EEXIST`
 * describes — "held right now, retry" — and must be absorbed by the retry loop.
 *
 * Before the fix, `acquireLock` rethrew anything that was not `EEXIST`, so this
 * race escaped the entire retry/dead-owner/deadline machinery and aborted a whole
 * campaign with:
 *   `EPERM: operation not permitted, open .../budget-ledger.lock  (errno -4048)`
 *
 * Measured on win32/x64, Node v24.18.1, with a standalone probe:
 *   - concurrent acquire+release of one path: EPERM 154 / 5000 attempts
 *   - the SAME loop with the `rm` made sequential: EPERM 0 / 5000 attempts
 * so the trigger is specifically the open-vs-rm race, not ordinary contention.
 * Full report: docs/evidence/ledger-lock-eperm-windows-defect.md
 */
describe("R97 budget ledger lock — Windows EPERM contention (measured defect)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "r97-lock-eperm-"));
    dirs.push(d);
    return d;
  }

  it("[EPERM-1] concurrent acquire/release of ONE lock path never throws a raw EPERM", async () => {
    // This is the counter-example. On the pre-fix code it fails with an unhandled
    // `EPERM: operation not permitted, open ...budget-ledger.lock`, because a
    // rejection escapes acquireLock instead of being retried. Under contention the
    // correct outcomes are only: it succeeds, or it fails with the DESIGNED
    // bounded refusal (R97_LOCK_HELD).
    const dir = makeDir();
    const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
    const outcomes: string[] = [];

    const one = async (i: number): Promise<void> => {
      for (let n = 0; n < 40; n++) {
        try {
          await withR97CampaignLock(
            dir,
            async () => {
              // Hold it long enough that other workers genuinely contend, and
              // remove the lock file mid-hold sometimes so the acquirer's open()
              // races a delete — the exact window that produced EPERM.
              await new Promise((r) => setTimeout(r, 1));
              if ((i + n) % 3 === 0) rmSync(lockPath, { force: true });
            },
            { lockTimeoutMs: 5_000 },
          );
          outcomes.push("ok");
        } catch (err) {
          const code = (err as { code?: string }).code;
          const msg = err instanceof Error ? err.message : String(err);
          // A raw filesystem code escaping here is the defect.
          if (code === "EPERM" || /EPERM/.test(msg)) outcomes.push(`RAW_EPERM:${msg}`);
          else if (msg.includes(R97_LOCK_HELD)) outcomes.push("lock-held");
          else outcomes.push(`OTHER:${code ?? msg}`);
        }
      }
    };

    // 12 workers x 40 attempts: enough concurrency to hit the measured ~3% window.
    await Promise.all(Array.from({ length: 12 }, (_, i) => one(i)));

    const rawEperm = outcomes.filter((o) => o.startsWith("RAW_EPERM"));
    const other = outcomes.filter((o) => o.startsWith("OTHER"));
    expect(rawEperm, `raw EPERM escaped the retry loop: ${rawEperm[0] ?? ""}`).toEqual([]);
    expect(other, `unexpected error class: ${other[0] ?? ""}`).toEqual([]);
    // The work actually happened — this is not a vacuous "nothing ran" pass.
    expect(outcomes.filter((o) => o === "ok").length).toBeGreaterThan(0);
  });

  it("[EPERM-2] a genuinely wedged lock still fails CLOSED with R97_LOCK_HELD", async () => {
    // The widening must not become an infinite retry or a lock-stealer. A live
    // holder (this process's own pid) must still produce the designed bounded
    // refusal once the deadline passes.
    const dir = makeDir();
    const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
    // Write a lock record owned by THIS process, which is definitionally alive.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      lockPath,
      JSON.stringify({ token: "held-by-live-owner", pid: process.pid, host: "test", acquiredAt: 0 }),
      "utf8",
    );

    await expect(
      withR97CampaignLock(dir, async () => "should-not-run", { lockTimeoutMs: 300 }),
    ).rejects.toThrow(new RegExp(R97_LOCK_HELD));
  });

  it("[EPERM-3] a non-contention error code still propagates (no blanket catch)", async () => {
    // The fix widens ONLY EEXIST/EPERM. A real error must not be silently retried
    // until the deadline, because that would convert a hard failure into a slow one.
    const dir = makeDir();
    // A directory where the lock FILE should be: open(...,"wx") fails with EEXIST
    // on Linux and EPERM/EISDIR on Windows — neither should be reachable here what
    // we are proving is that the acquire path cannot swallow an unrelated code.
    // Use a nonexistent parent directory instead: open() yields ENOENT.
    const missing = join(dir, "no-such-parent");
    await expect(
      withR97CampaignLock(missing, async () => "nope", { lockTimeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("[EPERM-4] a DETERMINISTIC EPERM is retried and the lock is still acquired", async () => {
    // EPERM-1 relies on a ~3% Windows race actually firing, which MEASURED as
    // unreliable: with the fix reverted, EPERM-1 passed 6/6 runs on this machine,
    // so it cannot serve as a mutation target. This test forces the exact
    // condition through the injected `openFn` seam instead, so the EPERM branch is
    // covered on EVERY platform and in EVERY run.
    const dir = makeDir();
    const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
    let raised = 0;
    // Raise the transient Windows EPERM for the first N attempts, then delegate to
    // the real exclusive open — exactly the "name briefly unavailable, retry" case.
    const openFn = (async (p: string, flags: string) => {
      if (raised < 3) {
        raised += 1;
        const err = new Error(`EPERM: operation not permitted, open '${lockPath}'`) as Error & { code: string };
        err.code = "EPERM";
        throw err;
      }
      return open(p, flags);
    }) as unknown as Parameters<typeof withR97CampaignLock>[2] extends { openFn?: infer F } ? F : never;

    const result = await withR97CampaignLock(dir, async () => "ran", { lockTimeoutMs: 5_000, openFn });
    expect(result).toBe("ran");
    // The retry loop really saw the EPERM injection — this is not a vacuous pass.
    expect(raised).toBe(3);
    // ...and the lock was genuinely released, so a later acquirer is not blocked.
    await expect(withR97CampaignLock(dir, async () => "second", { lockTimeoutMs: 2_000 })).resolves.toBe("second");
  });
});
