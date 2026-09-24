#!/usr/bin/env node
/**
 * E4-N3 — PUBLISH A FAILING CI STEP'S TEST NAMES OVER A PUBLIC CHANNEL.
 *
 * WHY THIS EXISTS
 * ---------------
 * A cross-platform regression only shows up on `windows-latest`, and diagnosing it
 * needs the NAME of the failing test. The job log needs an authenticated download;
 * the job SUMMARY and the check annotations do not. So this script reads whatever
 * the failing step left on disk, writes a fenced report to `$GITHUB_STEP_SUMMARY`
 * and emits `::error::` annotations, and the failure becomes readable without any
 * credential.
 *
 * It is deliberately the SAME script for both jobs, and it is invoked as
 * `node scripts/e4/r97-ci-diagnostics.mjs …` with NO `shell:` key in the workflow.
 * That is not cosmetic: the closed-loop job is test-pinned to contain no
 * `shell: bash` step (the Windows leg has no bash), and an earlier revision of this
 * diagnostic named `shell: bash` — which `r97-closed-loop.test.ts` caught as a real
 * suite failure (`1 failed | 23 passed`).
 *
 * USAGE
 * -----
 *   node scripts/e4/r97-ci-diagnostics.mjs --label verify --log .ci/test-report.log
 *   node scripts/e4/r97-ci-diagnostics.mjs --label closed-loop --out .ci/r97-r98
 *
 * EXIT CODE IS ALWAYS 0. A diagnostic that fails the job it is diagnosing would
 * replace the real failure with a misleading one, so an internal error is reported
 * in the summary instead.
 */

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_SUMMARY_LINES = 120;
const MAX_ANNOTATIONS = 8;
const MAX_LINE_CHARS = 240;

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Lines a reader can act on: a named failure, an assertion, or a count. */
function interestingLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").trimEnd())
    .filter((l) =>
      /FAIL |AssertionError|Failed Tests|Test Files|Tests +\d|Error:|expected |^\s*×|✕/.test(l),
    );
}

/** Git-Hub workflow commands treat `%`, CR and LF as escapes; a raw newline in an
 *  annotation message truncates it silently. */
function escapeCommand(line) {
  return line.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").slice(0, MAX_LINE_CHARS);
}

/** What a vitest JSON report says went wrong, as `test name — first failure line`. */
function failedTestsFromVitestReport(report) {
  const out = [];
  for (const file of Array.isArray(report?.testResults) ? report.testResults : []) {
    for (const a of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      if (a?.status !== "failed") continue;
      const first = String(Array.isArray(a.failureMessages) ? a.failureMessages[0] : "").split(/\r?\n/)[0];
      out.push(`${String(a.fullName ?? a.title ?? "(unnamed test)")} — ${first}`);
    }
  }
  return out;
}

async function main(argv) {
  const label = flagValue(argv, "--label") ?? "ci";
  const logPath = flagValue(argv, "--log");
  const outDir = flagValue(argv, "--out");
  const blocks = [];
  const annotations = [];

  if (logPath !== undefined) {
    const text = await readIfExists(logPath);
    if (text === null) {
      blocks.push(`(no ${logPath} — the failing step did not write one)`);
    } else {
      // The vitest summary itself names every failed test; the surrounding log is
      // kept only as the fallback when the summary is absent.
      const failed = interestingLines(text).filter((l) => /FAIL |AssertionError|expected |Error:/.test(l));
      const counts = interestingLines(text).filter((l) => /Test Files|Tests +\d|Failed Tests/.test(l));
      blocks.push(...counts, ...failed);
      annotations.push(...failed);
    }
  }

  if (outDir !== undefined) {
    const runText = await readIfExists(join(outDir, "closed-loop-run.json"));
    const run = runText === null ? null : JSON.parse(runText);
    if (run === null) {
      blocks.push(`(no ${join(outDir, "closed-loop-run.json")} — the runner did not reach its summary)`);
    } else {
      for (const p of Array.isArray(run.phases) ? run.phases : []) {
        blocks.push(`phase ${String(p.phase)}: ok=${String(p.ok)} code=${String(p.code)}`);
      }
      const failedPhase = (Array.isArray(run.phases) ? run.phases : []).find((p) => p.ok === false);
      if (failedPhase?.output !== undefined) {
        blocks.push(`--- ${String(failedPhase.phase)} output ---`);
        blocks.push(...interestingLines(String(failedPhase.output)));
      }
    }

    const vitestText = await readIfExists(join(outDir, "r97-r98.json"));
    if (vitestText !== null) {
      const failed = failedTestsFromVitestReport(JSON.parse(vitestText));
      if (failed.length > 0) {
        blocks.push("--- failing tests (structured report) ---");
        blocks.push(...failed);
      }
      annotations.push(...failed);
    }
  }

  const summary = [
    `### N3 diagnostics (${label})`,
    "",
    "```text",
    ...blocks.slice(0, MAX_SUMMARY_LINES),
    "```",
    "",
  ].join("\n");

  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (typeof summaryFile === "string" && summaryFile !== "") {
    await appendFile(summaryFile, summary, "utf8");
  } else {
    process.stdout.write(summary);
  }

  for (const line of annotations.slice(0, MAX_ANNOTATIONS)) {
    process.stdout.write(`::error::${escapeCommand(`[${label}] ${line}`)}\n`);
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // A diagnostic must never be the reason a job looks broken; say what went wrong
  // in the summary instead of failing.
  const note = `\n### N3 diagnostics failed to run\n\n\`\`\`text\n${String(err)}\n\`\`\`\n`;
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (typeof summaryFile === "string" && summaryFile !== "") await appendFile(summaryFile, note, "utf8");
  else process.stdout.write(note);
  process.exitCode = 0;
}