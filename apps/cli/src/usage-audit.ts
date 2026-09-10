/**
 * E4-10 — production usage audit.
 *
 * For each key capability, classify how far it has actually reached in the
 * product, from evidence on disk (never a hand-maintained table):
 *
 *   exported  — the symbol is re-exported from a package index (public surface)
 *   tested    — a *.test.ts references it
 *   wired     — a NON-test production source references it (reachable from an
 *               entry point: createHarness / main / commands)
 *   observed  — an end-to-end production-path test actually exercises it
 *
 * A capability that is only `exported` (public symbol, no production caller) is
 * reported as such — the audit's whole purpose is to surface "exported but not
 * wired" and "wired but never observed" gaps rather than let a capability table
 * claim more than the code proves.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitHeadShaAt, loadAllObservationEvidence, loadObservationEvidence, type ObservationEvidence } from "./observation-evidence.js";

export type UsageLevel = "exported" | "tested" | "wired" | "observed";

export interface CapabilityUsage {
  capability: string;
  symbol: string;
  exported: boolean;
  tested: boolean;
  wired: boolean;
  observed: boolean;
  /** The highest level reached (exported < tested < wired < observed). */
  level: UsageLevel;
  wiredBy: string[];
  observedBy: string[];
}

export interface UsageAuditResult {
  capabilities: CapabilityUsage[];
  ok: boolean;
  /** Capabilities that did NOT reach `observed`. */
  notObserved: string[];
}

/** The key capabilities E4-10 requires to be observed end-to-end. */
export const KEY_CAPABILITIES: ReadonlyArray<{ capability: string; symbol: string }> = [
  { capability: "createActivationRecorderV2", symbol: "createActivationRecorderV2" },
  { capability: "classifySecurityOutcomeV2", symbol: "buildSecurityOutcomeFromEventsV2" },
  { capability: "canonical V3 writer", symbol: "writeExperimentArtifactV3" },
  { capability: "strict promotion loader", symbol: "loadPromotionEnvelope" },
  { capability: "resolveChampionHarness", symbol: "resolveChampionHarness" },
  { capability: "durable RecoveryStore", symbol: "DurableRecoveryStore" },
  { capability: "GateEvidenceV2 generator", symbol: "runGateV2" },
];

const IGNORED = new Set(["node_modules", "dist", ".git", "coverage"]);

interface ScannedFile {
  path: string; // repo-relative
  src: string;
  isTest: boolean;
  isIndex: boolean;
  isE2E: boolean;
  isAuditor: boolean;
}

function collectTs(dir: string, root: string, out: ScannedFile[] = []): ScannedFile[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED.has(entry.name)) collectTs(join(dir, entry.name), root, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const abs = join(dir, entry.name);
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const rel = abs.slice(root.length + 1).replace(/\\/g, "/");
    out.push({
      path: rel,
      src,
      isTest: entry.name.endsWith(".test.ts"),
      isIndex: entry.name === "index.ts",
      isE2E: /e2e|production-e2e|production-path/.test(entry.name),
      // The auditor's own module lists the symbols as strings — never count it.
      isAuditor: /usage-audit\.ts$/.test(rel),
    });
  }
  return out;
}

function rank(exported: boolean, tested: boolean, wired: boolean, observed: boolean): UsageLevel {
  if (observed) return "observed";
  if (wired) return "wired";
  if (tested) return "tested";
  if (exported) return "exported";
  return "exported"; // absent — reported via exported=false below
}

export function runUsageAudit(deps: {
  root: string;
  capabilities?: ReadonlyArray<{ capability: string; symbol: string }>;
  /** E4-R18 (N16): the SPECIFIC test-run whose committed evidence decides
   *  `observed`. Release-grade auditing passes a runId so an old successful run
   *  can never mask a current failure. When absent, every committed run file is
   *  scanned (diagnostic mode). */
  runId?: string;
  /** Audited HEAD for sha matching (defaults to git rev-parse of `root`). */
  headSha?: string | null;
}): UsageAuditResult {
  const files = collectTs(deps.root, deps.root);
  const caps = deps.capabilities ?? KEY_CAPABILITIES;
  // E4-R08 (F17): `observed` is decided ONLY from runtime ObservationEvidence —
  // never from a file name, a comment, a string, an import or `typeof`.
  // E4-R18 (N15): strict observed requires BOTH the audited HEAD and the row's
  // testedSourceSha to be KNOWN and EXACTLY equal (an unknown SHA is diagnostic
  // only), the row's symbol to match the registered capability symbol, and the
  // row's testFile to exist under the audited root. The evidence itself was
  // strict-parsed (digest recomputed, runId isolated, committed after the test
  // passed).
  const headSha = deps.headSha !== undefined ? deps.headSha : gitHeadShaAt(deps.root);
  const evidence = deps.runId !== undefined ? loadObservationEvidence(deps.runId) : loadAllObservationEvidence();
  const evidenceFor = (capability: string, symbol: string): ObservationEvidence[] =>
    evidence.filter((e) => {
      if (e.capabilityId !== capability) return false;
      // E4-R18: a row naming a different symbol is not evidence for this
      // capability (a wrong-symbol row can never satisfy a registration).
      if (e.symbol !== symbol) return false;
      // E4-R18: exact SHA match — an unknown SHA on either side is NOT strict
      // observed (diagnostic only).
      if (headSha === null || e.testedSourceSha !== headSha) return false;
      // E4-R18: the row's testFile must be a real file under the audited root —
      // a fictional/absent test file proves nothing.
      if (!files.some((f) => f.path === e.testFile)) return false;
      return true;
    });
  const capabilities: CapabilityUsage[] = [];
  for (const { capability, symbol } of caps) {
    const re = new RegExp(`\\b${symbol}\\b`);
    // A file that DEFINES the symbol is not a consumer of it.
    const defRe = new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let)\\s+${symbol}\\b|export\\s*\\{[^}]*\\b${symbol}\\b`);
    const isDefinition = (f: ScannedFile): boolean => defRe.test(f.src);
    const exported = files.some((f) => f.isIndex && !f.isAuditor && re.test(f.src));
    const tested = files.some((f) => f.isTest && !f.isE2E && !f.isAuditor && re.test(f.src));
    const wiredFiles = files.filter((f) => !f.isTest && !f.isIndex && !f.isAuditor && !isDefinition(f) && re.test(f.src));
    const wired = wiredFiles.length > 0;
    // E4-R08: OBSERVED requires a passed, sha-matched runtime evidence row; the
    // old E2E-filename/text scan is gone (a comment would have counted).
    const observedRows = evidenceFor(capability, symbol);
    const observed = observedRows.length > 0;
    capabilities.push({
      capability,
      symbol,
      exported,
      tested,
      wired,
      observed,
      level: rank(exported, tested, wired, observed),
      wiredBy: wiredFiles.map((f) => f.path).slice(0, 6),
      observedBy: observedRows.map((e) => `${e.testFile}:${e.testName} (${e.invocation})`).slice(0, 6),
    });
  }
  const notObserved = capabilities.filter((c) => !c.observed).map((c) => c.capability);
  return { capabilities, ok: notObserved.length === 0, notObserved };
}

export function renderUsageAudit(result: UsageAuditResult): string[] {
  const lines = ["production usage audit (exported < tested < wired < observed):"];
  for (const c of result.capabilities) {
    const flags = [c.exported && "exported", c.tested && "tested", c.wired && "wired", c.observed && "observed"].filter(Boolean).join(",") || "ABSENT";
    lines.push(`  ${c.observed ? "PASS" : "FAIL"}  ${c.capability.padEnd(28)} [${flags}]  level=${c.level}`);
    if (!c.observed) {
      lines.push(`         wired by: ${c.wiredBy.join(", ") || "(none)"}; observed by: ${c.observedBy.join(", ") || "(none)"}`);
    }
  }
  lines.push(result.ok ? "usage audit: PASS (all key capabilities observed)" : `usage audit: FAIL (${result.notObserved.length} not observed: ${result.notObserved.join(", ")})`);
  return lines;
}
