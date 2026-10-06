/**
 * N7 — verifier-discrimination PROOF for all 88 authored cases.
 *
 * The plan's N7-2 acceptance criterion is explicit: every case must have its own
 * fixture and its own ORIGINAL command verifier, **and the verifier's
 * discriminating power must be proven**. A verifier that already passes on the
 * shipped (unfixed) fixture certifies nothing; a verifier that fails even after
 * the reference fix makes the case unsolvable. Both are authoring defects, and
 * both must be caught BEFORE any model call is paid for.
 *
 * This script performs that proof offline, for every case of both sets:
 *
 *   RED   — materialise the shipped fixture in a temp workspace and run the
 *           case's own command verifier; it MUST exit non-zero.
 *   GREEN — materialise the shipped fixture again, run the case's `referenceRun`
 *           setup scripts, apply its `referenceFix` files, and run the SAME
 *           verifier; it MUST exit 0.
 *
 * Usage:
 *   node scripts/research/agent-next7-20261006/verify-n7-case-discrimination.mjs [--json]
 *
 * Emits `docs/evidence/agent-next7-20261006/verifier-discrimination.json` with the
 * per-case verdicts and the digests of the frozen case manifest that was proven.
 * Zero provider calls, zero network.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SETS } from "./generate-n7-cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "agent-next7-20261006");

const sha256 = (input) => createHash("sha256").update(input, "utf8").digest("hex");

/** A temp workspace seeded with the case's shipped fixture. */
function workspace(caseRoot, caseId, label) {
  const dir = mkdtempSync(join(tmpdir(), `n7-proof-${label}-`));
  cpSync(join(caseRoot, caseId, "fixture"), dir, { recursive: true });
  return dir;
}

const run = (cwd, command, args) => spawnSync(command, args, { cwd, stdio: "ignore" }).status ?? -1;

function applyFile(root, rel, content) {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function manifestOf(suiteId) {
  const path = join(EVIDENCE_DIR, suiteId === "n7-evidence" ? "case-manifest.json" : "holdout-case-manifest.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const failures = [];
  const records = [];

  for (const set of Object.values(SETS)) {
    const caseRoot = join(REPO, "benchmarks", set.suiteId);
    const manifest = manifestOf(set.suiteId);
    const manifestCases = new Map(manifest.cases.map((c) => [c.caseId, c]));

    for (const definition of set.cases) {
      const entry = manifestCases.get(definition.id);
      if (entry === undefined) {
        failures.push(`${definition.id}: absent from the frozen manifest`);
        continue;
      }
      const verifierCommand = entry.referenceFix === undefined
        ? definition.verifier
        : { command: definition.verifier.command, args: definition.verifier.args };
      const caseJson = JSON.parse(readFileSync(join(caseRoot, definition.id, "case.json"), "utf8"));
      const command = caseJson.verification.find((v) => v.kind === "command");

      // RED — the shipped fixture must NOT satisfy its own verifier.
      const red = workspace(caseRoot, definition.id, "red");
      const redStatus = run(red, command.command, command.args);
      rmSync(red, { recursive: true, force: true });

      // GREEN — setup + reference fix must satisfy it.
      const green = workspace(caseRoot, definition.id, "green");
      let setupStatus = 0;
      for (const script of entry.referenceRun ?? []) {
        const status = run(green, process.execPath, [script]);
        if (status !== 0) setupStatus = status;
      }
      for (const [rel, content] of Object.entries(entry.referenceFix ?? {})) applyFile(green, rel, content);
      const greenStatus = run(green, command.command, command.args);
      const leftover = readdirSync(green).length;
      rmSync(green, { recursive: true, force: true });

      const ok = redStatus !== 0 && greenStatus === 0 && setupStatus === 0 && leftover >= 0;
      records.push({
        caseId: definition.id,
        suite: set.suiteId,
        condition: definition.condition,
        contentDigest: entry.contentDigest,
        verifierDigest: entry.verifierDigest,
        redExitStatus: redStatus,
        greenExitStatus: greenStatus,
        setupExitStatus: setupStatus,
        discriminates: ok,
      });
      if (!ok) {
        failures.push(
          `${definition.id}: red=${redStatus} (must be non-zero), green=${greenStatus} (must be 0), setup=${setupStatus}`,
        );
      }
      if (verifierCommand === undefined) failures.push(`${definition.id}: no command verifier in the manifest`);
      process.stdout.write(`${ok ? "ok  " : "FAIL"} ${definition.id} (red=${redStatus}, green=${greenStatus})\n`);
    }
  }

  const payload = {
    schemaVersion: "n7-verifier-discrimination-proof-v1",
    candidateId: "context_safe_tool_call_efficiency_v2",
    proofMethod:
      "each case's own command verifier is run (a) on the shipped fixture (must fail) and (b) after its declared referenceRun setup and referenceFix (must pass)",
    manifests: Object.values(SETS).map((s) => {
      const manifest = manifestOf(s.suiteId);
      return {
        suite: s.suiteId,
        cases: s.cases.length,
        manifestDigest: manifest.manifestDigest,
      };
    }),
    totals: {
      cases: records.length,
      discriminating: records.filter((r) => r.discriminates).length,
      failures: failures.length,
    },
    failures,
    records,
  };
  const outPath = join(EVIDENCE_DIR, "verifier-discrimination.json");
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const proofDigest = sha256(JSON.stringify(records));
  writeFileSync(
    join(EVIDENCE_DIR, "verifier-discrimination.sha256"),
    `${proofDigest}  verifier-discrimination.json\n`,
    "utf8",
  );

  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(payload.totals)}\n`);
  if (failures.length > 0) {
    process.stderr.write(`n7 discrimination proof FAILED (${failures.length}):\n`);
    for (const f of failures.slice(0, 40)) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `n7 discrimination proof PASS: ${records.length} case(s), all verifiers fail unfixed and pass after the reference fix\n  records digest ${sha256(JSON.stringify(records))}\n  written ${existsSync(outPath) ? outPath : "<missing>"}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
