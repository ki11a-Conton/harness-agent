import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const adapter = new URL("../../../scripts/e4/n6-real-formal-ci.mjs", import.meta.url).href;
const formal = new URL("../../../scripts/e4/r5-real-formal.mjs", import.meta.url).href;
const readiness = new URL("../../../scripts/e4/readiness-evidence-verify.mjs", import.meta.url).href;
const evaluation = new URL("../../../packages/evaluation/dist/index.js", import.meta.url).href;

describe("N6 real-formal evidence adapter (synthetic test bytes, no experiment)", () => {
  it("relocates intact raw evidence, re-verifies with A6, and rejects stale SHA and changed content", () => {
    const dir = mkdtempSync(join(tmpdir(), "n6-adapter-"));
    try {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
        const { emitFixtureBundle, verifyEvidenceBundle } = await import(${JSON.stringify(formal)});
        const { writeReadinessInputs } = await import(${JSON.stringify(adapter)});
        const { verifyEvidenceBundle: verifyReadiness } = await import(${JSON.stringify(readiness)});
        const { verifyArmEvidenceFromArtifacts } = await import(${JSON.stringify(evaluation)});
        const { readFileSync, writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { createHash } = await import('node:crypto');
        const base = ${JSON.stringify(dir)};
        const raw = join(base, 'formal');
        await emitFixtureBundle(raw, { fixture: false });
        const read = p => JSON.parse(readFileSync(p, 'utf8'));
        const write = (p,v) => writeFileSync(p, JSON.stringify(v) + '\\n');
        const schedule = read(join(raw, 'schedule.json'));
        for (const r of schedule.records) {
          const d = join(raw, 'evidence', r.armRunId);
          const man = read(join(d, 'manifest.json')); delete man.fixture;
          write(join(d, 'manifest.json'), man);
          r.traceDigest = createHash('sha256').update(readFileSync(join(d, 'manifest.json'))).digest('hex');
          write(join(d, 'verifier.json'), { schemaVersion: 'prereg-run-verifier-v1', status: 'passed', grade: null, verifiedCompletion: true, violations: [] });
          write(join(d, 'security.json'), { schemaVersion: 'prereg-run-security-v1', violations: 0 });
        }
        write(join(raw, 'schedule.json'), schedule);
        const journal = read(join(raw, 'cost-journal.json'));
        journal.entries = journal.entries.map((e,i) => ({ ...e,
          schemaVersion: journal.schemaVersion, armRunId: schedule.records[i].armRunId,
          caseId: schedule.records[i].caseId, repetition: 1, attemptId: 0,
          reservationId: 'quota-' + i, costReservationId: 'cost-' + i,
          campaignDigest: 'f'.repeat(64), outcomeUnknown: false,
          reservedInputTokens: null, reservedOutputTokens: null,
        }));
        write(join(raw, 'cost-journal.json'), journal);
        write(join(raw, 'report.json'), { formalSmall: { evidence: {
          evidenceVerified: 2, physicalProviderCalls: 2, costMatches: true,
          journalRecomputed: { total: 230, baseline: 120, candidate: 110, delta: -10 }
        } } });
        const source = read(join(raw, 'identity.json'));
        const identity = { sha: source.driverHead, runId: 'synthetic-unit-test', attempt: 1, platform: 'ubuntu' };
        const args = { formalRoot: raw, outDir: base, identity, commandExits: { test: 0, build: 0, typecheck: 0 }, fixture: { ok: true } };
        const before = readFileSync(join(raw, 'evidence', schedule.records[0].armRunId, 'manifest.json'), 'utf8');
        const out = await writeReadinessInputs(args);
        const after = readFileSync(join(out.root, 'evidence', schedule.records[0].armRunId, 'manifest.json'), 'utf8');
        const verified = verifyReadiness({ evidenceRoot: out.root, expectSha: identity.sha, runId: identity.runId, attempt: 1, platform: 'ubuntu', armEvidenceVerifier: verifyArmEvidenceFromArtifacts, declaredArms: source.pair });
        let stale, tampered;
        try { await writeReadinessInputs({ ...args, identity: { ...identity, sha: '0'.repeat(40) } }); } catch(e) { stale = e.message; }
        const cm = read(join(raw, 'content-matrix.json')); cm.cases['reg-12-csv-parse'].arms.candidate.correct = 'failed'; write(join(raw, 'content-matrix.json'), cm);
        try { await writeReadinessInputs(args); } catch(e) { tampered = e.message; }
        process.stdout.write(JSON.stringify({ verified, bytesUnchanged: before === after, stale, tampered }));
      `], { encoding: "utf8", timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      const result = JSON.parse(r.stdout);
      expect(result.bytesUnchanged).toBe(true);
      expect(result.verified.problems).toEqual([]);
      expect(result.verified.budgetProblems).toEqual([]);
      expect(result.verified.facts.perArmVerified).toBe(2);
      expect(result.verified.levels.realBuildOfflineReady.status).toBe("PASS");
      expect(result.verified.levels.budgetEvidenceReady.status).toBe("PASS");
      expect(result.stale).toContain("N6_DRIVER_IDENTITY_MISMATCH");
      expect(result.tampered).toContain("CONTENT_CORRECT_FAILED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires both real-formal legs, every offline level, and upstream suite success in CI", () => {
    const ci = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const real = ci.slice(ci.indexOf("  real-formal-offline:"), ci.indexOf("  dual-platform-acceptance:"));
    expect(real).toContain("platform: ubuntu");
    expect(real).toContain("platform: windows");
    expect(real).toContain("fetch-depth: 0");
    expect(real).toContain("n6-real-formal-ci.mjs");
    const dual = ci.slice(ci.indexOf("  dual-platform-acceptance:"));
    expect(dual).toContain("needs: [verify, coverage, r97-r98-closed-loop, real-formal-offline]");
    expect(dual).toContain("--require fixtureProtocolReady,realBuildOfflineReady,budgetEvidenceReady");
    expect(dual).toContain("needs.verify.result != 'success'");
    expect(dual).toContain("--windows .ci/dual/windows/ci-readiness.json");
    expect(dual).toContain("--ubuntu .ci/dual/ubuntu/ci-readiness.json");
  });
});
