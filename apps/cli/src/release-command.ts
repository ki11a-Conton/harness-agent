/**
 * P36-1 — `agent release verify` CLI command.
 *
 * Resolves the current HEAD, ingests authoritative per-gate evidence from
 * `.ci/evidence/*.json` (or an explicit dir), and computes the release
 * verdict. A verdict is READY only when EVERY required gate is passed at the
 * exact release HEAD. Any failed / not_run / blocked / stale gate → non-zero.
 */
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommandResult } from "./commands.js";
import {
  computeReleaseVerdict,
  parseGateEvidence,
  renderReleaseVerdict,
  type ReleaseGateResult,
  type ReleaseVerdict,
} from "./release-verify.js";

export interface ReleaseVerifyOptions {
  root?: string;
  /** Evidence directory (default `<root>/.ci/evidence`). */
  evidenceDir?: string;
  /** Override HEAD resolution (tests). */
  headSha?: string;
}

const EVIDENCE_FILES = [
  "typecheck.json",
  "test.json",
  "build.json",
  "coverage.json",
  "docs.json",
  "benchmark-smoke.json",
  "protocol.json",
  "security.json",
  "race.json",
  "chaos.json",
  "capability-audit.json",
];

async function detectHead(root: string): Promise<string> {
  return new Promise((resolveSha, reject) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err !== null) {
        reject(new Error(`cannot resolve HEAD in ${root}: ${err.message}`));
        return;
      }
      resolveSha(String(stdout).trim());
    });
  });
}

async function readGateEvidence(dir: string): Promise<ReleaseGateResult[]> {
  const gates: ReleaseGateResult[] = [];
  const seen = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Evidence dir missing → all gates are not_run (fail closed).
    return [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    const text = await readFile(path, "utf8");
    const gate = parseGateEvidence(text, path);
    if (seen.has(gate.id)) {
      throw new Error(`duplicate evidence for gate ${gate.id} (${path})`);
    }
    seen.add(gate.id);
    gates.push(gate);
  }
  void EVIDENCE_FILES; // naming convention documented; discovery is by *.json
  return gates;
}

/** Resolve a verdict from evidence on disk (used by the CLI and tests). */
export async function resolveReleaseVerdict(opts: ReleaseVerifyOptions): Promise<{
  verdict: ReleaseVerdict;
  headSha: string;
}> {
  const root = resolve(opts.root ?? process.cwd());
  const headSha = opts.headSha ?? (await detectHead(root));
  const evidenceDir = resolve(opts.evidenceDir ?? join(root, ".ci", "evidence"));
  const gates = await readGateEvidence(evidenceDir);
  const verdict = computeReleaseVerdict({ headSha, gates });
  return { verdict, headSha };
}

/** `agent release verify [--json] [--evidence-dir <dir>]` */
export async function releaseVerifyCmd(rest: string[], cliOpts: ReleaseVerifyOptions = {}): Promise<CommandResult> {
  let json = false;
  let explicitEvidenceDir: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--evidence-dir") {
      explicitEvidenceDir = rest[i + 1];
      i += 1;
    } else {
      return { exitCode: 1, lines: [`agent release verify: unknown flag: ${arg ?? "(none)"}`, "", "usage: agent release verify [--json] [--evidence-dir <dir>]"] };
    }
  }
  try {
    const { verdict } = await resolveReleaseVerdict({ ...cliOpts, evidenceDir: explicitEvidenceDir ?? cliOpts.evidenceDir });
    if (json) {
      return { exitCode: verdict.ready ? 0 : 1, lines: [JSON.stringify(verdict, null, 2)] };
    }
    return { exitCode: verdict.ready ? 0 : 1, lines: renderReleaseVerdict(verdict) };
  } catch (err) {
    return { exitCode: 1, lines: [`agent release verify failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}
