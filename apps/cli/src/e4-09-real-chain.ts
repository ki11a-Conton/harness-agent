/**
 * E4-R55 — SHARED, REAL production-chain wiring for the E4-09 E2E.
 *
 * Why this module exists (F55): the R45 acceptance was recorder-UNIT only. It
 * called `new E4DiagnosticRecorder(...)` directly and hand-wrote a
 * `{decision:'REJECT'}` fixture, so it never touched the PRODUCTION chain that
 * actually registers the artifact paths and persists the evaluator's real
 * result. Reverting the production registration / save order to its pre-R45
 * shape would not have failed a single R45 assertion.
 *
 * The production wiring therefore lives HERE, once, and both callers depend on
 * it:
 *   - `apps/cli/src/e4-09-production-e2e.test.ts` (the real E2E suite), and
 *   - `apps/cli/test-infra/e4-r55-fixtures/*.child.test.ts` (the isolated child
 *     the R55 parent verifier drives).
 *
 * That makes an ORDER MUTATION of this file observable: the parent generates a
 * mutated COPY of this module (see the R55-MUTATION markers below) and requires
 * the same acceptance to FAIL against it. A test that merely re-implemented the
 * registration would prove nothing about the wiring actually in use.
 *
 * This is TEST INFRASTRUCTURE: it lives outside `apps/cli/tsconfig.json`'s
 * `include` and outside the root vitest `include`, so it can never be collected
 * as a suite or break `tsc -b`.
 */
import { expect, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelEvent, ModelProvider, ModelRef, ProviderConfig } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { runV3ChampionEval } from "@ar/evaluation";
import {
  E4DiagnosticRecorder,
  summarizeDecisionArtifact,
  summarizePairedArtifact,
  summarizeV3Artifact,
} from "./e4-09-diagnostics.js";

export const GUIDANCE_MARKER = "Budget-aware completion guidance:";
export const CANDIDATE = "budget_aware_completion_v1";
export const CHAIN_MODULE_PATH = "apps/cli/src/e4-09-real-chain.ts";

/** Markers the R55 order mutation operates on — see `mutateChainOrdering`. */
export const MUTATION_START = "  // ── R55-MUTATION-TARGET-START ──";
export const MUTATION_END = "  // ── R55-MUTATION-TARGET-END ──";
export const MUTATION_ASSERT = '  expect(evalResult.decisionArtifact.decision).toBe("ACCEPT");';

export interface ArmAwareCall {
  seq: number;
  arm: "candidate" | "baseline";
  wrote: boolean;
}

/**
 * A deterministic fake provider whose behavior keys on the REAL arm config: the
 * candidate arm's system prompt carries the budget-aware guidance (injected by
 * the production runOneCase wiring only when a candidate is active), so it is
 * told to write the file the verifier requires; the baseline arm is not and
 * never writes.
 *
 * E4-R55: `candidateWrites: false` makes the candidate behave like the baseline.
 * The REAL evaluator then returns a NON-ACCEPT decision — the deterministic
 * non-ACCEPT input the R55 acceptance needs, produced by the real stages rather
 * than by a hand-written decision JSON.
 */
export class ArmAwareProvider implements ModelProvider {
  readonly id = "arm-aware";
  readonly calls: ArmAwareCall[] = [];
  private seq = 0;
  constructor(private readonly opts: { candidateWrites?: boolean } = {}) {}
  async listModels() {
    return [{ id: "arm-aware-model", name: "ArmAware" }];
  }
  createClient(_model: ModelRef, _config: ProviderConfig) {
    const self = this;
    const candidateWrites = this.opts.candidateWrites ?? true;
    return {
      async *generate(request: unknown, _signal: AbortSignal): AsyncIterable<ModelEvent> {
        const req = (request ?? {}) as { system?: unknown; messages?: unknown };
        const sys = typeof req.system === "string" ? req.system : "";
        const isCandidate = sys.includes(GUIDANCE_MARKER);
        const alreadyWrote = JSON.stringify(req.messages ?? "").includes("write_file");
        const shouldWrite = isCandidate && candidateWrites && !alreadyWrote;
        self.calls.push({ seq: self.seq++, arm: isCandidate ? "candidate" : "baseline", wrote: shouldWrite });
        const script = shouldWrite
          ? ScriptedModelProvider.toolCall("write_file", { path: "out.txt", content: "done by candidate\n" })
          : ScriptedModelProvider.text("done");
        yield* script;
      },
    };
  }
}

export async function makeCaseDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e4-09-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    if (rel.includes("/")) await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return dir;
}

/** Mock the isolation probe so the promotion run is strong / promotion-eligible
 *  (the offline stand-in for a real OS sandbox backend). */
export async function importBenchmarkWithStrongIsolation() {
  vi.resetModules();
  vi.doMock("@ar/evaluation", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@ar/evaluation")>();
    return {
      ...actual,
      probeIsolationBackend: (async () => ({
        schemaVersion: 1, id: "mock-bwrap", platform: "test", strongIsolation: true, note: "e4-09 test backend",
      })) as unknown as typeof actual.probeIsolationBackend,
    };
  });
  return import("../src/benchmark-command.js");
}

export interface RealChainOptions {
  /** false => the candidate arm writes nothing, so the REAL evaluator rejects. */
  candidateWrites?: boolean;
  /** Override the cases directory (used for the benchmark-precondition failure). */
  casesDir?: string;
  /** FAULT INJECTION seam at the evaluator call boundary. When set, the caller
   *  MUST label the run as fault injection: it is NOT a real evaluator result. */
  evaluate?: typeof runV3ChampionEval;
  label?: string;
  testFile?: string;
  testedSha?: string | null;
  /** Extra structured facts folded into a failure bundle. */
  facts?: Record<string, unknown>;
  /** Called with the recorder as soon as it exists, BEFORE any stage runs — so a
   *  failure inside the chain build still has an owner that can capture it. */
  onRecorder?: (recorder: E4DiagnosticRecorder) => void;
}

export interface RealChain {
  root: string;
  outDir: string;
  bundleDir: string;
  casesDir: string;
  v3BaselinePath: string;
  v3CandidatePath: string;
  decisionArtifactPath: string;
  pairedPath: string;
  evalResult: Awaited<ReturnType<typeof runV3ChampionEval>>;
  recorder: E4DiagnosticRecorder;
  provider: ArmAwareProvider;
  benchmark: { exitCode: number; lines: string[] };
}

/**
 * The REAL production chain: benchmark (real paired executor, real canonical V3
 * writer) -> real champion evaluator -> the evaluator's decision persisted
 * VERBATIM before the ACCEPT assertion.
 *
 * The registration of every output path happens UP FRONT, and the decision file
 * is written BEFORE the ACCEPT assert (both are the R45 fix). The block between
 * the R55-MUTATION markers is exactly what the order mutation moves after the
 * assert.
 */
export async function buildRealChain(root: string, testName: string, opts: RealChainOptions = {}): Promise<RealChain> {
  const diag = new E4DiagnosticRecorder({
    label: opts.label ?? "e4-09-adv",
    testFile: opts.testFile ?? CHAIN_MODULE_PATH,
    testedSha: opts.testedSha ?? null,
    testName,
  });
  for (const [k, v] of Object.entries(opts.facts ?? {})) diag.addFact(k, v);
  opts.onRecorder?.(diag);
  diag.mark("setup");

  const casesDir = opts.casesDir ?? join(root, "cases");
  if (opts.casesDir === undefined) {
    const caseJson = JSON.stringify({ verification: [{ kind: "artifact", path: "out.txt", mustChange: true }] });
    for (const c of ["a", "b", "c"]) {
      const dir = join(root, "cases", c);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "request.md"), "Produce out.txt.", "utf8");
      await writeFile(join(dir, "expected.md"), "out.txt exists.", "utf8");
      await writeFile(join(dir, "case.json"), caseJson, "utf8");
    }
  }

  const outDir = join(root, "out");
  const v3BaselinePath = join(outDir, "v3-baseline.json");
  const v3CandidatePath = join(outDir, "v3-candidate.json");
  const pairedPath = join(outDir, "paired-experiment.json");
  const bundleDir = join(root, "bundle");
  const decisionArtifactPath = join(bundleDir, "decision-artifact.json");

  // E4-R45: register the OUTPUT PATHS the benchmark/evaluator are ABOUT to write,
  // BEFORE any of them runs. A stage that fails before writing leaves them
  // recorded as `missing`, which is itself the evidence.
  diag.registerArtifacts([
    { role: "paired-experiment", path: pairedPath, summarize: summarizePairedArtifact },
    { role: "v3-baseline", path: v3BaselinePath, summarize: summarizeV3Artifact },
    { role: "v3-candidate", path: v3CandidatePath, summarize: summarizeV3Artifact },
    { role: "decision-artifact", path: decisionArtifactPath, summarize: summarizeDecisionArtifact },
  ]);

  const provider = new ArmAwareProvider({ candidateWrites: opts.candidateWrites });
  const bench = await importBenchmarkWithStrongIsolation();
  diag.mark("benchmark"); // stage set BEFORE the call, not after it succeeds
  const res = await bench.runBenchmarkCommand(
    ["--cases", casesDir, "--candidate", CANDIDATE, "--repeat", "2", "--out", outDir],
    provider,
  );
  // Keep the benchmark's REAL CLI exit + output so a failure bundle explains
  // itself (never only the framework's assertion text).
  diag.addFact("benchmarkCli", { exitCode: res.exitCode, lines: res.lines.slice(0, 200) });
  const benchmark = { exitCode: res.exitCode, lines: res.lines };
  expect(res.exitCode).toBe(0);

  diag.mark("evaluate"); // stage BEFORE the call
  const evaluate = opts.evaluate ?? runV3ChampionEval;
  const evalResult = await evaluate({ baselinePath: v3BaselinePath, candidatePath: v3CandidatePath, candidateId: CANDIDATE });

  // ── R55-MUTATION-TARGET-START ──
  // Persist the REAL decision (ACCEPT or not) BEFORE the ACCEPT assert. The
  // evaluator's actual result is written verbatim — never a rebuilt ACCEPT
  // object — so a non-ACCEPT decision is captured with its real reasonCodes.
  await mkdir(bundleDir, { recursive: true });
  await writeFile(decisionArtifactPath, JSON.stringify(evalResult.decisionArtifact), "utf8");
  // ── R55-MUTATION-TARGET-END ──
  expect(evalResult.decisionArtifact.decision).toBe("ACCEPT");

  diag.mark("chain-built");
  return {
    root, outDir, bundleDir, casesDir,
    v3BaselinePath, v3CandidatePath, decisionArtifactPath, pairedPath,
    evalResult, recorder: diag, provider, benchmark,
  };
}

/**
 * E4-R55 order mutation: move the decision-persistence block from BEFORE the
 * ACCEPT assertion to AFTER it — i.e. restore the pre-R45 ordering. Applied to a
 * generated COPY of this module; the repository's own files are never mutated.
 *
 * Throws when the markers cannot be found, so a silent no-op mutation can never
 * masquerade as a passing negative control.
 */
export function mutateChainOrdering(source: string): string {
  const s = source.indexOf(MUTATION_START);
  const e = source.indexOf(MUTATION_END);
  if (s < 0 || e < 0 || e < s) throw new Error("R55 mutation: marker block not found in the chain module");
  if (!source.includes(MUTATION_ASSERT)) throw new Error("R55 mutation: ACCEPT assert line not found");
  const block = source.slice(s, e + MUTATION_END.length);
  const withoutBlock = source.slice(0, s) + source.slice(e + MUTATION_END.length);
  const mutated = withoutBlock.replace(MUTATION_ASSERT, `${MUTATION_ASSERT}\n${block}`);
  if (mutated === source) throw new Error("R55 mutation produced no change");
  // sanity: the block must now sit AFTER the assert
  if (mutated.indexOf(MUTATION_START) < mutated.indexOf(MUTATION_ASSERT)) {
    throw new Error("R55 mutation did not move the block after the assert");
  }
  return mutated;
}

/** Shared failure-capture hook body used by every suite that drives this chain. */
export async function captureOnFailure(
  recorder: E4DiagnosticRecorder | null,
  ctx: { task: { name: string; result?: { state?: string; errors?: unknown[] } | undefined } },
): Promise<void> {
  if (ctx.task.result?.state === "fail" && recorder !== null) {
    const first = ctx.task.result.errors?.[0];
    await recorder.captureFailure({
      error: first ?? new Error(`e4-09 test failed: ${ctx.task.name}`),
    });
  }
}
