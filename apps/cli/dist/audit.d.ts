import type { HarnessIntrospection } from "@ar/harness";
import type { CommandDeps, CommandResult } from "./commands.js";
/**
 * P0-1 automatic capability matrix.
 *
 * `agent audit` judges feature maturity from REAL wiring evidence — the
 * composition root's runtime introspection (HarnessIntrospection), the
 * on-disk repository layout, benchmark suites and CI workflow — never from
 * "docs say DONE" (plan.md §2.2).
 *
 * The matrix records are derived by pure functions (buildCapabilityMatrix)
 * so tests can feed any wiring state; the CLI (`auditCmd`) probes the
 * workspace, writes CAPABILITY_MATRIX.json + CAPABILITY_MATRIX.md, and exits
 * non-zero when the docs (benchmarks/README.md) claim a suite that does not
 * exist on disk.
 */
export type CapabilityStatus = "implemented" | "wired" | "tested" | "benchmarked" | "missing" | "unknown";
export interface CapabilityEvidence {
    kind: "runtime_dependency" | "registered_tool" | "integration_test" | "benchmark_case" | "store" | "ci_job" | "config";
    ref: string;
    note?: string;
}
export interface CapabilityRecord {
    id: string;
    description: string;
    implemented: boolean;
    productionWired: boolean;
    integrationTested: boolean;
    benchmarkExercised: boolean;
    evidence: CapabilityEvidence[];
}
export interface CapabilityMatrix {
    generatedAt: number;
    gitSha?: string;
    records: CapabilityRecord[];
}
/**
 * Runtime introspection supplied by the composition root (plan.md P0-1) —
 * the @ar/harness HarnessIntrospection contract. It reflects what the host
 * ACTUALLY wired — stores by implementation name, registered tool names, and
 * feature flags — so the audit never guesses.
 */
export interface BenchmarkSuiteProbe {
    exists: boolean;
    caseCount: number;
}
/** A suite count claim found in benchmarks/README.md. */
export interface DocClaim {
    suite: string;
    claimed: number;
    /** README marks the suite as planned (honest docs admit it is not built). */
    planned: boolean;
}
export interface CiWorkflowProbe {
    exists: boolean;
    ubuntu: boolean;
    windows: boolean;
}
export interface AuditInput {
    generatedAt: number;
    gitSha?: string;
    introspection?: HarnessIntrospection;
    /** Probe id → source dir present under packages/. */
    packages: Record<string, boolean>;
    /** Probe id → test file present in the repo. */
    integrationTests: Record<string, boolean>;
    benchmarkSuites: Record<string, BenchmarkSuiteProbe>;
    ciWorkflow: CiWorkflowProbe;
    readmeClaims: DocClaim[];
}
export declare const ADVANCED_TOOL_NAMES: readonly ["grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands", "env_snapshot"];
export declare const SUITE_NAMES: readonly ["regression", "holdout", "adversarial", "stress"];
/** P0-1: a capability is as mature as its weakest proven link. */
export declare function capabilityStatusOf(record: CapabilityRecord): CapabilityStatus;
export declare function buildCapabilityMatrix(input: AuditInput): CapabilityMatrix;
export interface DocTruthfulnessRow {
    suite: string;
    claimed: number;
    actual: number;
    planned: boolean;
    truthful: boolean;
}
export interface AuditSummary {
    total: number;
    implemented: number;
    wired: number;
    tested: number;
    benchmarked: number;
    missing: number;
    docTruthfulness: DocTruthfulnessRow[];
    /** False when a README claim contradicts the on-disk benchmark suites. */
    ok: boolean;
}
export declare function auditSummary(matrix: CapabilityMatrix, input: AuditInput): AuditSummary;
export declare function renderMatrixMarkdown(matrix: CapabilityMatrix, summary: AuditSummary): string;
export interface AuditProbeOptions {
    root?: string;
    now?: () => number;
    gitSha?: () => Promise<string | undefined>;
}
export declare function probeWorkspace(opts?: AuditProbeOptions): Promise<AuditInput>;
export declare function auditCmd(rest: string[], deps: CommandDeps): Promise<CommandResult>;
//# sourceMappingURL=audit.d.ts.map