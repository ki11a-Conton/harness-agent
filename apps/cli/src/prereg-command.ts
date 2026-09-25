/**
 * N2/N5 — `agent prereg` — the FORMAL, pre-registration-gated entry chain.
 *
 * The plan (§N2) requires a formally supported command chain whose semantics
 * are at minimum:
 *
 *   build    — construct the canonical pre-registration artifact (0 provider).
 *   validate — re-observe the CURRENT execution identity, re-derive every
 *              derived field and compare it with the artifact (0 provider).
 *   run      — accept ONLY a validated artifact path plus an INDEPENDENT
 *              authorization path, then execute the frozen schedule.
 *
 * The paid path is not a set of flags: `run` cannot override cases,
 * repetitions, provider, model, budget or policy. Everything experimental comes
 * from the artifact; the CLI only supplies paths and output locations. The
 * provider factory, the arm runner and the fresh observation come from a
 * harness adapter (`PreregCommandDeps.runner`) — the same seam the offline E2E
 * injects a deterministic fake through. Without that adapter, `validate` and
 * `run` REFUSE rather than fabricate an identity or a runner.
 *
 * `RUN_PAID_BENCHMARKS` and the presence of an API key are NOT authorization:
 * only the artifact-bound, in-date authorization file is.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ModelProvider } from "@ar/contracts";
import {
  buildToolCallEfficiencyPreregistrationV2,
  serializePreregistrationV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
  openPreregisteredCampaignGate,
  observationViolationsV2,
  runPreregisteredCampaign,
  aggregatePreregisteredCampaign,
  type PreregisteredArmRunner,
  type PreregisteredCampaignObservationV2,
  type PreregisteredCampaignRun,
  selectionFromFrozenEvidence,
  TOOL_CALL_EFFICIENCY_CASE_SELECTION_PATH,
} from "@ar/evaluation";
import { formalExecutionProfile } from "./prereg-execution-identity.js";

export interface PreregRunnerAdapter {
  /** Re-observe the execution identity NOW (source, arms, guidance, cases…). */
  observe: (prereg: ToolCallEfficiencyPreregistrationV2) => Promise<PreregisteredCampaignObservationV2>;
  /** The provider factory — called ONLY after every preflight passed. */
  makeProvider: () => ModelProvider | Promise<ModelProvider>;
  /** How one arm of the frozen schedule is executed. */
  runArm: PreregisteredArmRunner;
}

export interface PreregCommandDeps {
  /**
   * The harness adapter. Production wires the real harness here; the offline
   * E2E injects a deterministic fake. Absent → `validate`/`run` refuse.
   */
  runner?: PreregRunnerAdapter;
  now?: () => number;
}

export interface PreregCommandResult {
  exitCode: number;
  lines: string[];
}

const USAGE = `usage: agent prereg <subcommand> [args]

subcommands:
  build <config.json> --out <prereg.json>
      Construct the canonical pre-registration v2 artifact (0 provider calls)
      and write it. Prints the root digest an operator must authorize.
  validate <prereg.json> [--json]
      Re-observe the CURRENT execution identity and compare it with the
      artifact. Strictly read-only (0 provider calls).
  run <prereg.json> --authorization <auth.json> --budget-dir <dir> --out <dir> --mode first-run|resume
      Execute the frozen schedule through the formal gate. An API key or
      RUN_PAID_BENCHMARKS is NOT authorization: without a valid
      artifact-bound authorization this REFUSES before any provider exists.
      --mode is REQUIRED and explicit — a paid path is never entered by an
      implicit default.

  An execution-semantic override (cases/repetitions/provider/model/budget) is
  not accepted on the command line: it would authorize a different experiment.`;

function usage(): PreregCommandResult {
  return { exitCode: 2, lines: [USAGE] };
}

/** A stable, machine-readable surface error: unknown/duplicated/extra arguments. */
function cliUsage(reason: string): PreregCommandResult {
  return {
    exitCode: 2,
    lines: [`prereg: REFUSED (CLI_USAGE)`, `  ${reason}`, USAGE],
  };
}

interface ArgSpec {
  /** Flags that consume the following token as their value. */
  valueFlags: readonly string[];
  /** Flags that take no value. */
  boolFlags: readonly string[];
  /** Value flags that MUST be present. */
  requiredFlags?: readonly string[];
  minPositionals: number;
  maxPositionals: number;
}

interface ParsedArgs {
  positionals: string[];
  values: Record<string, string>;
  bools: Set<string>;
}

/**
 * A3 — an EXPLICIT argument whitelist. The previous parser skipped any unknown
 * `--flag` and took the FIRST positional, so `prereg build cfg --out a --model gpt-4`
 * silently ignored `--model gpt-4`, and a duplicated `--out` silently won the
 * last. An input the command appears to accept but actually discards is exactly
 * the "looks authorized, isn't" defect this refuses: unknown, duplicated,
 * value-less and extra arguments all fail with `CLI_USAGE` BEFORE any observer
 * or provider exists.
 */
function parseArgs(rest: string[], spec: ArgSpec): ParsedArgs | PreregCommandResult {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      if (spec.valueFlags.includes(a)) {
        if (a in values) return cliUsage(`flag ${a} was given more than once`);
        const v = rest[i + 1];
        if (v === undefined || v.startsWith("--") || v === "") return cliUsage(`flag ${a} requires a value`);
        values[a] = v;
        i += 1;
        continue;
      }
      if (spec.boolFlags.includes(a)) {
        if (bools.has(a)) return cliUsage(`flag ${a} was given more than once`);
        bools.add(a);
        continue;
      }
      return cliUsage(`unknown flag ${a}`);
    }
    positionals.push(a);
  }
  if (positionals.length < spec.minPositionals) return cliUsage(`expected ${spec.minPositionals} positional argument(s), got ${positionals.length}`);
  if (positionals.length > spec.maxPositionals) {
    return cliUsage(`expected at most ${spec.maxPositionals} positional argument(s), got ${positionals.length}: ${positionals.slice(spec.maxPositionals).join(", ")}`);
  }
  for (const f of spec.requiredFlags ?? []) {
    // A3 — a MISSING required flag is an explicit `CLI_USAGE` refusal with the
    // flag named, not a bare usage banner: "the command ran and printed help" is
    // indistinguishable from success to a caller that only checks the exit code.
    if (!(f in values)) return cliUsage(`required flag ${f} is missing`);
  }
  return { positionals, values, bools };
}

/** `--out` and `--budget-dir` must be disjoint: overlapping paths would let the
 *  run record directory and the budget ledger alias or overwrite each other. */
function pathsOverlap(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  if (ra === rb) return true;
  return ra.startsWith(rb + sep) || rb.startsWith(ra + sep);
}

/** `agent prereg build <config.json> --out <prereg.json>` */
async function buildCmd(rest: string[]): Promise<PreregCommandResult> {
  const parsed = parseArgs(rest, { valueFlags: ["--out"], boolFlags: [], requiredFlags: ["--out"], minPositionals: 1, maxPositionals: 1 });
  if (!("positionals" in parsed)) return parsed;
  const configPath = parsed.positionals[0]!;
  const outPath = parsed.values["--out"]!;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return { exitCode: 1, lines: [`prereg build: cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  // A1 — the sample set may NEVER be self-declared by the config. Inline
  // `catalog`/`selection` (with a hand-typed `eligibilityDigest` /
  // `selectionProvenanceDigest`) is exactly the placeholder defect this refuses:
  // the cases must be derived read-only from a frozen selection artifact.
  if ("catalog" in config || "selection" in config) {
    return {
      exitCode: 1,
      lines: [
        "prereg build: REFUSED (SELECTION_PROVENANCE_UNPROVEN)",
        "  inline `catalog`/`selection` is self-declared and is not accepted — cases are derived",
        "  read-only from a frozen selection artifact (config `selectionEvidence`, default",
        `  ${TOOL_CALL_EFFICIENCY_CASE_SELECTION_PATH})`,
        "provider calls: 0",
      ],
    };
  }
  const evidence = (config.selectionEvidence ?? {}) as { root?: string; selectionPath?: string; taxonomyPath?: string };
  const root = evidence.root ?? process.cwd();
  let resolved: ReturnType<typeof selectionFromFrozenEvidence>;
  try {
    resolved = selectionFromFrozenEvidence({
      root,
      selectionPath: evidence.selectionPath,
      taxonomyPath: evidence.taxonomyPath,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "SELECTION_INVALID";
    return { exitCode: 1, lines: [`prereg build: REFUSED (${code})`, `  ${err instanceof Error ? err.message : String(err)}`, "provider calls: 0"] };
  }
  // The frozen artifact is authoritative for the suite identity and the dataset.
  // A2 — the provider/model/endpoint identity, the request profile and the
  // runtime-config digest must NOT be echoed from the config: they are derived
  // from the SAME source the observer re-derives them from (`resolveModelProvider`
  // + the pinned harness wiring + the versioned pricing snapshot). A self-declared
  // identity here would drift from what actually executes, which is exactly the
  // defect the formal gate refuses.
  const base = config as unknown as PreregistrationV2Options;
  const profile = formalExecutionProfile();
  const options: PreregistrationV2Options = {
    ...base,
    catalog: resolved.catalog,
    selection: resolved.selection,
    suiteId: resolved.suiteId,
    suiteVersion: resolved.suiteVersion,
    subject: { ...base.subject, runtimeConfigDigest: profile.runtimeConfigDigest },
    provider: {
      providerId: profile.provider.providerId,
      modelId: profile.provider.modelId,
      endpointBaseUrl: profile.provider.endpointBaseUrl,
      requestProfile: profile.requestProfile,
    },
  };
  try {
    const artifact = buildToolCallEfficiencyPreregistrationV2(options);
    const json = serializePreregistrationV2(artifact);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, json, "utf8");
    return {
      exitCode: 0,
      lines: [
        `prereg build: wrote ${outPath}`,
        `  preregistrationDigest: ${artifact.preregistrationDigest}`,
        `  planDigest:             ${artifact.schedule.planDigest}`,
        `  selectionProvenance:    ${artifact.dataset.selectionProvenanceDigest}`,
        `  cases: ${artifact.dataset.cases.length}  repetitions: ${artifact.schedule.repetitions}  logicalRuns: ${artifact.schedule.logicalRuns}`,
        `  worst-case model calls: ${artifact.budget.campaignWorstCaseModelCalls}`,
        "  provider calls: 0",
      ],
    };
  } catch (err) {
    return { exitCode: 1, lines: [`prereg build: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** `agent prereg validate <prereg.json> [--json]` */
async function validateCmd(rest: string[], deps: PreregCommandDeps): Promise<PreregCommandResult> {
  const parsed = parseArgs(rest, { valueFlags: [], boolFlags: ["--json"], minPositionals: 1, maxPositionals: 1 });
  if (!("positionals" in parsed)) return parsed;
  const preregPath = parsed.positionals[0]!;
  if (deps.runner === undefined) {
    return {
      exitCode: 1,
      lines: [
        "prereg validate: no harness adapter wired — an execution identity cannot be re-observed, so nothing can be certified (refusing to fabricate one)",
      ],
    };
  }
  const artifact = await loadArtifact(preregPath);
  if (artifact instanceof Error) return { exitCode: 1, lines: [`prereg validate: ${artifact.message}`] };
  const observation = await deps.runner.observe(artifact);
  const drift = observationViolationsV2(artifact, observation);
  const json = parsed.bools.has("--json");
  if (drift.length > 0) {
    const lines = [`prereg validate: REFUSED (PREREGISTRATION_IDENTITY_DRIFT)`, ...drift.map((d) => `  - ${d}`), "provider calls: 0"];
    return { exitCode: 1, lines: json ? [JSON.stringify({ ok: false, code: "PREREGISTRATION_IDENTITY_DRIFT", drift }) ] : lines };
  }
  return {
    exitCode: 0,
    lines: json
      ? [JSON.stringify({ ok: true, preregistrationDigest: artifact.preregistrationDigest, planDigest: artifact.schedule.planDigest })]
      : [
          `prereg validate: OK`,
          `  preregistrationDigest: ${artifact.preregistrationDigest}`,
          `  planDigest:             ${artifact.schedule.planDigest}`,
          "  provider calls: 0",
        ],
  };
}

async function loadArtifact(path: string): Promise<ToolCallEfficiencyPreregistrationV2 | Error> {
  let json: string;
  try {
    json = await readFile(path, "utf8");
  } catch (err) {
    return new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The strict loader lives behind the formal gate; importing it here without
  // triggering a run keeps `validate` free of provider construction.
  const { assertFormalExecutionPreregistration } = await import("@ar/evaluation");
  try {
    return assertFormalExecutionPreregistration(json);
  } catch (err) {
    return new Error(err instanceof Error ? err.message : String(err));
  }
}

/** `agent prereg run <prereg.json> --authorization <auth.json> --budget-dir <dir> --out <dir> --mode first-run|resume` */
async function runCmd(rest: string[], deps: PreregCommandDeps): Promise<PreregCommandResult> {
  const parsed = parseArgs(rest, {
    valueFlags: ["--authorization", "--budget-dir", "--out", "--mode"],
    boolFlags: [],
    requiredFlags: ["--authorization", "--budget-dir", "--out", "--mode"],
    minPositionals: 1,
    maxPositionals: 1,
  });
  if (!("positionals" in parsed)) return parsed;
  const preregPath = parsed.positionals[0]!;
  const authPath = parsed.values["--authorization"]!;
  const budgetDir = parsed.values["--budget-dir"]!;
  const outDir = parsed.values["--out"]!;
  // A3 — the mode is REQUIRED and explicit: a paid path is never entered through
  // an implicit `auto` default. `first-run` vs `resume` is a real semantic choice
  // (a resume must adopt, never re-create, an existing allowance), so the
  // operator must state it rather than let an omitted flag decide.
  const mode = parsed.values["--mode"];
  if (mode !== "first-run" && mode !== "resume") {
    return cliUsage(`--mode must be first-run or resume, got ${String(mode)}`);
  }
  // A3 — the run-record directory and the budget ledger must not alias or nest:
  // overlapping paths would let one overwrite or reuse the other's state.
  if (pathsOverlap(outDir, budgetDir)) {
    return cliUsage("--out and --budget-dir must be disjoint paths (they may not be equal or contain one another)");
  }
  if (deps.runner === undefined) {
    return {
      exitCode: 1,
      lines: ["prereg run: no harness adapter wired — refusing to run without a provider factory and arm runner (an environment key is not authorization)"],
    };
  }
  let preregJson: string;
  let authorizationJson: string;
  try {
    preregJson = await readFile(preregPath, "utf8");
  } catch (err) {
    return { exitCode: 1, lines: [`prereg run: cannot read ${preregPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  try {
    authorizationJson = await readFile(authPath, "utf8");
  } catch (err) {
    return { exitCode: 1, lines: [`prereg run: cannot read ${authPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // The observation must be re-derived BEFORE the gate so identity drift is
  // caught with 0 provider factory calls.
  const { assertFormalExecutionPreregistration } = await import("@ar/evaluation");
  let artifact: ToolCallEfficiencyPreregistrationV2;
  try {
    artifact = assertFormalExecutionPreregistration(preregJson);
  } catch (err) {
    return { exitCode: 1, lines: [`prereg run: PREREGISTRATION_INVALID: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const observation = await deps.runner.observe(artifact);

  const admission = await openPreregisteredCampaignGate({
    preregistrationJson: preregJson,
    authorizationJson,
    observation,
    budgetDir,
    mode: mode,
    now: deps.now,
    makeProvider: deps.runner.makeProvider,
  });
  if (admission.status === "REFUSED") {
    return {
      exitCode: 1,
      lines: [
        `prereg run: REFUSED (${admission.code})`,
        `  ${admission.reason}`,
        `  providerFactoryCalls: ${admission.providerFactoryCalls}`,
        `  providerCalls: ${admission.providerCalls}`,
      ],
    };
  }

  // The schedule driver is post-admission, but it must still fail CLOSED: a run
  // record that binds a DIFFERENT experiment, or a corrupt resume state, is a
  // stable refusal with a reason code — never an unhandled rejection.
  const resultsDir = join(outDir, "runs");
  let run: PreregisteredCampaignRun;
  try {
    run = await runPreregisteredCampaign({
      admission,
      prereg: artifact,
      resultsDir,
      runArm: deps.runner.runArm,
      resume: mode === "resume",
      now: deps.now,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "CAMPAIGN_DRIVER_FAILED";
    return {
      exitCode: 1,
      lines: [
        `prereg run: REFUSED (${code})`,
        `  ${err instanceof Error ? err.message : String(err)}`,
        `  providerFactoryCalls: ${admission.providerFactoryCalls}`,
      ],
    };
  }
  const ledgerView = await admission.ledger.view();
  const aggregate = aggregatePreregisteredCampaign(run, artifact, {
    providerCalls: ledgerView.committed,
    budgetRemaining: ledgerView.remaining,
  });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
  return {
    exitCode: 0,
    lines: [
      `prereg run: executed ${run.records.length} logical run(s) (resumed ${run.resumedArmRunIds.length})`,
      `  preregistrationDigest: ${run.preregistrationDigest}`,
      `  planDigest:             ${run.planDigest}`,
      `  decision: ${aggregate.decision.decision} [${aggregate.decision.reasonCodes.join(", ") || "no reason"}]`,
      `  provider calls: ${ledgerView.committed}  remaining: ${ledgerView.remaining}`,
      `  aggregate: ${join(outDir, "aggregate.json")}`,
    ],
  };
}

export async function preregCmd(rest: string[], deps: PreregCommandDeps = {}): Promise<PreregCommandResult> {
  const [sub, ...tail] = rest;
  switch (sub) {
    case "build":
      return buildCmd(tail);
    case "validate":
      return validateCmd(tail, deps);
    case "run":
      return runCmd(tail, deps);
    default:
      return usage();
  }
}