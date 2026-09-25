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
import { dirname, join } from "node:path";
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
} from "@ar/evaluation";

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
  run <prereg.json> --authorization <auth.json> --budget-dir <dir> --out <dir> [--mode first-run|resume]
      Execute the frozen schedule through the formal gate. An API key or
      RUN_PAID_BENCHMARKS is NOT authorization: without a valid
      artifact-bound authorization this REFUSES before any provider exists.

  An execution-semantic override (cases/repetitions/provider/model/budget) is
  not accepted on the command line: it would authorize a different experiment.`;

function usage(): PreregCommandResult {
  return { exitCode: 2, lines: [USAGE] };
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

/** Positional arguments, skipping any value consumed by a known value flag. */
function positionals(rest: string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      if (valueFlags.includes(a)) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `agent prereg build <config.json> --out <prereg.json>` */
async function buildCmd(rest: string[]): Promise<PreregCommandResult> {
  const configPath = positionals(rest, ["--out"])[0];
  const outPath = flag(rest, "--out");
  if (configPath === undefined || outPath === undefined) return usage();
  let options: PreregistrationV2Options;
  try {
    options = JSON.parse(await readFile(configPath, "utf8")) as PreregistrationV2Options;
  } catch (err) {
    return { exitCode: 1, lines: [`prereg build: cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }
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
  const preregPath = rest.find((a) => !a.startsWith("--"));
  if (preregPath === undefined) return usage();
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
  const json = rest.includes("--json");
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

/** `agent prereg run <prereg.json> --authorization <auth.json> --budget-dir <dir> --out <dir> [--mode …]` */
async function runCmd(rest: string[], deps: PreregCommandDeps): Promise<PreregCommandResult> {
  const preregPath = positionals(rest, ["--authorization", "--budget-dir", "--out", "--mode"])[0];
  const authPath = flag(rest, "--authorization");
  const budgetDir = flag(rest, "--budget-dir");
  const outDir = flag(rest, "--out");
  const mode = flag(rest, "--mode");
  if (preregPath === undefined || authPath === undefined || budgetDir === undefined || outDir === undefined) return usage();
  if (mode !== undefined && mode !== "first-run" && mode !== "resume") {
    return { exitCode: 2, lines: [`prereg run: --mode must be first-run or resume, got ${mode}`] };
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
    mode: mode ?? "auto",
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