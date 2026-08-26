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

export type ReleasePlatform = "linux" | "windows" | "darwin" | "coverage";

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
  platform?: ReleasePlatform;
  evidenceRef?: string;
  reason?: string;
}

export interface ReleaseVerdict {
  headSha: string;
  /** Whether all required gates passed (free deterministic gates only).
   *  P38.3-12: the structured attestation also carries `runtimeReleaseReady`
   *  (same value, explicit semantics) and `championPromotion` (separate — not
   *  evaluated by the release gate). */
  ready: boolean;
  gates: ReleaseGateResult[];
  /** P38.3-12: explicit alias — runtime release readiness is provable using
   *  free deterministic gates only, independently of paid model quality. */
  runtimeReleaseReady: boolean;
  /** P38.3-12: champion quality/promotion is a separate concern. The release
   *  gate never evaluates it — only the `agent champion eval` command does.
   *  This field exists so a JSON consumer can confirm the distinction. */
  championPromotion: { status: "not_evaluated" | "evaluated" | "promoted" };
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

/** P38.3-6 (INV-P38.3-006): required platform set per gate. Every gate must
 *  have evidence for ALL required platforms before the gate can be considered
 *  passed. A missing platform is a failed gate. */
export const REQUIRED_GATE_PLATFORMS: Readonly<Record<RequiredGateId, readonly ReleasePlatform[]>> = {
  typecheck: ["linux", "windows"],
  test: ["linux", "windows"],
  build: ["linux", "windows"],
  coverage: ["coverage"],
  docs: ["linux", "windows"],
  benchmark_smoke: ["linux", "windows"],
  protocol: ["linux", "windows"],
  security: ["linux", "windows"],
  race: ["linux", "windows"],
  chaos: ["linux", "windows"],
  capability_audit: ["linux", "windows"],
};

/** Schema of a raw evidence file written by a gate run. */
export interface RawGateEvidence {
  schemaVersion: number;
  kind: string;
  gate: string;
  headSha: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  platform: string;
  generatedAt?: string;
}

/** P38.3-5: a validated evidence instance — every field is verified against
 *  the expected release HEAD, canonical command, gate id, and platform. */
export interface ValidatedGateEvidence {
  id: RequiredGateId;
  platform: ReleasePlatform;
  state: GateState;
  headSha: string;
  command: string;
  evidenceRef: string;
  reason?: string;
}

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
    // INV-P38.1-009: evidence must prove it actually ran the canonical command.
    // A substituted/imitation command (e.g. `agent audit --out` standing in for
    // `pnpm capability:audit`) is BLOCKED — INV-P38.1-010.
    if (gate.command !== GATE_COMMANDS[id]) {
      return {
        id,
        state: "blocked",
        headSha,
        command: gate.command,
        evidenceRef: gate.evidenceRef,
        reason: `command mismatch: expected ${GATE_COMMANDS[id]}, got ${gate.command}`,
      };
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
  return {
    headSha, ready,
    // P38.3-12: explicit runtime-release readiness (same as `ready`, but
    // clarifies semantics — never confused with champion quality).
    runtimeReleaseReady: ready,
    // P38.3-12: champion quality/promotion is NOT evaluated by the release
    // gate. A JSON consumer sees `championPromotion.status: "not_evaluated"`
    // and knows this attestation is about runtime readiness only.
    championPromotion: { status: "not_evaluated" as const },
    gates: resolved,
  };
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

const KNOWN_PLATFORMS: readonly string[] = ["linux", "windows", "darwin", "coverage"];

/** P38.3-5 (INV-P38.3-005): validate ONE evidence instance against the exact
 *  expected HEAD, canonical command, gate id, and platform — BEFORE it is
 *  aggregated with any other platform's evidence. A single malformed/stale
 *  instance must never be hidden by a passing instance. Throws on a
 *  structural violation; returns a blocked/passed state otherwise. */
export function validateGateEvidenceInstance(opts: {
  evidence: RawGateEvidence;
  expectedHead: string;
  expectedCommand: string;
  expectedGate: RequiredGateId;
  expectedPlatform: ReleasePlatform;
  sourcePath: string;
}): ValidatedGateEvidence {
  const { evidence, expectedHead, expectedCommand, expectedGate, expectedPlatform, sourcePath } = opts;

  // Structural violations (fail closed — never normalized to PASS).
  if (evidence.schemaVersion !== 1) {
    throw new Error(
      `malformed gate evidence at ${sourcePath}: unsupported schemaVersion ${evidence.schemaVersion}`,
    );
  }
  if (evidence.kind !== "gate") {
    throw new Error(
      `malformed gate evidence at ${sourcePath}: kind "${evidence.kind}" is not "gate"`,
    );
  }
  if (evidence.gate !== expectedGate) {
    throw new Error(
      `malformed gate evidence at ${sourcePath}: gate "${evidence.gate}" does not match expected "${expectedGate}"`,
    );
  }
  if (evidence.headSha !== expectedHead) {
    throw new Error(
      `stale evidence at ${sourcePath}: headSha ${evidence.headSha} != release HEAD ${expectedHead}`,
    );
  }
  if (evidence.command !== expectedCommand) {
    throw new Error(
      `malformed gate evidence at ${sourcePath}: command mismatch (expected ${expectedCommand}, got ${evidence.command})`,
    );
  }
  if (evidence.platform !== expectedPlatform) {
    throw new Error(
      `malformed gate evidence at ${sourcePath}: platform "${evidence.platform}" does not match expected "${expectedPlatform}"`,
    );
  }
  if (evidence.exitCode === null || evidence.exitCode === undefined) {
    return {
      id: expectedGate,
      platform: expectedPlatform,
      state: "not_run",
      headSha: expectedHead,
      command: expectedCommand,
      evidenceRef: sourcePath,
      reason: "gate was not executed",
    };
  }
  const consistentWithExit = evidence.passed === (evidence.exitCode === 0);
  if (!consistentWithExit) {
    // INV-P38.1-008: exitCode/passed contradiction is BLOCKED, never a pass.
    return {
      id: expectedGate,
      platform: expectedPlatform,
      state: "blocked",
      headSha: expectedHead,
      command: expectedCommand,
      evidenceRef: sourcePath,
      reason: `inconsistent gate evidence: passed=${evidence.passed} does not match exitCode=${evidence.exitCode}`,
    };
  }
  return {
    id: expectedGate,
    platform: expectedPlatform,
    state: evidence.exitCode === 0 ? "passed" : "failed",
    headSha: expectedHead,
    command: expectedCommand,
    evidenceRef: sourcePath,
  };
}

/**
 * P38.3-5/6 (INV-P38.3-005/006): aggregate a gate's VALIDATED per-platform
 * instances into one gate verdict. The required platform set is explicit —
 * every required platform must be present and passed; a duplicate platform
 * cannot substitute for a missing one; an unknown platform cannot satisfy a
 * required platform.
 */
export function aggregateGateInstances(opts: {
  id: RequiredGateId;
  instances: ValidatedGateEvidence[];
  expectedHead: string;
}): ReleaseGateResult {
  const { id, instances, expectedHead } = opts;
  const required = REQUIRED_GATE_PLATFORMS[id];
  const command = GATE_COMMANDS[id];
  const byPlatform = new Map<ReleasePlatform, ValidatedGateEvidence[]>();
  for (const instance of instances) {
    const list = byPlatform.get(instance.platform) ?? [];
    list.push(instance);
    byPlatform.set(instance.platform, list);
  }

  const problems: string[] = [];
  for (const platform of required) {
    const platformInstances = byPlatform.get(platform);
    if (platformInstances === undefined || platformInstances.length === 0) {
      problems.push(`missing required platform ${platform}`);
      continue;
    }
    for (const instance of platformInstances) {
      if (instance.state !== "passed") {
        problems.push(`${platform} ${instance.state}${instance.reason !== undefined ? `: ${instance.reason}` : ""}`);
      }
    }
  }

  // All required platforms present and passed → passed. Otherwise failed with
  // the exact reasons. A red platform is never hidden by a green one.
  const state: GateState = problems.length === 0 ? "passed" : "failed";
  const evidenceRef = instances.map((i) => i.evidenceRef).join(", ");
  return {
    id,
    state,
    headSha: expectedHead,
    command,
    evidenceRef,
    reason: problems.length === 0 ? undefined : `platform coverage: ${problems.join("; ")}`,
  };
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
  // INV-P38.1-008: `passed` is derived from exitCode — a declared `passed` that
  // contradicts exitCode is BLOCKED, never silently treated as green.
  const declaredPassed = record.passed;
  let state: GateState;
  let reason: string | undefined;
  if (exitCode === null) {
    state = "not_run";
    reason = "gate was not executed";
  } else if (declaredPassed !== undefined && declaredPassed !== (exitCode === 0)) {
    state = "blocked";
    reason = "inconsistent gate evidence: passed does not match exitCode";
  } else {
    state = exitCode === 0 ? "passed" : "failed";
  }
  return { id, state, headSha, command, evidenceRef: sourcePath, reason };
}

/** P38.3-5: parse a raw evidence file into a typed RawGateEvidence, rejecting
 *  structurally invalid JSON. The per-instance semantic validation happens in
 *  validateGateEvidenceInstance. */
export function parseRawEvidence(json: string, sourcePath: string): RawGateEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`malformed gate evidence at ${sourcePath}: not valid JSON`);
  }
  const record = raw as Partial<RawGateEvidence> & {
    gate?: string;
    id?: string;
  };
  const gate = (record.gate ?? record.id) as string | undefined;
  if (gate === undefined) {
    throw new Error(`malformed gate evidence at ${sourcePath}: missing gate id`);
  }
  if (!(REQUIRED_GATES as readonly string[]).includes(gate)) {
    throw new Error(`malformed gate evidence at ${sourcePath}: unknown gate id ${gate}`);
  }
  return {
    schemaVersion: record.schemaVersion ?? 0,
    kind: record.kind ?? "",
    gate,
    headSha: record.headSha ?? "",
    command: record.command ?? "",
    exitCode: record.exitCode === undefined ? null : record.exitCode,
    passed: record.passed ?? false,
    platform: record.platform ?? "",
  };
}
