/**
 * N6 / N2 — the frozen main-experiment case set for
 * `context_safe_tool_call_efficiency_v1`.
 *
 * The plan requires, before any model result:
 *   - 24 cases: 16 evidence-missing (6 compact-drop / 4 preview / 4 rehydrate /
 *     2 partial) + 8 control (4 visible / 2 changed / 2 diagnostic);
 *   - EVERY case to have its own fixture and its own ORIGINAL command verifier,
 *     never one template renamed;
 *   - the frozen bytes to be re-derivable, so a later edit cannot silently
 *     change what was pre-registered.
 *
 * This suite asserts exactly that, and it goes one step further than shape
 * checks: it PROVES each verifier discriminates — it must FAIL on the shipped
 * fixture and PASS after the reference fix. A verifier that passes on the
 * unfixed fixture would certify nothing (and would make the later paired
 * experiment unreadable), so it fails here instead.
 *
 * Offline: the verifiers are `node` commands; no provider is constructed and no
 * network is used.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadBenchmarkCases } from "./baseline.js";
import { resolveBenchmarkCaseDir } from "./tool-call-efficiency-case-selection.js";

const REPO = resolve(import.meta.dirname, "../../..");
const CASE_ROOT = join(REPO, "benchmarks", "n6-evidence");
const MANIFEST_PATH = join(REPO, "docs", "evidence", "agent-next6-20261005", "case-manifest.json");

interface ManifestCase {
  caseId: string;
  suite: string;
  condition: string;
  tags: string[];
  contextBudgetTokens?: number;
  contentDigest: string;
  verifierDigest: string;
  eligibility: string;
  referenceFix: Record<string, string>;
  referenceRun: string[];
  request: string;
  expected: string;
}

interface Manifest {
  schemaVersion: string;
  candidateId: string;
  suite: { id: string; version: string; caseRoot: string };
  composition: Record<string, number>;
  cases: ManifestCase[];
  manifestDigest: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function tempWorkspace(caseId: string): string {
  const dir = mkdtempSync(join(tmpdir(), `n6-${caseId}-`));
  tempRoots.push(dir);
  cpSync(join(CASE_ROOT, caseId, "fixture"), dir, { recursive: true });
  return dir;
}

/** Run a command in a workspace; return only the exit status (no piped stdio). */
function runStatus(cwd: string, command: string, args: string[]): number {
  const result = spawnSync(command, args, { cwd, stdio: "ignore" });
  return result.status ?? -1;
}

function caseVerifier(caseId: string): { command: string; args: string[] } {
  const raw = JSON.parse(readFileSync(join(CASE_ROOT, caseId, "case.json"), "utf8")) as {
    verification: { kind: string; command: string; args: string[] }[];
  };
  const command = raw.verification.find((v) => v.kind === "command");
  if (command === undefined) throw new Error(`${caseId} has no command verifier`);
  return { command: command.command, args: command.args };
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

describe("N6/N2 — frozen main-experiment case set (24 cases)", () => {
  it("1. the manifest is the frozen catalog for this candidate and its composition matches the plan", () => {
    expect(manifest.schemaVersion).toBe("n6-evidence-case-manifest-v1");
    expect(manifest.candidateId).toBe("context_safe_tool_call_efficiency_v1");
    expect(manifest.suite.id).toBe("n6-evidence");
    expect(manifest.cases).toHaveLength(24);

    const counts: Record<string, number> = {};
    for (const c of manifest.cases) counts[c.condition] = (counts[c.condition] ?? 0) + 1;
    // 16 evidence-missing …
    expect(counts["compact-drop"]).toBe(6);
    expect(counts.preview).toBe(4);
    expect(counts.rehydrate).toBe(4);
    expect(counts.partial).toBe(2);
    // … + 8 control.
    expect(counts.visible).toBe(4);
    expect(counts.changed).toBe(2);
    expect(counts.diagnostic).toBe(2);
    const missing = (counts["compact-drop"] ?? 0) + (counts.preview ?? 0) + (counts.rehydrate ?? 0) + (counts.partial ?? 0);
    expect(missing).toBe(16);
    expect(24 - missing).toBe(8);
  });

  it("2. every case really loads through the benchmark loader, with its suite, fixtures and a command verifier", async () => {
    const loaded = await loadBenchmarkCases(CASE_ROOT);
    expect(loaded.map((c) => c.id).sort()).toEqual(manifest.cases.map((c) => c.caseId).sort());
    for (const c of loaded) {
      expect(c.requestMd.trim().length).toBeGreaterThan(0);
      expect(c.expected.status).toBe("completed");
      expect(c.suite).toBe("regression");
      expect(Object.keys(c.fixture).length).toBeGreaterThan(0);
      expect((c.verification ?? []).some((v) => v.kind === "command")).toBe(true);
    }
    // The case-local context budget is what makes the missing-evidence classes
    // deterministic; it must survive loading.
    for (const entry of manifest.cases) {
      const loadedCase = loaded.find((c) => c.id === entry.caseId)!;
      if (entry.contextBudgetTokens !== undefined) {
        expect(loadedCase.contextBudgetTokens).toBe(entry.contextBudgetTokens);
      }
    }
  });

  it("3. every case is independently resolvable by the selection path boundary", () => {
    for (const entry of manifest.cases) {
      const resolved = resolveBenchmarkCaseDir(REPO, entry.suite, entry.caseId);
      expect(resolved, `${entry.caseId} is not resolvable`).not.toBeNull();
      expect(dirname(resolved!)).toBe(join(REPO, "benchmarks", "n6-evidence"));
    }
    // The holdout suite stays refused by the same boundary (never leaked).
    expect(resolveBenchmarkCaseDir(REPO, "holdout", manifest.cases[0]!.caseId)).toBeNull();
  });

  it("4. no case is a renamed copy of another (distinct fixture bytes and task text)", () => {
    const digests = new Set(manifest.cases.map((c) => c.contentDigest));
    expect(digests.size).toBe(manifest.cases.length);
    const requests = new Set(manifest.cases.map((c) => c.request.trim()));
    expect(requests.size).toBe(manifest.cases.length);
    const requestsLower = new Set(manifest.cases.map((c) => c.request.trim().toLowerCase()));
    expect(requestsLower.size).toBe(manifest.cases.length);
  });

  it("5. the recorded content digest is a function of the REAL on-disk bytes", () => {
    for (const entry of manifest.cases) {
      const parts: string[] = [];
      const walk = (dir: string, prefix: string): void => {
        const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          const abs = join(dir, e.name);
          if (e.isDirectory()) walk(abs, `${prefix}${e.name}/`);
          else parts.push(`${prefix}${e.name}\u0000${sha256(lf(readFileSync(abs, "utf8")))}`);
        }
      };
      walk(join(CASE_ROOT, entry.caseId), "");
      const recomputed = sha256(parts.sort().join("\n"));
      expect(recomputed, `${entry.caseId} content digest drifted`).toBe(entry.contentDigest);
    }
  });

  it("6. every verifier DISCRIMINATES: it fails on the shipped fixture and passes after the reference fix", () => {
    for (const entry of manifest.cases) {
      const { command, args } = caseVerifier(entry.caseId);

      // RED — the shipped fixture must NOT satisfy its own verifier.
      const red = tempWorkspace(entry.caseId);
      const redStatus = runStatus(red, command, args);
      expect(redStatus, `${entry.caseId}: its verifier passes on the UNFIXED fixture`).not.toBe(0);

      // GREEN — the reference fix (and any setup step) must satisfy it.
      const green = tempWorkspace(entry.caseId);
      for (const script of entry.referenceRun) {
        expect(runStatus(green, process.execPath, [script]), `${entry.caseId}: reference step ${script} failed`).toBe(0);
      }
      for (const [rel, content] of Object.entries(entry.referenceFix)) {
        const abs = join(green, ...rel.split("/"));
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
      }
      expect(runStatus(green, command, args), `${entry.caseId}: its verifier fails on the REFERENCE fix`).toBe(0);
    }
  }, 300_000);

  it("7. the evidence-missing classes carry a case-local budget or an oversized spec (the condition is really constructed)", () => {
    for (const entry of manifest.cases) {
      if (entry.condition === "compact-drop" || entry.condition === "rehydrate" || entry.condition === "partial") {
        expect(entry.contextBudgetTokens, `${entry.caseId} has no case-local budget`).toBeGreaterThan(0);
      }
      if (entry.condition === "preview") {
        let biggest = 0;
        const walk = (dir: string): void => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const abs = join(dir, e.name);
            if (e.isDirectory()) walk(abs);
            else biggest = Math.max(biggest, Buffer.byteLength(readFileSync(abs, "utf8"), "utf8"));
          }
        };
        walk(join(CASE_ROOT, entry.caseId, "fixture"));
        // > the 16 KiB inline budget, so the model really sees head+tail only.
        expect(biggest, `${entry.caseId} has no file larger than the inline budget`).toBeGreaterThan(16 * 1024);
      }
    }
  });
});
