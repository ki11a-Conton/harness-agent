import type { ModelProvider, PermissionPolicy } from "@ar/contracts";
import type { BaselineReport, EvalSuite } from "@ar/evaluation";
export interface BenchmarkCommandOptions {
    casesDir: string;
    outDir: string;
    /** Default context budget (tokens); per-case override wins. */
    budgetTokens: number;
    /** Run at most this many cases (0 = all). */
    limit: number;
    /** Allow the stub provider to run (records MODEL_ERROR honestly). */
    allowStub: boolean;
    /** Benchmark suite (Phase 6.5): regression | holdout | adversarial | stress. */
    suite: EvalSuite;
    /** P0-6: randomize execution order (report stays in fixed case order). */
    shuffle: boolean;
    /** P0-6: PRNG seed for the shuffle (0 = default); same seed → same order. */
    seed: number;
}
/**
 * `agent benchmark` — run a benchmark suite through the real harness and
 * freeze a baseline (Phase 6.5: four suites — regression / holdout /
 * adversarial / stress; report files are baseline.json + baseline-summary.md
 * for regression, <suite>.json + <suite>-summary.md for the others).
 *
 * Wiring notes:
 * - Per case: fresh in-memory stores + fresh workspace + fresh runtime, so a
 *   crashed case never contaminates the next one.
 * - Permissions: benchmark profile (read/edit/exec allowed inside the
 *   workspace, network exec denied). Nothing ever asks for human approval →
 *   human_interventions stays 0 and runs are unattended.
 * - Sandbox: defaultSandboxPolicy() (workspace-write, network deny, process
 *   bounded 60s / 1MB output).
 * - Verification: case.json specs are wired as the runtime VERIFY-001 gate
 *   (TaskVerifier); the gate runs when the model stops.
 * - Context: ContextPipeline with the case budget override (contextBudgetTokens).
 * - Holdout anonymization: the runtime-side task id never carries the case
 *   name (the model only ever sees request.md, and holdout judges must not
 *   be guessable from harness wiring).
 */
export declare function runBenchmarkCommand(argv: string[], providerOverride?: ModelProvider): Promise<{
    exitCode: number;
    lines: string[];
}>;
/** Benchmark permission profile: work inside the workspace is allowed without
 *  approval; network exec is denied; the sandbox still enforces scope. */
export declare const BENCHMARK_PERMISSIONS: PermissionPolicy;
export declare const BENCHMARK_SYSTEM_PROMPT: string;
/** P4-3: which mechanisms this benchmark harness currently wires. A case
 *  whose `requires` names something absent returns the gap (infrastructure
 *  failure); undefined when everything is satisfied. P4-10 replaces this with
 *  the real createHarness introspection. */
export declare const BENCHMARK_WIRED_MECHANISMS: Set<string>;
export declare function checkRequirements(requires: readonly string[] | undefined): string[] | undefined;
/**
 * P0-6 contamination guard: every case must start from a workspace that
 * contains EXACTLY its fixture files — nothing carried over from a previous
 * run's artifacts, tool outputs, or stray files. `mkdtemp` already guarantees
 * a fresh empty directory; this assertion makes that guarantee explicit and
 * turns any violation into an infrastructure failure (fail-closed, never an
 * agent failure). Runs BEFORE the case starts, so `.artifacts` created during
 * the run are not part of the expected set.
 */
export declare function assertWorkspaceIsolated(workspace: string, fixture: Record<string, string>): Promise<void>;
/** P4-11: deterministic-usage fake provider for the benchmark smoke run. */
export declare function smokeFakeProvider(): ModelProvider;
/** P4-11: `agent benchmark smoke` — one adversarial case with the fake
 *  provider; FAIL when the recorded usage is not positive (usage accounting
 *  broken). CI gates on this. */
export declare function runSmokeBenchmark(): Promise<{
    exitCode: number;
    lines: string[];
}>;
/** P4-13: `agent benchmark list` — the on-disk suite counts are the single
 *  source of truth. `--update-readme` rewrites the counts in the README
 *  section headings so they can never drift from the actual suites again. */
export declare function listBenchmarkSuites(updateReadme: boolean): Promise<{
    exitCode: number;
    lines: string[];
}>;
export type { BaselineReport };
//# sourceMappingURL=benchmark-command.d.ts.map