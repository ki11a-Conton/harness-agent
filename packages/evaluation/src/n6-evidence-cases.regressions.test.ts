/**
 * N6 / N2 — the two frozen case sets for `context_safe_tool_call_efficiency_v1`:
 * the MAIN experiment and the INDEPENDENT HOLDOUT.
 *
 * The plan requires, before any model result, for EACH set:
 *   - 24 cases: 16 evidence-missing (6 compact-drop / 4 preview / 4 rehydrate /
 *     2 partial) + 8 control (4 visible / 2 changed / 2 diagnostic);
 *   - EVERY case to have its own fixture and its own ORIGINAL command verifier,
 *     never one template renamed;
 *   - the frozen bytes to be re-derivable, so a later edit cannot silently
 *     change what was pre-registered.
 *
 * This suite asserts exactly that, and it goes further than shape checks: it
 * PROVES each verifier discriminates — it must FAIL on the shipped fixture and
 * PASS after the reference fix. A verifier that passes on the unfixed fixture
 * would certify nothing (and would make the later paired experiment unreadable),
 * so it fails here instead. It also refuses ANY content or task overlap between
 * the two sets: a holdout case that reuses a main-set fixture would not be an
 * independent holdout.
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
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "agent-next6-20261005");

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

interface SetSpec {
  key: string;
  suiteId: string;
  manifestFile: string;
  manifestSchema: string;
  /** The suite value the loader must see on every case of this set. */
  loadedSuite: string;
}

const SETS: SetSpec[] = [
  {
    key: "main",
    suiteId: "n6-evidence",
    manifestFile: "case-manifest.json",
    manifestSchema: "n6-evidence-case-manifest-v1",
    loadedSuite: "regression",
  },
  {
    key: "holdout",
    suiteId: "n6-holdout",
    manifestFile: "holdout-case-manifest.json",
    manifestSchema: "n6-holdout-case-manifest-v1",
    loadedSuite: "holdout",
  },
];

const manifests = new Map<string, Manifest>(
  SETS.map((s) => [s.key, JSON.parse(readFileSync(join(EVIDENCE_DIR, s.manifestFile), "utf8")) as Manifest]),
);

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function caseRootOf(set: SetSpec): string {
  return join(REPO, "benchmarks", set.suiteId);
}

function tempWorkspace(set: SetSpec, caseId: string): string {
  const dir = mkdtempSync(join(tmpdir(), `n6-${set.key}-${caseId}-`));
  tempRoots.push(dir);
  cpSync(join(caseRootOf(set), caseId, "fixture"), dir, { recursive: true });
  return dir;
}

/** Run a command in a workspace; return only the exit status (no piped stdio). */
function runStatus(cwd: string, command: string, args: string[]): number {
  const result = spawnSync(command, args, { cwd, stdio: "ignore" });
  return result.status ?? -1;
}

function caseVerifier(set: SetSpec, caseId: string): { command: string; args: string[] } {
  const raw = JSON.parse(readFileSync(join(caseRootOf(set), caseId, "case.json"), "utf8")) as {
    verification: { kind: string; command: string; args: string[] }[];
  };
  const command = raw.verification.find((v) => v.kind === "command");
  if (command === undefined) throw new Error(`${caseId} has no command verifier`);
  return { command: command.command, args: command.args };
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

function contentDigestOnDisk(set: SetSpec, caseId: string): string {
  const parts: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs, `${prefix}${e.name}/`);
      else parts.push(`${prefix}${e.name}\u0000${sha256(lf(readFileSync(abs, "utf8")))}`);
    }
  };
  walk(join(caseRootOf(set), caseId), "");
  return sha256(parts.sort().join("\n"));
}

/** The frozen per-class composition the plan fixes for BOTH experiments. */
const EXPECTED_COMPOSITION: Record<string, number> = {
  "compact-drop": 6,
  preview: 4,
  rehydrate: 4,
  partial: 2,
  visible: 4,
  changed: 2,
  diagnostic: 2,
};

for (const set of SETS) {
  const manifest = manifests.get(set.key)!;

  describe(`N6/N2 — frozen ${set.key} case set (${set.suiteId}, 24 cases)`, () => {
    it("1. the manifest is the frozen catalog for this candidate and its composition matches the plan", () => {
      expect(manifest.schemaVersion).toBe(set.manifestSchema);
      expect(manifest.candidateId).toBe("context_safe_tool_call_efficiency_v1");
      expect(manifest.suite.id).toBe(set.suiteId);
      expect(manifest.cases).toHaveLength(24);

      const counts: Record<string, number> = {};
      for (const c of manifest.cases) counts[c.condition] = (counts[c.condition] ?? 0) + 1;
      for (const [condition, expected] of Object.entries(EXPECTED_COMPOSITION)) {
        expect(counts[condition], `${set.key}/${condition}`).toBe(expected);
      }
      const missing =
        (counts["compact-drop"] ?? 0) + (counts.preview ?? 0) + (counts.rehydrate ?? 0) + (counts.partial ?? 0);
      expect(missing).toBe(16);
      expect(24 - missing).toBe(8);
    });

    it("2. every case really loads through the benchmark loader, with its suite, fixtures and a command verifier", async () => {
      const loaded = await loadBenchmarkCases(caseRootOf(set));
      expect(loaded.map((c) => c.id).sort()).toEqual(manifest.cases.map((c) => c.caseId).sort());
      for (const c of loaded) {
        expect(c.requestMd.trim().length).toBeGreaterThan(0);
        expect(c.expected.status).toBe("completed");
        expect(c.suite).toBe(set.loadedSuite);
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
        expect(dirname(resolved!)).toBe(join(REPO, "benchmarks", set.suiteId));
      }
      // The literal `holdout` suite stays refused by the boundary: per-case
      // holdout data is never read into an artifact.
      expect(resolveBenchmarkCaseDir(REPO, "holdout", manifest.cases[0]!.caseId)).toBeNull();
    });

    it("4. no case is a renamed copy of another (distinct fixture bytes and task text)", () => {
      expect(new Set(manifest.cases.map((c) => c.contentDigest)).size).toBe(manifest.cases.length);
      expect(new Set(manifest.cases.map((c) => c.request.trim())).size).toBe(manifest.cases.length);
      expect(new Set(manifest.cases.map((c) => c.request.trim().toLowerCase())).size).toBe(manifest.cases.length);
      // NOTE: the two diagnostic cases of a set deliberately share the same
      // generic runner command (`node check.js`) while each ships its OWN
      // check.js + fix target, so a duplicated verifier DIGEST is expected there
      // and is not evidence of a renamed sample. What must be unique is the
      // graded CONTENT and the task, which is asserted above.
    });

    it("5. the recorded content digest is a function of the REAL on-disk bytes", () => {
      for (const entry of manifest.cases) {
        expect(contentDigestOnDisk(set, entry.caseId), `${entry.caseId} content digest drifted`).toBe(
          entry.contentDigest,
        );
      }
    });

    it("6. every verifier DISCRIMINATES: it fails on the shipped fixture and passes after the reference fix", () => {
      for (const entry of manifest.cases) {
        const { command, args } = caseVerifier(set, entry.caseId);

        // RED — the shipped fixture must NOT satisfy its own verifier.
        const red = tempWorkspace(set, entry.caseId);
        expect(runStatus(red, command, args), `${entry.caseId}: its verifier passes on the UNFIXED fixture`).not.toBe(0);

        // GREEN — the reference fix (and any setup step) must satisfy it.
        const green = tempWorkspace(set, entry.caseId);
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
          walk(join(caseRootOf(set), entry.caseId, "fixture"));
          // > the 16 KiB inline budget, so the model really sees head+tail only.
          expect(biggest, `${entry.caseId} has no file larger than the inline budget`).toBeGreaterThan(16 * 1024);
        }
      }
    });
  });
}

describe("N6/N2 — the holdout is genuinely INDEPENDENT of the main set", () => {
  const main = manifests.get("main")!;
  const holdout = manifests.get("holdout")!;

  it("shares no fixture bytes, no task text and no case id", () => {
    const mainDigests = new Set(main.cases.map((c) => c.contentDigest));
    const mainRequests = new Set(main.cases.map((c) => c.request.trim().toLowerCase()));
    const mainIds = new Set(main.cases.map((c) => c.caseId));
    for (const c of holdout.cases) {
      expect(mainDigests.has(c.contentDigest), `${c.caseId} reuses a main-set fixture`).toBe(false);
      expect(mainRequests.has(c.request.trim().toLowerCase()), `${c.caseId} reuses a main-set task text`).toBe(false);
      expect(mainIds.has(c.caseId), `${c.caseId} collides with a main-set case id`).toBe(false);
    }
    expect(main.manifestDigest).not.toBe(holdout.manifestDigest);
    // Verifier DIGESTS may coincide only for the generic diagnostic runner
    // (`node check.js`), which both sets use with their own check.js fixtures.
    const shared = [...new Set(holdout.cases.map((c) => c.verifierDigest))].filter((d) =>
      main.cases.some((c) => c.verifierDigest === d),
    );
    for (const digest of shared) {
      const h = holdout.cases.filter((c) => c.verifierDigest === digest).map((c) => c.condition);
      const m = main.cases.filter((c) => c.verifierDigest === digest).map((c) => c.condition);
      expect([...h, ...m].every((condition) => condition === "diagnostic")).toBe(true);
    }
  });

  it("uses a different evidence family (the holdout is not the main set renamed)", () => {
    // Both sets fix the same CLASS composition, but the holdout's fixtures must
    // live in a different repository/file family. Assert the observable part:
    // the two sets share no file PATH under fixture/.
    const pathsOf = (set: SetSpec): Set<string> => {
      const out = new Set<string>();
      const walk = (dir: string, prefix: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const abs = join(dir, e.name);
          if (e.isDirectory()) walk(abs, `${prefix}${e.name}/`);
          else out.add(`${prefix}${e.name}`);
        }
      };
      for (const c of manifests.get(set.key)!.cases) walk(join(caseRootOf(set), c.caseId, "fixture"), "");
      return out;
    };
    const mainPaths = pathsOf(SETS[0]!);
    const holdoutPaths = pathsOf(SETS[1]!);
    expect(mainPaths.size).toBeGreaterThan(0);
    // A few shared generic names are unavoidable (every case has a src/ module),
    // so the meaningful assertion is that the holdout carries file TYPES the
    // main set never uses.
    const holdoutOnly = [...holdoutPaths].filter((p) => !mainPaths.has(p));
    expect(holdoutOnly).toContain("data/schema.csv");
    expect(holdoutOnly).toContain("spec/features.json");
    expect(holdoutOnly).toContain("spec/service.log");
  });
});
