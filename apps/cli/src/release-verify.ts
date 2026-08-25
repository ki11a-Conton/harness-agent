/**
 * P36-1 — Release gate truthfulness model.
 *
 * Makes it IMPOSSIBLE for a release task to report PASS while required gates
 * are red or not run. `releaseReady` is a pure conjunction over per-gate
 * state at an exact HEAD — no "known noise" or "pre-existing" exemptions.
 *
 * Rule (INV-P36-009 / INV-P36-010):
 *   ready = true  IFF  every required gate.state == "passed"
 *                      AND every gate.headSha == release HEAD
 *
 * A failed gate with reason "pre-existing"/"known noise" still means
 * ready == false.
 */

export type GateState = "passed" | "failed" | "not_run" | "blocked";

export type RequiredGateId =
  | "typecheck"
  | "test"
  | "build"
  | "coverage"
  | "docs"
  | "benchmark_smoke"
  | "protocol"
  | "security"
  | "race"
  | "chaos"
  | "capability_audit";

export interface ReleaseGateResult {
  id: RequiredGateId;
  state: GateState;
  headSha: string;
  command: string;
  evidenceRef?: string;
  reason?: string;
}

export interface ReleaseVerdict {
  headSha: string;
  ready: boolean;
  gates: ReleaseGateResult[];
}

/** All gates a release candidate must pass (P36-12 required set). */
export const REQUIRED_GATES: readonly RequiredGateId[] = [
  "typecheck",
  "test",
  "build",
  "coverage",
  "docs",
  "benchmark_smoke",
  "protocol",
  "security",
  "race",
  "chaos",
  "capability_audit",
];

export const GATE_COMMANDS: Readonly<Record<RequiredGateId, string>> = {
  typecheck: "pnpm typecheck",
  test: "pnpm test",
  build: "pnpm build",
  coverage: "pnpm test:coverage",
  docs: "pnpm docs:verify",
  benchmark_smoke: "pnpm benchmark:smoke",
  protocol: "pnpm test:protocol",
  security: "pnpm test:security",
  race: "pnpm test:race",
  chaos: "pnpm test:chaos",
  // P37-6: capability auditing is the Harness audit, NOT the package-manager
  // dependency audit (`pnpm audit` is deps:audit).
  capability_audit: "pnpm capability:audit",
};

export interface ReleaseVerifyOptions {
  /** The release HEAD every gate's evidence must bind to. */
  headSha: string;
  /** Raw per-gate evidence (already resolved at headSha or with headSha
   *  stamped on each entry). */
  gates: ReleaseGateResult[];
  /** Dirty-tree development mode: allows evidence on a dirty tree.
   *  Default false — dirty-tree evidence is rejected unless explicitly
   *  allowed (plan.md §36-1 impl step 4). */
  allowDirtyTree?: boolean;
  /** When true, the verdict counts gates whose headSha != release HEAD as
   *  "blocked" (stale evidence) rather than passed. Always enforced. */
}

/**
 * Pure verdict computation (INV-P36-009): ready requires EVERY required gate
 * present, at the exact release HEAD, and in state "passed". A missing gate
 * counts as not_run. Any failed/not_run/blocked/stale gate → not ready.
 */
export function computeReleaseVerdict(opts: ReleaseVerifyOptions): ReleaseVerdict {
  const { headSha, gates } = opts;
  const byId = new Map(gates.map((g) => [g.id, g]));

  const resolved: ReleaseGateResult[] = REQUIRED_GATES.map((id) => {
    const gate = byId.get(id);
    if (gate === undefined) {
      return { id, state: "not_run", headSha, command: GATE_COMMANDS[id], reason: "no evidence provided" };
    }
    // INV-P36-007: stale evidence (different SHA) is never admissible.
    if (gate.headSha !== headSha) {
      return {
        id,
        state: "blocked",
        headSha,
        command: gate.command,
        evidenceRef: gate.evidenceRef,
        reason: `stale evidence: headSha ${gate.headSha} != release HEAD ${headSha}`,
      };
    }
    return gate;
  });

  const ready = resolved.every((g) => g.state === "passed");
  return { headSha, ready, gates: resolved };
}

/** Human-readable release verdict (plan.md §36-1). */
export function renderReleaseVerdict(verdict: ReleaseVerdict): string[] {
  const lines: string[] = [`Release verdict: ${verdict.ready ? "READY" : "FAILED"}`, ""];
  for (const gate of verdict.gates) {
    const label = gate.id.padEnd(16);
    lines.push(`${label} ${gate.state.toUpperCase().padEnd(8)} ${gate.command}${gate.reason !== undefined ? ` (${gate.reason})` : ""}`);
  }
  lines.push("", `headSha: ${verdict.headSha}`);
  return lines;
}

/** Parse a release evidence JSON file produced by a gate run. */
export function parseGateEvidence(json: string, sourcePath: string): ReleaseGateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`malformed gate evidence at ${sourcePath}: not valid JSON`);
  }
  const record = raw as {
    gate?: string;
    id?: string;
    state?: string;
    headSha?: string;
    command?: string;
    passed?: boolean;
    exitCode?: number | null;
  };
  const id = (record.gate ?? record.id) as RequiredGateId | undefined;
  const headSha = record.headSha;
  const command = record.command;
  if (id === undefined || headSha === undefined || command === undefined) {
    throw new Error(`malformed gate evidence at ${sourcePath}: missing id/headSha/command`);
  }
  if (!(REQUIRED_GATES as readonly string[]).includes(id)) {
    throw new Error(`malformed gate evidence at ${sourcePath}: unknown gate id ${id}`);
  }
  const exitCode = record.exitCode;
  const state: GateState =
    exitCode === 0 ? "passed" : exitCode === null ? "not_run" : "failed";
  return { id, state, headSha, command, evidenceRef: sourcePath };
}
