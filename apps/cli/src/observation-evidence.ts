/**
 * E4-R08 — runtime observation evidence.
 *
 * `observed` in the usage audit is no longer inferred from a symbol appearing in
 * an E2E-named file (a comment, string or import would count). Instead, a real
 * passing production-path test records an ObservationEvidence row AFTER its
 * assertions hold, and the audit marks a capability observed ONLY for rows that
 * say `runStatus: "passed"` and whose testedSourceSha matches the audited HEAD
 * (or either side is unknown — but a mismatch is a hard reject).
 *
 * The evidence is a JSONL file in a TEST/evidence directory (never the audit's
 * own output), so the audit consuming it does not recursively prove itself.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

export const OBSERVATION_EVIDENCE_SCHEMA_VERSION = "e4-r08-v1";

export interface ObservationEvidence {
  schemaVersion: typeof OBSERVATION_EVIDENCE_SCHEMA_VERSION;
  /** KEY_CAPABILITIES.capability id this row proves. */
  capabilityId: string;
  symbol: string;
  /** Which production entrypoint exercised it. */
  entrypoint: "cli" | "web" | "benchmark" | "release";
  testFile: string;
  testName: string;
  /** git HEAD at the time the test ran (null when not determinable). */
  testedSourceSha: string | null;
  runStatus: "passed";
  /** What actually ran (chain of real stages / events, not a name). */
  invocation: string;
  evidenceDigest: string;
}

/** Where the evidence lives. Tests may override via the env var so a run's
 *  evidence can be collected by the release gate without touching the audit's
 *  own output. */
export function observationEvidencePath(): string {
  return process.env.E2E_OBSERVATION_EVIDENCE ?? join(tmpdir(), "harness-observation-evidence.jsonl");
}

/** Append a PASSED observation row. Best-effort: a write failure is reported on
 *  the degraded channel (a noisy filesystem must not crash the test), but the
 *  audit will simply not see the row — so nothing is silently counted. */
export function observeCapability(
  ev: Omit<ObservationEvidence, "schemaVersion" | "runStatus" | "evidenceDigest">,
): void {
  const row: ObservationEvidence = {
    schemaVersion: OBSERVATION_EVIDENCE_SCHEMA_VERSION,
    runStatus: "passed",
    ...ev,
    evidenceDigest: "",
  };
  const body = { ...row };
  row.evidenceDigest = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
  try {
    const path = observationEvidencePath();
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  } catch (err) {
    process.stderr.write(
      `[degraded] observation-evidence append failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/** Read all rows (invalid lines are skipped with a degraded report, never
 *  trusted). */
export function loadObservationEvidence(path?: string): ObservationEvidence[] {
  const p = path ?? observationEvidencePath();
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out: ObservationEvidence[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as ObservationEvidence;
      if (row.schemaVersion !== OBSERVATION_EVIDENCE_SCHEMA_VERSION) continue;
      if (row.runStatus !== "passed") continue;
      out.push(row);
    } catch (err) {
      process.stderr.write(`[degraded] observation-evidence unreadable row: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return out;
}

/** git HEAD sha at audit/test time (null when the checkout is not a repo). */
export function gitHeadShaAt(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}