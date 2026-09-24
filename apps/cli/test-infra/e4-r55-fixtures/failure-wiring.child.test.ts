/**
 * E4-R55 (F55) — the ISOLATED CHILD that drives the REAL production chain.
 *
 * This file is NOT part of the default suite. It lives in
 * `apps/cli/test-infra/e4-r55-fixtures/`, i.e. outside the root vitest `include`
 * (`apps/*\/src/**\/*.test.ts`) and outside `apps/cli/tsconfig.json`'s
 * `include: ["src"]`. It is selected ONLY by
 * `apps/cli/test-infra/r55-vitest.config.ts`, which the R55 parent verifier
 * spawns as a real `vitest run` subprocess.
 *
 * Why a child at all: the R45 acceptance was recorder-UNIT only — it built a
 * recorder by hand and hand-wrote a `{decision:'REJECT'}` fixture. It never ran
 * the production registration/save wiring, so reverting that wiring to its
 * pre-R45 shape would not have failed a single R45 assertion. Here every case
 * goes through the SHARED real chain (`../../src/e4-09-real-chain.js`), the same module
 * the real E2E suite uses.
 *
 * Three of these four tests are EXPECTED to fail — that is the point: a failing
 * run is what exercises the production failure-capture path. The parent verifier
 * exits 0 only after confirming the exact expected pass/fail set AND the
 * evidence each failure left behind.
 *
 * `E4_R55_MUTATION=1` makes this file drive the generated ORDER-MUTATED copy of
 * the chain wiring instead. Nothing in the repository is mutated.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { E4DiagnosticRecorder } from "../../src/e4-09-diagnostics.js";
import { gitHeadShaAt } from "../../src/observation-evidence.js";
// E4-R59 (G59): the chain module is bound to THIS run by the parent through the
// run-scoped `@r55-chain` alias (see r55-vitest.config.ts). There is no default
// and no "newest file" scan — the parent points this at the real module for the
// control run and at its own per-run mutation copy for the mutated run.
import { CANDIDATE, buildRealChain, captureOnFailure, makeCaseDir } from "@r55-chain";
import { runV3ChampionEval } from "@ar/evaluation";

/**
 * Identity of the chain module THIS run was told to load. Recorded into every
 * bundle so the parent can check the run loaded what it selected, and so a
 * mutated run's evidence carries the digest of the mutated copy.
 */
const CHAIN_MODULE_PATH = process.env.E4_R55_CHAIN_MODULE ?? "<unset>";
const CHAIN_MODULE_SHA = await readFile(CHAIN_MODULE_PATH)
  .then((buf) => createHash("sha256").update(buf).digest("hex"))
  .catch(() => "missing");

const chainFacts = { chainModule: { path: CHAIN_MODULE_PATH, sha256: CHAIN_MODULE_SHA } };

const CHILD_FILE = "apps/cli/test-infra/e4-r55-fixtures/failure-wiring.child.test.ts";
const TESTED_SHA = gitHeadShaAt(process.cwd());

let tempDirs: string[] = [];
let activeDiag: E4DiagnosticRecorder | null = null;

afterEach(async (ctx) => {
  // The PRODUCTION capture path: persist the bundle BEFORE the temp roots below
  // are deleted. The parent verifier then proves the copies outlive this
  // cleanup by reading them AFTER this process has exited.
  await captureOnFailure(activeDiag, ctx);
  activeDiag = null;
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function newRoot(): Promise<string> {
  const dir = await makeCaseDir({});
  tempDirs.push(dir);
  return dir;
}

describe("E4-R55 child — real production failure wiring", () => {
  it("R55 nonaccept: a REAL non-ACCEPT decision is persisted with its reasonCodes before the ACCEPT assert", async () => {
    const root = await newRoot();
    // candidateWrites=false makes the candidate arm behave like the baseline, so
    // the REAL evaluator returns a non-ACCEPT decision. No hand-written decision
    // JSON is involved anywhere in this path.
    const chain = await buildRealChain(root, "R55 nonaccept: a REAL non-ACCEPT decision is persisted with its reasonCodes before the ACCEPT assert", {
      label: "r55-nonaccept",
      testFile: CHILD_FILE,
      testedSha: TESTED_SHA,
      candidateWrites: false,
      facts: chainFacts,
      onRecorder: (r) => {
        activeDiag = r;
      },
    });
    // Unreachable for a non-ACCEPT run — the ACCEPT assert inside buildRealChain
    // fires first. Kept so the intent is explicit if the evaluator ever accepts.
    expect(chain.evalResult.decisionArtifact.decision).toBe("ACCEPT");
  }, 120_000);

  it("R55 success: a fully ACCEPTed chain produces NO failure bundle", async () => {
    const root = await newRoot();
    const chain = await buildRealChain(root, "R55 success: a fully ACCEPTed chain produces NO failure bundle", {
      label: "r55-success",
      testFile: CHILD_FILE,
      testedSha: TESTED_SHA,
      candidateWrites: true,
      facts: chainFacts,
      onRecorder: (r) => {
        activeDiag = r;
      },
    });
    expect(chain.evalResult.decisionArtifact.decision).toBe("ACCEPT");
    expect(chain.provider.calls.some((c) => c.arm === "candidate" && c.wrote)).toBe(true);
    // No failure => the recorder must never be asked to capture.
    expect(chain.recorder.bundles.length).toBe(0);
    activeDiag = null;
  }, 120_000);

  it("R55 evaluator-throw: the injected fault keeps stage=evaluate and leaves the decision missing", async () => {
    const root = await newRoot();
    // FAULT INJECTION at the evaluator call boundary — explicitly labelled as
    // such below. This is NOT a real evaluator computation.
    const throwingEvaluator = (async () => {
      throw new Error("R55 injected evaluator failure: injected at the call boundary");
    }) as unknown as typeof runV3ChampionEval;
    await buildRealChain(root, "R55 evaluator-throw: the injected fault keeps stage=evaluate and leaves the decision missing", {
      label: "r55-throw",
      testFile: CHILD_FILE,
      testedSha: TESTED_SHA,
      candidateWrites: true,
      evaluate: throwingEvaluator,
      facts: {
        ...chainFacts,
        evaluatorFaultInjection: true,
        faultInjectionNote:
          "the evaluator call boundary was replaced by a throwing stub; the decision was NOT computed by the real evaluator",
      },
      onRecorder: (r) => {
        activeDiag = r;
      },
    });
  }, 120_000);

  it("R55 benchmark-fail: the original benchmark exit and the missing output roles are visible", async () => {
    const root = await newRoot();
    // A cases directory that does not exist: the real CLI benchmark must refuse
    // BEFORE any promotion-eligible artifact can be written.
    await buildRealChain(root, "R55 benchmark-fail: the original benchmark exit and the missing output roles are visible", {
      label: "r55-benchfail",
      testFile: CHILD_FILE,
      testedSha: TESTED_SHA,
      casesDir: join(root, "cases-that-do-not-exist"),
      facts: chainFacts,
      onRecorder: (r) => {
        activeDiag = r;
      },
    });
  }, 120_000);
});
