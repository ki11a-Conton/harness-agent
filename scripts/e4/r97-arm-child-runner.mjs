/**
 * E4-R106 (A6 / F6) — THE TERMINABLE EXECUTION BOUNDARY, AS A REAL PROCESS.
 *
 * MEASURED DEFECT F6 (plan §A6):
 *
 *   "boundedStop 工具已经能杀进程，但实际 worker 改成进程内 await
 *    runBenchmarkCommand" — a cancel at 40 ms still PASSES ~412 ms later; a unit
 *    timeout of 80 ms returns ~421 ms later.
 *
 * The worker used to `await` the arm's exported `runBenchmarkCommand` INSIDE its own
 * process. Nothing could end that await, so a dry run or a dispatch that never
 * returns kept the unit, its reservation and the campaign alive forever. This file is
 * the child half of the fix: it loads the SPECIFIED arm's OWN build and runs the ONE
 * case, so the parent can end the work with the operating system.
 *
 * WHY A PROCESS RATHER THAN A CANCELLABLE PROMISE (plan §A6 怎么做 5):
 *   "单独 Promise.race 返回后放任后台执行继续，不算修复."
 * A race resolves the unit and leaves the hung provider's timers, open handles and
 * GRANDCHILDREN writing files afterwards — a report that lies. A separate process is
 * the only boundary that can stop code ignoring `AbortSignal` entirely.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not re-implement the budget. The parent
 * hands over the SAME ledger directory and the case runs through the SAME A1 channel
 * (`createLedgerBudgetedProvider`), so every `generate()` still reserves BEFORE it
 * leaves (plan §A6 怎么做 7). Every judgement — identity drift, verdict priority,
 * settlement — stays in the parent.
 *
 * CONTRACT. stdin: one JSON object of options. stdout: exactly ONE line,
 * `__A6_RESULT__<json>` with `{ ok: true, executed, stats }` or
 * `{ ok: false, error, stats }`. The sentinel keeps a stray `console.log` from a
 * third-party module from being parsed as the result. A child killed mid-case reports
 * NO result, which is what lets the parent classify the unit from the STOP.
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const SENTINEL = "__A6_RESULT__";

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

/** NO `SIGTERM` HANDLER IS INSTALLED, ON PURPOSE. A handler could let this process
 *  write a PARTIAL result on the way out, and a half-written report is worse than
 *  none: the parent must classify the unit from the STOP. The parent's `boundedStop`
 *  escalates to a forced TREE kill after the grace regardless of cooperation. */
async function main() {
  // Hoisted out of the `try` so the catch can still publish what was measured: a
  // failure AFTER a call was admitted must not erase the record of that call.
  const statsHolder = { stats: null };
  const raw = await readStdin();
  let opts;
  try {
    opts = JSON.parse(raw);
  } catch (err) {
    process.stdout.write(
      `${SENTINEL}${JSON.stringify({
        ok: false,
        error: `the runner received unparseable options: ${err instanceof Error ? err.message : String(err)}`,
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    const evaluation = await import(pathToFileURL(join(opts.evaluationDir, "index.js")).href);
    const exec = await import(pathToFileURL(join(opts.execDir, "r97-arm-exec.mjs")).href);

    // The child opens the SAME ledger file the parent already holds. The ledger's own
    // claim lock is what keeps two processes from re-granting the same allowance —
    // the existing A2 protection, not something this runner adds.
    const ledger = await evaluation.openR97BudgetLedger(opts.ledgerDir, {
      planDigest: opts.planDigest,
      campaignModelCalls: opts.campaignModelCalls,
      mode: "resume",
    });

    const executed = await exec.runArmCaseInProcess({
      evaluation,
      arm: { label: opts.arm, checkoutDir: opts.checkoutDir },
      caseDef: opts.caseDef,
      scriptShape: opts.scriptShape,
      stagedCasesDir: opts.stagedCasesDir,
      outDir: opts.outDir,
      suite: opts.suite,
      providerId: opts.providerId,
      modelId: opts.modelId,
      endpointBaseUrl: opts.endpointBaseUrl,
      maxModelCalls: opts.maxModelCalls,
      ledger,
      firstReservationId: opts.firstReservationId,
      // NO DEADLINE OBJECT IS CONSTRUCTED HERE. In-process the executor checked
      // `remainingForPhase()` between phases, but that cannot interrupt an `await` —
      // the whole defect. The bound is now the PARENT's process-tree kill.
      budgetState: statsHolder,
    });

    process.stdout.write(
      `${SENTINEL}${JSON.stringify({ ok: true, executed, stats: statsHolder.stats ?? executed.budget ?? null })}\n`,
    );
  } catch (err) {
    // A runner-level failure is a FAILURE, never a verdict. THE LIVE STATS TRAVEL
    // WITH IT: if the case admitted a call and then threw, the channel's accounting is
    // the ONLY record of that spend, and the parent needs it to settle honestly
    // instead of refunding a call that really left.
    process.stdout.write(
      `${SENTINEL}${JSON.stringify({
        ok: false,
        error: `${err instanceof Error ? err.message : String(err)}`,
        stats: statsHolder.stats,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
