/**
 * E4-10 — production usage audit tests.
 *
 * The audit must classify honestly from on-disk evidence and must NOT let a
 * capability claim more reach than the code proves (the "exported but never
 * wired" gap is the whole point).
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runUsageAudit, renderUsageAudit, KEY_CAPABILITIES } from "./usage-audit.js";

let root = "";
async function makeRoot(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "usage-audit-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}
afterAll(async () => { if (root !== "") await rm(root, { recursive: true, force: true }); });

describe("E4-10 production usage audit", () => {
  it("observed > wired > tested > exported: a symbol in an e2e reaches observed", async () => {
    await makeRoot({
      "packages/x/src/index.ts": "export * from './a.js';\nexport function theThing(){}\n",
      "packages/x/src/a.ts": "export function theThing(){}\n",
      "packages/x/src/a.test.ts": "import { theThing } from './a.js'; theThing();\n",
      "apps/cli/src/prod.ts": "import { theThing } from '@ar/x'; theThing();\n",
      "apps/cli/src/e4-09-production-e2e.test.ts": "import { theThing } from '@ar/x'; theThing();\n",
    });
    const r = runUsageAudit({ root, capabilities: [{ capability: "the thing", symbol: "theThing" }] });
    const c = r.capabilities[0]!;
    expect(c.exported).toBe(true);
    expect(c.tested).toBe(true);
    expect(c.wired).toBe(true);
    expect(c.observed).toBe(true);
    expect(c.level).toBe("observed");
    expect(r.ok).toBe(true);
  });

  it("wired but NOT observed is reported honestly (not promoted to observed)", async () => {
    await makeRoot({
      "packages/x/src/index.ts": "export function wiredOnly(){}\n",
      "apps/cli/src/prod.ts": "import { wiredOnly } from '@ar/x'; wiredOnly();\n",
      "packages/x/src/x.test.ts": "import { wiredOnly } from './index.js'; wiredOnly();\n",
    });
    const r = runUsageAudit({ root, capabilities: [{ capability: "wired only", symbol: "wiredOnly" }] });
    const c = r.capabilities[0]!;
    expect(c.wired).toBe(true);
    expect(c.observed).toBe(false);
    expect(c.level).toBe("wired");
    expect(r.ok).toBe(false);
    expect(r.notObserved).toContain("wired only");
  });

  it("exported but never wired is flagged (the exported-only gap)", async () => {
    await makeRoot({
      "packages/x/src/index.ts": "export function exportOnly(){}\n",
    });
    const r = runUsageAudit({ root, capabilities: [{ capability: "export only", symbol: "exportOnly" }] });
    const c = r.capabilities[0]!;
    expect(c.exported).toBe(true);
    expect(c.wired).toBe(false);
    expect(c.observed).toBe(false);
    expect(c.level).toBe("exported");
  });

  it("an absent symbol is reported at every level false", async () => {
    await makeRoot({ "packages/x/src/index.ts": "export function other(){}\n" });
    const r = runUsageAudit({ root, capabilities: [{ capability: "ghost", symbol: "ghostSymbol_zzz" }] });
    const c = r.capabilities[0]!;
    expect(c.exported).toBe(false);
    expect(c.wired).toBe(false);
    expect(c.observed).toBe(false);
    expect(r.notObserved).toContain("ghost");
  });

  it("renders a per-capability line + overall verdict", async () => {
    await makeRoot({ "packages/x/src/index.ts": "export function t(){}\n", "apps/cli/src/e2e.test.ts": "t();\n" });
    const r = runUsageAudit({ root, capabilities: [{ capability: "t", symbol: "t" }] });
    const out = renderUsageAudit(r).join("\n");
    expect(out).toContain("t");
    expect(out).toMatch(/PASS|FAIL/);
  });

  it("KEY_CAPABILITIES lists the seven E4-10 capabilities", () => {
    expect(KEY_CAPABILITIES.map((c) => c.capability)).toEqual([
      "createActivationRecorderV2",
      "classifySecurityOutcomeV2",
      "canonical V3 writer",
      "strict promotion loader",
      "resolveChampionHarness",
      "durable RecoveryStore",
      "GateEvidenceV2 generator",
    ]);
  });

  it("audits the real repository without throwing", () => {
    // process.cwd() is the repo root under vitest.
    const r = runUsageAudit({ root: process.cwd() });
    expect(r.capabilities.length).toBe(KEY_CAPABILITIES.length);
    for (const c of r.capabilities) {
      if (c.observed) expect(c.observedBy.length).toBeGreaterThan(0);
    }
  });
});
