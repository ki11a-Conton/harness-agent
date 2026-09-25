/**
 * N5 — the zero-cost offline closed loop, driven through the REAL CLI chain.
 *
 * `agent prereg build` -> `agent prereg validate` -> `agent prereg run`, with a
 * deterministic fake provider and arm runner injected through the harness
 * adapter. Nothing here touches a network or an API key.
 *
 * Two families of assertions:
 *   1. the POSITIVE path executes exactly `cases × repetitions × 2` logical
 *      arm runs and every artifact carries the SAME root digest;
 *   2. every preflight violation refuses with `providerFactoryCalls = 0` — the
 *      factory itself must never be invoked (stronger than `providerCalls = 0`).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import {
  DEFAULT_DECISION_POLICY_V3,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  buildToolCallEfficiencyPreregistrationV2,
  captureEndpointIdentity,
  computeThresholdDigestV3,
  mechanismContractFor,
  selectionFromFrozenEvidence,
  serializePreregistrationV2,
  toolCallEfficiencyGuidanceDigest,
  type PreregistrationV2Options,
  type PreregisteredArmRunner,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";
import { stableStringify } from "@ar/evaluation";
import { runCommand, type CommandDeps } from "./commands.js";
import { formalExecutionProfile } from "./prereg-execution-identity.js";

const NOW = 1_700_000_000_000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * A2 — the identity the execution path derives from the CURRENT environment.
 * `prereg build` writes exactly these values, and `observationFor` re-derives
 * them the same way, so the CLI bytes and this test's expectation come from ONE
 * source of truth (a self-declared identity in the fixture would drift).
 */
const PROFILE = formalExecutionProfile();
const REQUEST_PROFILE = PROFILE.requestProfile;

/**
 * The fixture supplies the non-dataset identity (subject/provider/evaluation/
 * schedule/budget/isolation). Its `catalog`/`selection` placeholders are TEST_ONLY
 * and are NEVER sent to the CLI: A1 requires the sample set to be DERIVED
 * read-only from the frozen selection artifact, so the CLI config supplies only
 * `selectionEvidence` and the catalog is recomputed here for the expected bytes.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../scripts/e4/fixtures/n5-prereg-config.json", import.meta.url), "utf8"),
) as PreregistrationV2Options;

/** The frozen selection, re-derived read-only from committed evidence — the SAME
 *  derivation the CLI performs, so the CLI's bytes and this test's expectation
 *  come from one source of truth. */
const RESOLVED = selectionFromFrozenEvidence({ root: REPO_ROOT });
const CONTENT_DIGEST_BY_ID: Record<string, string> = Object.fromEntries(
  RESOLVED.catalog.map((c) => [c.caseId, c.contentDigest]),
);

const SHA_A = FIXTURE.subject.candidateSourceSha;
const CASE_IDS = RESOLVED.selection.caseIds;
const LOGICAL_RUNS = CASE_IDS.length * FIXTURE.schedule.repetitions * 2;
const WORST_CASE_CALLS = LOGICAL_RUNS * FIXTURE.budget.maxModelCallsPerRun;

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The expected artifact options: the DERIVED identity (A2) + the DERIVED dataset. */
function preregOptions(): PreregistrationV2Options {
  const { catalog: _catalog, selection: _selection, ...rest } = structuredClone(FIXTURE) as unknown as Record<
    string,
    unknown
  >;
  void _catalog;
  void _selection;
  return {
    ...(rest as unknown as PreregistrationV2Options),
    catalog: RESOLVED.catalog,
    selection: RESOLVED.selection,
    suiteId: RESOLVED.suiteId,
    suiteVersion: RESOLVED.suiteVersion,
    subject: { ...FIXTURE.subject, runtimeConfigDigest: PROFILE.runtimeConfigDigest },
    provider: {
      providerId: PROFILE.provider.providerId,
      modelId: PROFILE.provider.modelId,
      endpointBaseUrl: PROFILE.provider.endpointBaseUrl,
      requestProfile: PROFILE.requestProfile,
    },
  };
}

/** The CLI config: identity only — NO self-declared catalog/selection. */
function cliConfig(): Record<string, unknown> {
  const { catalog: _catalog, selection: _selection, ...rest } = structuredClone(FIXTURE) as unknown as Record<
    string,
    unknown
  >;
  void _catalog;
  void _selection;
  return { ...rest, selectionEvidence: { root: REPO_ROOT } };
}

function observationFor(over: Partial<PreregisteredCampaignObservationV2> = {}): PreregisteredCampaignObservationV2 {
  const caseContentDigests: Record<string, string> = { ...CONTENT_DIGEST_BY_ID };
  return {
    candidateSourceSha: SHA_A,
    cleanTree: true,
    baselineArmDigest: "baseline-arm-digest",
    candidateArmDigest: "candidate-arm-digest",
    guidanceDigest: toolCallEfficiencyGuidanceDigest(),
    contractDigest: sha(stableStringify(mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2))),
    runtimeConfigDigest: PROFILE.runtimeConfigDigest,
    providerId: PROFILE.provider.providerId,
    modelId: PROFILE.provider.modelId,
    endpointDigest: captureEndpointIdentity(PROFILE.provider.endpointBaseUrl) ?? "provider-default-endpoint",
    requestProfileDigest: sha(stableStringify(REQUEST_PROFILE)),
    caseContentDigests,
    decisionPolicyDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    // A KNOWN, non-null observed price: the fixture is money-bounded, so a
    // missing/undefined price would be refused as PRICING_UNKNOWN.
    usdMicrosPerCall: 0,
    ...over,
  };
}

function fakeProvider(): { provider: ModelProvider; calls: () => number } {
  let calls = 0;
  const provider: ModelProvider = {
    id: "fake",
    async listModels() {
      return [];
    },
    createClient(_model, _config: ProviderConfig) {
      return {
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          calls += 1;
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, calls: () => calls };
}

/** The deterministic arm runner: candidate passes and activates; baseline fails.
 *  The pass/activation claims are corroborated by per-run EVIDENCE (F2/S4) — the
 *  aggregate derives the decision from this, not from a bare boolean. */
const armRunner: PreregisteredArmRunner = async (arm, ctx) => {
  const client = ctx.provider.createClient({ providerId: "fake", modelId: "m" } as never, {} as ProviderConfig);
  for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
    // consume
  }
  const candidate = arm.armId === "candidate";
  return {
    status: candidate ? "passed" : "failed",
    tokensUsed: 15,
    evidence: {
      executorId: "n5-offline-fake-executor",
      traceDigest: "a".repeat(64),
      verifiedCompletion: candidate,
      securityViolations: 0,
      activationEvidenceDigest: candidate ? "b".repeat(64) : null,
    },
  };
};

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "n5-cli-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
let claimsDir: string | null = null;
beforeEach(async () => {
  claimsDir = await mkdtemp(join(tmpdir(), "n5-claims-"));
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = claimsDir;
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  if (claimsDir !== null) {
    await rm(claimsDir, { recursive: true, force: true }).catch(() => undefined);
    claimsDir = null;
  }
});

async function writeConfig(dir: string): Promise<string> {
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(cliConfig()), "utf8");
  return path;
}

function deps(opts: { observation?: PreregisteredCampaignObservationV2; provider?: ModelProvider; factory?: () => ModelProvider | Promise<ModelProvider> } = {}): {
  deps: CommandDeps;
  factory: ReturnType<typeof vi.fn>;
} {
  const factory = vi.fn(opts.factory ?? (() => opts.provider ?? fakeProvider().provider));
  return {
    factory,
    deps: {
      preregRunner: {
        observe: async () => opts.observation ?? observationFor(),
        makeProvider: factory,
        runArm: armRunner,
      },
      preregNow: () => NOW,
    } as unknown as CommandDeps,
  };
}

function authorizationFor(a: ToolCallEfficiencyPreregistrationV2, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "tool-call-efficiency-authorization-v2",
    preregistrationDigest: a.preregistrationDigest,
    candidateSourceSha: a.subject.candidateSourceSha,
    baselineArmDigest: a.subject.baselineArmDigest,
    candidateArmDigest: a.subject.candidateArmDigest,
    providerId: a.provider.providerId,
    modelId: a.provider.modelId,
    endpointDigest: a.provider.endpointDigest,
    caps: {
      maxModelCalls: a.budget.campaignWorstCaseModelCalls,
      maxToolCalls: a.budget.maxToolCalls,
      maxDurationMs: a.budget.maxDurationMs,
      maxInputTokens: a.budget.maxInputTokens,
      maxOutputTokens: a.budget.maxOutputTokens,
      maxTotalTokens: a.budget.maxTotalTokens,
      maxUsdMicros: a.budget.maxUsdMicros,
    },
    issuedAtMs: 1_000,
    expiresAtMs: 9_000_000_000_000,
    approvalId: "approval-1",
    allowResume: true,
    paid: true,
    ...over,
  });
}

/** `build` the artifact through the CLI, returning its path + parsed value. */
async function buildViaCli(dir: string): Promise<{ path: string; artifact: ToolCallEfficiencyPreregistrationV2 }> {
  const configPath = await writeConfig(dir);
  const outPath = join(dir, "prereg.json");
  const res = await runCommand(["prereg", "build", configPath, "--out", outPath], deps().deps);
  expect(res.exitCode).toBe(0);
  const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
  expect(await readFile(outPath, "utf8")).toBe(serializePreregistrationV2(artifact));
  return { path: outPath, artifact };
}

describe("N5 — agent prereg build is canonical and makes 0 provider calls", () => {
  it("writes the exact canonical bytes and prints the root digest", async () => {
    const dir = await tempDir();
    const { artifact } = await buildViaCli(dir);
    expect(artifact.schedule.logicalRuns).toBe(LOGICAL_RUNS);
    expect(artifact.budget.campaignWorstCaseModelCalls).toBe(WORST_CASE_CALLS);
  });

  it("requires --out (usage error, no artifact written)", async () => {
    const dir = await tempDir();
    const configPath = await writeConfig(dir);
    const res = await runCommand(["prereg", "build", configPath], deps().deps);
    expect(res.exitCode).toBe(2);
  });
});

describe("N5 — agent prereg validate re-observes identity with 0 provider calls", () => {
  it("accepts a matching observation", async () => {
    const dir = await tempDir();
    const { path } = await buildViaCli(dir);
    const res = await runCommand(["prereg", "validate", path], deps().deps);
    expect(res.exitCode).toBe(0);
    expect(res.lines.join("\n")).toContain("provider calls: 0");
  });

  const drifts: Array<[string, Partial<PreregisteredCampaignObservationV2>]> = [
    ["a dirty worktree", { cleanTree: false }],
    ["a different source sha", { candidateSourceSha: "b".repeat(40) }],
    ["a different baseline arm", { baselineArmDigest: "other" }],
    ["a different candidate arm", { candidateArmDigest: "other" }],
    ["changed guidance bytes", { guidanceDigest: "other-guidance" }],
    ["a different mechanism contract", { contractDigest: "other-contract" }],
    ["a changed runtime config", { runtimeConfigDigest: "other-runtime" }],
    ["a different provider", { providerId: "other-provider" }],
    ["a different model", { modelId: "other-model" }],
    ["a different endpoint", { endpointDigest: captureEndpointIdentity("https://api.other.com/v1")! }],
    ["a changed request profile", { requestProfileDigest: "other-profile" }],
    ["a changed case content", { caseContentDigests: Object.fromEntries(CASE_IDS.map((id) => [id, id === CASE_IDS[0] ? "changed" : CONTENT_DIGEST_BY_ID[id]!])) }],
    ["a changed decision policy", { decisionPolicyDigest: "other-policy" }],
  ];
  it.each(drifts)("refuses %s", async (_label, over) => {
    const dir = await tempDir();
    const { path } = await buildViaCli(dir);
    const res = await runCommand(["prereg", "validate", path], deps({ observation: observationFor(over) }).deps);
    expect(res.exitCode).toBe(1);
    expect(res.lines.join("\n")).toContain("PREREGISTRATION_IDENTITY_DRIFT");
  });

  it("refuses to validate without a harness adapter (never fabricates an identity)", async () => {
    const dir = await tempDir();
    const { path } = await buildViaCli(dir);
    const res = await runCommand(["prereg", "validate", path], {} as CommandDeps);
    expect(res.exitCode).toBe(1);
  });
});

describe("N5 — the offline closed loop executes exactly the frozen schedule", () => {
  it("runs the frozen schedule with one root digest and reaches ACCEPT", async () => {
    const dir = await tempDir();
    const { path, artifact } = await buildViaCli(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, authorizationFor(artifact), "utf8");
    const outDir = join(dir, "out");
    const fake = fakeProvider();
    const { deps: d, factory } = deps({ provider: fake.provider });

    const res = await runCommand(
      ["prereg", "run", path, "--authorization", authPath, "--budget-dir", join(dir, "budget"), "--out", outDir, "--mode", "first-run"],
      d,
    );
    expect(res.exitCode).toBe(0);
    expect(res.lines.join("\n")).toContain(`executed ${LOGICAL_RUNS} logical run(s)`);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.calls()).toBe(LOGICAL_RUNS);

    const aggregate = JSON.parse(await readFile(join(outDir, "aggregate.json"), "utf8")) as {
      preregistrationDigest: string;
      planDigest: string;
      decision: { decision: string; reasonCodes: string[] };
      providerCalls: number;
    };
    expect(aggregate.preregistrationDigest).toBe(artifact.preregistrationDigest);
    expect(aggregate.planDigest).toBe(artifact.schedule.planDigest);
    expect(aggregate.decision.decision).toBe("ACCEPT");
    expect(aggregate.providerCalls).toBe(LOGICAL_RUNS);
  });

  it("resumes the SAME digest without re-spending calls", async () => {
    const dir = await tempDir();
    const { path, artifact } = await buildViaCli(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, authorizationFor(artifact), "utf8");
    const budgetDir = join(dir, "budget");
    const outDir = join(dir, "out");
    const first = deps({ provider: fakeProvider().provider });
    await runCommand(["prereg", "run", path, "--authorization", authPath, "--budget-dir", budgetDir, "--out", outDir, "--mode", "first-run"], first.deps);
    expect(first.factory).toHaveBeenCalledTimes(1);

    const second = deps({ provider: fakeProvider().provider });
    const res = await runCommand(["prereg", "run", path, "--authorization", authPath, "--budget-dir", budgetDir, "--out", outDir, "--mode", "resume"], second.deps);
    expect(res.exitCode).toBe(0);
    expect(res.lines.join("\n")).toContain(`resumed ${LOGICAL_RUNS}`);
    expect(second.factory).toHaveBeenCalledTimes(1);
    expect((second.deps as never as { provider?: unknown }) === undefined).toBe(false);
  });
});

describe("N5 — every pre-provider violation refuses with 0 provider factory calls", () => {
  async function refusal(
    label: string,
    mutate: (ctx: { preregJson: string; authJson: string; artifact: ToolCallEfficiencyPreregistrationV2 }) => { preregJson?: string; authJson?: string; observation?: PreregisteredCampaignObservationV2 },
  ): Promise<void> {
    const dir = await tempDir();
    const { path, artifact } = await buildViaCli(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, authorizationFor(artifact), "utf8");
    const mutated = mutate({ preregJson: await readFile(path, "utf8"), authJson: await readFile(authPath, "utf8"), artifact });
    const preregFile = join(dir, "mutated-prereg.json");
    const authFile = join(dir, "mutated-auth.json");
    await writeFile(preregFile, mutated.preregJson ?? (await readFile(path, "utf8")), "utf8");
    await writeFile(authFile, mutated.authJson ?? (await readFile(authPath, "utf8")), "utf8");
    const { deps: d, factory } = deps(mutated.observation !== undefined ? { observation: mutated.observation } : {});
    const res = await runCommand(
      ["prereg", "run", preregFile, "--authorization", authFile, "--budget-dir", join(dir, "budget"), "--out", join(dir, "out"), "--mode", "first-run"],
      d,
    );
    expect(res.exitCode, label).toBe(1);
    expect(factory, label).toHaveBeenCalledTimes(0);
  }

  it("refuses a tampered root digest", async () => {
    await refusal("root digest", ({ preregJson }) => {
      const o = JSON.parse(preregJson) as Record<string, unknown>;
      o.preregistrationDigest = "f".repeat(64);
      return { preregJson: JSON.stringify(o) };
    });
  });

  it("refuses a source-sha drift", async () => {
    await refusal("source sha", () => ({ observation: observationFor({ candidateSourceSha: "b".repeat(40) }) }));
  });

  it("refuses a dirty worktree", async () => {
    await refusal("dirty tree", () => ({ observation: observationFor({ cleanTree: false }) }));
  });

  it("refuses a changed guidance digest", async () => {
    await refusal("guidance", () => ({ observation: observationFor({ guidanceDigest: "other" }) }));
  });

  it("refuses a changed case content digest", async () => {
    await refusal("case content", () => ({
      observation: observationFor({
        caseContentDigests: Object.fromEntries(CASE_IDS.map((id) => [id, id === CASE_IDS[1] ? "changed" : CONTENT_DIGEST_BY_ID[id]!])),
      }),
    }));
  });

  it("refuses a changed decision policy", async () => {
    await refusal("policy", () => ({ observation: observationFor({ decisionPolicyDigest: "other" }) }));
  });

  it("refuses a different provider identity", async () => {
    await refusal("provider", () => ({ observation: observationFor({ providerId: "other-provider" }) }));
  });

  it("refuses a different model identity", async () => {
    await refusal("model", () => ({ observation: observationFor({ modelId: "other-model" }) }));
  });

  it("refuses a different baseline arm build", async () => {
    await refusal("baseline arm", () => ({ observation: observationFor({ baselineArmDigest: "other-baseline" }) }));
  });

  it("refuses a different candidate arm build", async () => {
    await refusal("candidate arm", () => ({ observation: observationFor({ candidateArmDigest: "other-candidate" }) }));
  });

  it("refuses a changed runtime config", async () => {
    await refusal("runtime config", () => ({ observation: observationFor({ runtimeConfigDigest: "other-runtime" }) }));
  });

  it("refuses a changed request profile", async () => {
    await refusal("request profile", () => ({ observation: observationFor({ requestProfileDigest: "other-profile" }) }));
  });

  it("refuses a changed mechanism contract", async () => {
    await refusal("contract", () => ({ observation: observationFor({ contractDigest: "other-contract" }) }));
  });

  it("refuses a case set whose observed ids do not match the selection", async () => {
    await refusal("case list", () => {
      const { [CASE_IDS[0]!]: _dropped, ...rest } = observationFor().caseContentDigests;
      void _dropped;
      return { observation: observationFor({ caseContentDigests: rest }) };
    });
  });

  it("refuses a different endpoint", async () => {
    await refusal("endpoint", () => ({ observation: observationFor({ endpointDigest: captureEndpointIdentity("https://api.other.com/v1")! }) }));
  });

  it("refuses an authorization bound to a different digest", async () => {
    await refusal("auth digest", ({ authJson }) => {
      const o = JSON.parse(authJson) as Record<string, unknown>;
      o.preregistrationDigest = "0".repeat(64);
      return { authJson: JSON.stringify(o) };
    });
  });

  it("refuses an authorization without the paid flag", async () => {
    await refusal("paid flag", ({ authJson }) => {
      const o = JSON.parse(authJson) as Record<string, unknown>;
      o.paid = false;
      return { authJson: JSON.stringify(o) };
    });
  });

  it("refuses an expired authorization", async () => {
    await refusal("expired", ({ authJson }) => {
      const o = JSON.parse(authJson) as Record<string, unknown>;
      o.issuedAtMs = 1;
      o.expiresAtMs = 2;
      return { authJson: JSON.stringify(o) };
    });
  });

  it("refuses a budget one call below the pre-registered worst case", async () => {
    await refusal("budget short", ({ authJson, artifact }) => {
      const o = JSON.parse(authJson) as { caps: { maxModelCalls: number } };
      o.caps.maxModelCalls = artifact.budget.campaignWorstCaseModelCalls - 1;
      return { authJson: JSON.stringify(o) };
    });
  });

  it("refuses an approval that narrows a token cap", async () => {
    await refusal("token cap", ({ authJson, artifact }) => {
      const o = JSON.parse(authJson) as { caps: { maxTotalTokens: number } };
      o.caps.maxTotalTokens = artifact.budget.maxTotalTokens - 1;
      return { authJson: JSON.stringify(o) };
    });
  });

  it("refuses a tampered derived field in the artifact (logicalRuns)", async () => {
    await refusal("derived runs", ({ preregJson }) => {
      const o = JSON.parse(preregJson) as Record<string, unknown>;
      (o.schedule as Record<string, unknown>).logicalRuns = 34;
      return { preregJson: JSON.stringify(o) };
    });
  });

  it("refuses a tampered case-set digest in the artifact", async () => {
    await refusal("case-set digest", ({ preregJson }) => {
      const o = JSON.parse(preregJson) as Record<string, unknown>;
      (o.dataset as Record<string, unknown>).caseSetDigest = "tampered";
      return { preregJson: JSON.stringify(o) };
    });
  });
});

describe("N5 — resume only continues the SAME frozen experiment", () => {
  async function firstRun(dir: string): Promise<{ path: string; authPath: string; budgetDir: string; outDir: string }> {
    const { path, artifact } = await buildViaCli(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, authorizationFor(artifact), "utf8");
    const budgetDir = join(dir, "budget");
    const outDir = join(dir, "out");
    const res = await runCommand(
      ["prereg", "run", path, "--authorization", authPath, "--budget-dir", budgetDir, "--out", outDir, "--mode", "first-run"],
      deps({ provider: fakeProvider().provider }).deps,
    );
    expect(res.exitCode).toBe(0);
    return { path, authPath, budgetDir, outDir };
  }

  it("refuses to resume when a run record binds a DIFFERENT experiment identity", async () => {
    const dir = await tempDir();
    const { path, authPath, budgetDir, outDir } = await firstRun(dir);
    // Tamper ONE run record so it claims a different root digest — a resume must
    // never mix a foreign run into this campaign.
    const runsDir = join(outDir, "runs");
    const [one] = (await readdir(runsDir)).filter((f) => f.endsWith(".json"));
    const recPath = join(runsDir, one!);
    const rec = JSON.parse(await readFile(recPath, "utf8")) as Record<string, unknown>;
    rec.preregistrationDigest = "9".repeat(64);
    await writeFile(recPath, JSON.stringify(rec), "utf8");
    // Drop the first run's decision so we can prove a refused resume emits none.
    await rm(join(outDir, "aggregate.json"), { force: true });

    const res = await runCommand(
      ["prereg", "run", path, "--authorization", authPath, "--budget-dir", budgetDir, "--out", outDir, "--mode", "resume"],
      deps({ provider: fakeProvider().provider }).deps,
    );
    expect(res.exitCode).toBe(1);
    const text = res.lines.join("\n");
    expect(text).toContain("RESUME_IDENTITY_MISMATCH");
    // A refused resume must NOT emit a decision — nothing is aggregated.
    await expect(readFile(join(outDir, "aggregate.json"), "utf8")).rejects.toThrow();
  });

  it("refuses to resume when the run records are corrupt", async () => {
    const dir = await tempDir();
    const { path, authPath, budgetDir, outDir } = await firstRun(dir);
    const runsDir = join(outDir, "runs");
    const [one] = (await readdir(runsDir)).filter((f) => f.endsWith(".json"));
    await writeFile(join(runsDir, one!), "{ not json", "utf8");

    const res = await runCommand(
      ["prereg", "run", path, "--authorization", authPath, "--budget-dir", budgetDir, "--out", outDir, "--mode", "resume"],
      deps({ provider: fakeProvider().provider }).deps,
    );
    expect(res.exitCode).toBe(1);
    expect(res.lines.join("\n")).toContain("RESUME_STATE_CORRUPT");
  });
});