/**
 * N2 (F30-2) — ONE RESOLVED SELECTION: THE INJECTED ENV IS THE ONLY ENV.
 *
 * THE MEASURED DEFECT
 * -------------------
 * The release composition root resolved the SAME facts from DIFFERENT sources:
 * `offlineTransportForPrereg(env)` bound the non-billable capability to an
 * INJECTED env, while `createProductionPreregRunner()` (no `env`), the provider
 * factory (`resolveModelProvider()`), and `prereg build` all read `process.env`.
 * Whenever the two differed, a run's capability, its OBSERVED identity, the price
 * it bound and the provider it would have built could describe DIFFERENT
 * executions — and with a real key sitting in `process.env`, a keyless injected
 * run would have built a BILLABLE provider.
 *
 * WHAT IS PINNED HERE (each claim is its own expectation)
 * ------------------------------------------------------
 *   1. injected-keyless + process.env-with-a-key → the selection reports the
 *      OFFLINE identity, opens the capability, and `makeProvider()` yields the
 *      STUB — i.e. `process.env` is not consulted;
 *   2. injected-key + process.env-keyless → the selection reports the REAL
 *      identity and produces NO capability (no silent offline relabel);
 *   3. `prereg build` (the REAL command, 0 provider calls) binds the identity of
 *      the INJECTED env — and the one-dimension change (key in the injected env)
 *      moves it to the real identity, so the assertion is not vacuous;
 *   4. the pricing guard is ARMED from the same selection exactly when there is
 *      an executable WINDOWED basis, and is absent (never a zero-amount or
 *      no-window guard) otherwise — including the offline and stub selections,
 *      which make no externally-billed call at all.
 *
 * OFFLINE: every env below is synthetic; no key is real, no endpoint is
 * contacted, and the only provider object ever constructed here is never called.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallEfficiencyPreregistrationV2 } from "@ar/evaluation";
import {
  OFFLINE_MODEL_ID,
  OFFLINE_PROVIDER_ID,
  STUB_PROVIDER_ID,
} from "./provider.js";
import { preregCmd, type PreregResolvedSelection } from "./prereg-command.js";
import { preregCommandDeps, resolvePreregSelection } from "./main.js";
import { DECLARED_PRICING_ENV, PRICING_PER_CALL_TOKEN_ENVELOPE } from "./prereg-execution-identity.js";

const REPO_ROOT = process.cwd();

/** Keyless, offline-selected. */
const KEYLESS: NodeJS.ProcessEnv = {};
/** A real-shaped provider configuration. The key is a fake literal; nothing dials out. */
const REAL_ENV: NodeJS.ProcessEnv = {
  OPENAI_API_KEY: "sk-n2-not-a-real-key",
  OPENAI_MODEL: "n2-fake-model",
  OPENAI_BASE_URL: "https://n2-relay.invalid/v1",
};

const RELAY = "https://n2-relay.invalid/v1";
const RELAY_MODEL = "n2-relay-model";

/** A valid `prereg-pricing-v2` operator declaration with a REAL validity window. */
function windowedDeclaration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "prereg-pricing-v2",
    sourceKind: "operator_declared",
    source: "N2 test declaration — synthetic relay rate, never contacted",
    baseUrl: RELAY,
    currency: "USD",
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    coveredTokenCeiling: 64_000,
    ceilingByModel: { [RELAY_MODEL]: 1_000_000 },
    ...overrides,
  });
}

/** The paid-shaped env: a real provider identity PLUS the windowed declaration. */
const PRICED_ENV: NodeJS.ProcessEnv = {
  OPENAI_MODEL: RELAY_MODEL,
  OPENAI_BASE_URL: RELAY,
  [DECLARED_PRICING_ENV]: windowedDeclaration(),
};

const dirs: string[] = [];
async function tempDir(tag: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `n2-sel-${tag}-`));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A build config whose cases are DERIVED from the committed frozen selection. */
function buildConfig(): Record<string, unknown> {
  return {
    subject: {
      candidateSourceSha: "a".repeat(40),
      baselineArmDigest: "baseline-arm-digest-n2",
      candidateArmDigest: "candidate-arm-digest-n2",
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: "runtime-config-digest-n2",
    },
    candidateId: "tool_call_efficiency_v1",
    provider: { providerId: "ignored", modelId: "ignored", requestProfile: { budgetTokens: 32_000, stallPolicy: "default" } },
    suiteId: "tool-call-efficiency",
    suiteVersion: "1.0.0",
    evaluation: {
      judgeId: "judge-n2",
      judgeDigest: "judge-digest-n2",
      verifierDigest: "verifier-digest-n2",
      scorerDigest: "scorer-digest-n2",
      decisionPolicy: {
        version: "e4-05-policy-v1",
        minActivationEligibleCases: 3,
        minActivationCoverage: 0.5,
        maxVerifiedDrop: 0.05,
        minConclusiveNetDelta: 1,
        maxTokensDelta: 50000,
        securityBreachesAllowed: 0,
        minRecoveryRate: null,
      },
    },
    selectionEvidence: { root: REPO_ROOT },
    // The plan builder refuses < 2 repetitions (a decision-ready plan needs a
    // repeat), so a legal config states 2. No arm is executed by `build`.
    schedule: { repetitions: 2, orderSeed: 7 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 100,
      maxDurationMs: 600_000,
      maxInputTokens: 320_000,
      maxOutputTokens: 64_000,
      maxTotalTokens: 384_000,
      maxUsdMicros: null,
      pricingUnknownPolicy: "refuse",
    },
    isolation: {
      driverSchema: "r97-driver-v1",
      workerSchema: "r97-worker-v1",
      isolationBackendId: "trusted-build",
      isolationStrength: "no-os-network-sandbox",
      resumeStateSchema: "r97-execution-state-v1",
    },
  };
}

/** Run the REAL `prereg build` command and read back the artifact it wrote. */
async function buildWith(
  env: NodeJS.ProcessEnv,
  tag: string,
): Promise<{ result: { exitCode: number; lines: string[] }; artifact: ToolCallEfficiencyPreregistrationV2 }> {
  const dir = await tempDir(tag);
  const configPath = join(dir, "config.json");
  const outPath = join(dir, "prereg.json");
  await writeFile(configPath, JSON.stringify(buildConfig()), "utf8");
  const result = await preregCmd(["build", configPath, "--out", outPath], preregCommandDeps(env));
  const artifact = JSON.parse(await readFile(outPath, "utf8")) as ToolCallEfficiencyPreregistrationV2;
  return { result, artifact };
}

describe("N2/F30-2 — the injected env is the ONLY env the selection reads", () => {
  it("injected KEYLESS wins over a process.env that carries a key: offline identity, capability, stub factory", async () => {
    const saved = { ...process.env };
    try {
      // A credential-bearing process env, exactly the situation the defect needed.
      process.env["OPENAI_API_KEY"] = "sk-n2-process-env-not-real";
      process.env["OPENAI_MODEL"] = "n2-process-env-model";

      const selection = resolvePreregSelection(KEYLESS);
      expect(selection.profile.provider.providerId).toBe(OFFLINE_PROVIDER_ID);
      expect(selection.profile.provider.modelId).toBe(OFFLINE_MODEL_ID);
      expect(selection.profile.provider.endpointBaseUrl).toBeNull();
      expect(selection.offlineProfileSelected).toBe(true);

      // The capability is bound to the SAME observed identity the profile reports.
      const deps = preregCommandDeps(KEYLESS);
      expect(typeof deps.runner?.offlineTransport).toBe("function");
      expect(deps.selection?.profile.provider).toEqual(selection.profile.provider);

      // ...and the provider factory — the OTHER half of F30-2 — does not fall back
      // to `process.env` either: it resolves the STUB, not a billable provider.
      const provider = await deps.runner!.makeProvider();
      expect(provider.id).toBe(STUB_PROVIDER_ID);
    } finally {
      process.env = saved;
    }
  });

  it("injected REAL config wins over a keyless process.env: real identity and NO offline capability", async () => {
    const saved = { ...process.env };
    try {
      delete process.env["OPENAI_API_KEY"];
      delete process.env["OPENAI_MODEL"];
      delete process.env["OPENAI_BASE_URL"];

      const selection = resolvePreregSelection(REAL_ENV);
      // The offline profile was selected by the composition root AND a real
      // provider configuration is present: the conflict is resolved by DROPPING
      // the offline selection, never by hiding the credential-bearing provider.
      expect(selection.profile.provider.providerId).toBe("openai");
      expect(selection.profile.provider.endpointBaseUrl).toBe(REAL_ENV["OPENAI_BASE_URL"]);
      expect(selection.offlineProfileSelected).toBe(false);

      const deps = preregCommandDeps(REAL_ENV);
      expect(deps.runner?.offlineTransport).toBeUndefined();
      // The seam is gone but the adapter is fully wired — the gate keeps its
      // unchanged FIXTURE_TRANSPORT_NOT_NON_BILLABLE refusal path.
      expect(typeof deps.runner?.observe).toBe("function");
      expect(typeof deps.runner?.runArm).toBe("function");
    } finally {
      process.env = saved;
    }
  });
});

describe("N2/F30-2 — `prereg build` binds the SELECTION's identity, not the process env", () => {
  it("a keyless injected env binds the OFFLINE identity while process.env carries a key", async () => {
    const saved = { ...process.env };
    try {
      process.env["OPENAI_API_KEY"] = "sk-n2-process-env-not-real";
      process.env["OPENAI_MODEL"] = "n2-process-env-model";

      const { result, artifact } = await buildWith(KEYLESS, "offline");

      expect(result.exitCode, result.lines.join("\n")).toBe(0);
      // OLD BEHAVIOUR: the build read `process.env`, so this bound `openai`.
      expect(artifact.provider.providerId).toBe(OFFLINE_PROVIDER_ID);
      expect(artifact.provider.modelId).toBe(OFFLINE_MODEL_ID);
      // The offline profile makes no externally-billed call: no price is bound.
      expect(artifact.provider.pricingDigest).toBeUndefined();
      expect(artifact.provider.usdMicrosPerCall).toBeUndefined();
      expect(result.lines.join("\n")).toContain("provider calls: 0");
    } finally {
      process.env = saved;
    }
  });

  it("ONE dimension changed (the same injected env, now carrying a key) binds the REAL identity instead", async () => {
    const saved = { ...process.env };
    try {
      delete process.env["OPENAI_API_KEY"];

      const { result, artifact } = await buildWith(REAL_ENV, "real");

      expect(result.exitCode, result.lines.join("\n")).toBe(0);
      expect(artifact.provider.providerId).toBe("openai");
      expect(artifact.provider.modelId).toBe(REAL_ENV["OPENAI_MODEL"]);
      // ...so the two runs really are distinguishable by the env alone.
      expect(artifact.provider.providerId).not.toBe(OFFLINE_PROVIDER_ID);
    } finally {
      process.env = saved;
    }
  });

  it("COUNTER-EXAMPLE (live): a BARE caller with no selection still reads process.env — that IS the old behaviour", async () => {
    const saved = { ...process.env };
    try {
      process.env["OPENAI_API_KEY"] = "sk-n2-process-env-not-real";
      process.env["OPENAI_MODEL"] = "n2-process-env-model";

      // The OLD call shape: `preregCmd(args)` with no deps. Its identity comes
      // from the process env, which is exactly what the defect did — so the fix
      // is not "the identity moved", it is "the caller now supplies the ONE
      // resolved selection". Both behaviours are pinned so a future refactor
      // cannot quietly make the process env authoritative again.
      const dir = await tempDir("legacy");
      const configPath = join(dir, "config.json");
      const outPath = join(dir, "prereg.json");
      await writeFile(configPath, JSON.stringify(buildConfig()), "utf8");
      const result = await preregCmd(["build", configPath, "--out", outPath]);
      expect(result.exitCode, result.lines.join("\n")).toBe(0);
      const legacyArtifact = JSON.parse(await readFile(outPath, "utf8")) as ToolCallEfficiencyPreregistrationV2;
      expect(legacyArtifact.provider.providerId).toBe("openai");

      // ...and the SAME command with the selection supplied binds the offline
      // identity instead: one dimension changed (the deps), same process env.
      const selected = await buildWith(KEYLESS, "selected");
      expect(selected.artifact.provider.providerId).toBe(OFFLINE_PROVIDER_ID);
    } finally {
      process.env = saved;
    }
  });
});

describe("N2/F30-5 — the pricing guard is ARMED from the same selection, only where a price can execute", () => {
  it("a windowed operator declaration arms a guard whose fields ARE the resolved basis", () => {
    const selection: PreregResolvedSelection = resolvePreregSelection(PRICED_ENV);
    expect(selection.pricing.ok, JSON.stringify(selection.pricing)).toBe(true);
    if (!selection.pricing.ok) return;
    const basis = selection.pricing.basis;

    expect(selection.pricingGuard, "an executable windowed basis MUST arm the send-boundary guard").toBeDefined();
    const guard = selection.pricingGuard!;
    expect(guard.amountUsdMicros).toBe(1_000_000);
    expect(guard.basisDigest).toBe(basis.pricingDigest);
    expect(guard.sourceKind).toBe("operator_declared");
    expect(guard.currency).toBe("USD");
    expect(guard.issuedAtMs).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
    expect(guard.expiresAtMs).toBe(Date.parse("2099-01-01T00:00:00.000Z"));
    expect(guard.requiredTokenCeiling).toBe(PRICING_PER_CALL_TOKEN_ENVELOPE);
    // ...and the guard it hands over is the SAME object the command threads into
    // the gate, so "armed" is not a property of a copy nobody uses.
    expect(preregCommandDeps(PRICED_ENV).selection?.pricingGuard).toEqual(guard);
  });

  it("an already-expired window arms NOTHING — the campaign is refused at admission instead", () => {
    const expiredEnv: NodeJS.ProcessEnv = {
      ...PRICED_ENV,
      [DECLARED_PRICING_ENV]: windowedDeclaration({
        issuedAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-06-01T00:00:00.000Z",
      }),
    };
    const selection = resolvePreregSelection(expiredEnv);
    expect(selection.pricing.ok).toBe(false);
    // A price nobody can still stand behind is not "armed with a stale window":
    // it never reaches the send boundary, so the gate can never admit on it.
    expect(selection.pricingGuard).toBeUndefined();
  });

  it("a declaration too small for the request envelope arms NOTHING", () => {
    const thinEnv: NodeJS.ProcessEnv = {
      ...PRICED_ENV,
      [DECLARED_PRICING_ENV]: windowedDeclaration({ coveredTokenCeiling: 128 }),
    };
    const selection = resolvePreregSelection(thinEnv);
    expect(selection.pricing.ok).toBe(false);
    expect(selection.pricingGuard).toBeUndefined();
  });

  it("the OFFLINE selection arms nothing — it makes no externally-billed call to price", () => {
    const selection = resolvePreregSelection(KEYLESS);
    expect(selection.offlineProfileSelected).toBe(true);
    // `offline-scripted` has no priced basis (`provider_unknown`), so there is no
    // window a send could outlive. Inventing a zero/absent-window guard here would
    // refuse every offline send as "no windowed validity" — a behaviour change
    // with no billing fact behind it.
    expect(selection.pricing.ok).toBe(false);
    expect(selection.pricingGuard).toBeUndefined();
  });
});
