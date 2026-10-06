/**
 * N6 / N5 — promote a campaign's evidence into the repository.
 *
 * The raw campaign bundle is large (a per-arm journal with full outcomes and a
 * multi-megabyte finalized-pairs file), so it stays in the gitignored `.ci`
 * working area while this script commits what a reviewer can actually verify:
 *
 *   - a COMPACT per-pair / per-arm summary (status, verified pass, metrics,
 *     activation, security kind, grade) — the numbers the gates were computed
 *     from, small enough to read;
 *   - the frozen pre-registration digest, execution identity and judge result;
 *   - RAW-MANIFEST.json: the sha256 of EVERY file of the raw bundle (including
 *     the huge ones), so the raw bytes are identifiable and checkable from the
 *     committed digest list without committing gigabytes.
 *
 * It REFUSES to promote evidence that was never judged: an unjudged campaign has
 * no verdict, and committing its bundle as "evidence" would imply one.
 *
 * Usage:
 *   node scripts/research/agent-next6-20261005/promote-n5-evidence.mjs \
 *     --experiment main|holdout --campaign <dir> --judge <dir> [--out <docs dir>]
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EV = join(REPO, "docs", "evidence", "agent-next6-20261005");

const arg = (name, fallback = undefined) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return process.argv[process.argv.indexOf(`--${name}`) + 1];
  return fallback;
};

const experiment = arg("experiment", "main");
const campaignDir = resolve(arg("campaign", join(REPO, ".ci", "n6-n5", experiment)));
const judgeDir = resolve(arg("judge", join(REPO, ".ci", "n6-n5", `${experiment}-judge`)));
const outDir = resolve(arg("out", join(EV, "n5", experiment)));

function refuse(code, message) {
  process.stderr.write(`promote-n5-evidence[${code}]: ${message}\n`);
  process.exit(1);
}

for (const [label, path] of [
  ["campaign-header.json", join(campaignDir, "campaign-header.json")],
  ["campaign-result.json", join(campaignDir, "campaign-result.json")],
  ["judge-result.json", join(judgeDir, "judge-result.json")],
]) {
  if (!existsSync(path)) refuse("MISSING_INPUT", `${label} not found at ${path.replace(REPO, ".")}`);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const header = readJson(join(campaignDir, "campaign-header.json"));
const result = readJson(join(campaignDir, "campaign-result.json"));
const judge = readJson(join(judgeDir, "judge-result.json"));

if (judge.frozenPreregistrationDigest !== header.frozenPreregistrationDigest) {
  refuse(
    "PREREG_MISMATCH",
    `the judge judged ${String(judge.frozenPreregistrationDigest)} but the campaign ran ${String(header.frozenPreregistrationDigest)}`,
  );
}
if (header.smoke === true) {
  refuse("SMOKE_CAMPAIGN", "this campaign was a smoke run (--limit) and is not experiment evidence");
}
// An infrastructure-aborted run (provider unreachable) measures the network, not
// the strategy: its pairs are invalid, and promoting it would dress that up as an
// effect. Only a completed ("ok") campaign may be promoted.
if (result.status !== "ok") {
  refuse(
    "CAMPAIGN_NOT_OK",
    `the campaign result status is "${String(result.status)}"${result.reason === undefined ? "" : `: ${String(result.reason)}`} — only a completed campaign is evidence`,
  );
}

// A campaign whose pairs mostly failed to complete is an infrastructure event,
// not a measurement: the holdout's first attempt had 90 of 96 pairs partial
// because the endpoint was unreachable (`fetch failed`, 0 model calls per arm).
// The declared tolerance is 5% of pairs.
const finalized = existsSync(join(campaignDir, "finalized-pairs.json"))
  ? readJson(join(campaignDir, "finalized-pairs.json"))
  : [];
const partial = existsSync(join(campaignDir, "partial-pairs.json"))
  ? readJson(join(campaignDir, "partial-pairs.json"))
  : [];

// A campaign whose pairs mostly failed to complete is an infrastructure event,
// not a measurement: the holdout's first attempt had 90 of 96 pairs partial
// because the endpoint was unreachable (`fetch failed`, 0 model calls per arm).
// The declared tolerance is 5% of pairs.
{
  const pairs = finalized.length + partial.length;
  const ratio = pairs === 0 ? 1 : partial.length / pairs;
  if (ratio > 0.05) {
    refuse(
      "PARTIAL_RATIO_TOO_HIGH",
      `${partial.length}/${pairs} pairs are partial (${(ratio * 100).toFixed(1)}% > 5%) — this is an infrastructure failure, not a measurement`,
    );
  }
}

/** The compact record the gates were computed from. */
const armSummary = (outcome) => ({
  caseId: outcome.caseId,
  status: outcome.status,
  verifiedPass: outcome.status === "passed",
  grade: outcome.grade ?? null,
  securityKind: outcome.securityOutcome?.kind ?? null,
  hardBreach: outcome.securityOutcome?.hardBreach ?? null,
  activation: {
    events: (outcome.activationEvidenceV2?.events ?? []).map((e) => `${e.mechanism}:${String(e.payload?.guidanceVersion)}`),
    activated: outcome.activationEvidenceV2?.aggregation?.activated ?? 0,
    validationOk: outcome.activationEvidenceV2?.validation?.ok ?? null,
  },
  metrics: {
    modelCalls: outcome.metrics?.model_call_count ?? 0,
    toolCalls: outcome.metrics?.tool_call_count ?? 0,
    tokensInput: outcome.metrics?.tokens_input ?? 0,
    tokensOutput: outcome.metrics?.tokens_output ?? 0,
    usageUnknown: outcome.metrics?.usage_unknown ?? 0,
    durationMs: outcome.metrics?.duration_ms ?? 0,
    verificationFailures: outcome.metrics?.verification_failures ?? 0,
  },
});

const pairsSummary = {
  schemaVersion: "n6-n5-pairs-summary-v1",
  experiment,
  frozenPreregistrationDigest: header.frozenPreregistrationDigest,
  executionIdentityDigest: result.executionIdentityDigest ?? null,
  planDigest: result.planDigest ?? header.plan?.planDigest ?? null,
  armMapping: header.armMapping,
  finalizedPairs: finalized.length,
  partialPairs: partial.length,
  pairs: finalized.map((p) => ({
    pairId: p.pairId,
    caseId: p.caseId,
    repetition: p.repetition,
    order: p.order,
    baseline: armSummary(p.baseline.outcome),
    candidate: armSummary(p.candidate.outcome),
  })),
  partial: partial.map((p) => ({ pairId: p.pairId, caseId: p.caseId, repetition: p.repetition, order: p.order })),
};

/** sha256 of every file of the raw bundle, including the huge ones. */
function rawManifest(dir, base = dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!statSync(abs).isFile()) continue;
      const bytes = readFileSync(abs);
      files.push({
        file: relative(base, abs).split("\\").join("/"),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  walk(dir);
  return files;
}

mkdirSync(outDir, { recursive: true });
for (const name of ["campaign-header.json", "execution-identity.json", "campaign-result.json"]) {
  const src = join(campaignDir, name);
  if (existsSync(src)) copyFileSync(src, join(outDir, name));
}
copyFileSync(join(judgeDir, "judge-result.json"), join(outDir, "judge-result.json"));
writeFileSync(join(outDir, "pairs-summary.json"), `${JSON.stringify(pairsSummary, null, 2)}\n`, "utf8");

const rawFiles = [...rawManifest(campaignDir), ...rawManifest(judgeDir)];
writeFileSync(
  join(outDir, "RAW-MANIFEST.json"),
  `${JSON.stringify(
    {
      schemaVersion: "n6-n5-raw-manifest-v1",
      experiment,
      note:
        "The raw bundle (per-arm journal with full outcomes) stays in the gitignored .ci working area; these digests identify it. " +
        "pairs-summary.json carries the compact per-arm records the gates were computed from.",
      rawBundleRoot: campaignDir.replace(REPO, ".").split("\\").join("/"),
      judgeRoot: judgeDir.replace(REPO, ".").split("\\").join("/"),
      totalFiles: rawFiles.length,
      totalBytes: rawFiles.reduce((acc, f) => acc + f.bytes, 0),
      files: rawFiles,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(
  `promoted ${experiment}: ${finalized.length} finalized / ${partial.length} partial pairs, verdict ${String(judge.verdict)}\n` +
    `  raw bundle: ${rawFiles.length} files, ${(rawFiles.reduce((a, f) => a + f.bytes, 0) / 1e6).toFixed(1)} MB indexed\n` +
    `  out: ${outDir.replace(REPO, ".")}\n`,
);
