/**
 * R0 / F5 — RED counterexamples for `PREREG_PRICING_JSON`
 * (`apps/cli/src/prereg-execution-identity.ts`, plan(20260928-105425).md §R0
 * line 63 and §R4 lines 136-155).
 *
 * THE DEFECT (P1): the operator declaration that prices a relay has
 *   (a) no validity period — a value declared once prices the endpoint forever;
 *   (b) no approval-bound pricing digest — `observationViolationsV2` compares
 *       provider/model/endpoint/request-profile digests but NOT the per-call
 *       price or the pricing basis, so a swapped rate (or a swapped rate
 *       SOURCE) cannot produce identity drift;
 *   (c) the wrong env — `resolveUsdMicrosPerCall` reads the declaration from the
 *       global `process.env` even when its caller was handed an explicit env
 *       (`observeExecutionIdentity(root, env)` uses `env` for every other
 *       identity input), so two fixed envs can cross-contaminate one price.
 *
 * THESE TESTS ARE DELIBERATELY RED. They assert the TARGET (post-R4) behaviour.
 * They must not be collected by `pnpm test`: the root config EXCLUDES exactly
 * these two files and `r0-gaps-vitest.config.ts` selects them (the same
 * H04/B0/N0 arrangement as `prereg-n0-gaps.test.ts`).
 * R4 owns the fix; R0 does NOT touch production source.
 *
 * OFFLINE: every call below is pure. No provider is constructed, no socket is
 * opened, no key is used (the `OPENAI_API_KEY` value is an obviously fake
 * placeholder that is never sent anywhere). `127.0.0.1:45999` is used as an
 * inert endpoint STRING — nothing listens there and nothing connects to it.
 * It is deliberately not the user's relay.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  DECLARED_PRICING_ENV,
  resolveDeclaredUsdMicrosPerCall,
  resolveUsdMicrosPerCall,
} from "./prereg-execution-identity.js";
import { observeExecutionIdentity } from "./prereg-production-runner.js";
import { REAL_PROVIDER_ID } from "./provider.js";
import {
  observationViolationsV2,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** An inert loopback STRING (nothing listens, nothing connects). */
const RELAY = "http://127.0.0.1:45999/v1";
const RELAY_MODEL = "workbuddy-deepseek-v4.1-flash";
/** A deliberately non-secret placeholder; it is never transmitted. */
const FAKE_KEY = "r0-not-a-real-credential";

const ORIGINAL = process.env[DECLARED_PRICING_ENV];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[DECLARED_PRICING_ENV];
  else process.env[DECLARED_PRICING_ENV] = ORIGINAL;
});

function declaration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    baseUrl: RELAY,
    source: "operator-declared per-call ceiling (R0 test fixture)",
    boundByModel: { [RELAY_MODEL]: 1_000_000 },
    ...overrides,
  });
}

/** The two-argument production signature R4 must widen to take the same env. */
type EnvAwareResolve = (
  providerId: string,
  query: { modelId?: string; endpointBaseUrl?: string | null },
  env: Record<string, string | undefined>,
) => number | null;

/**
 * A minimal pre-registration + observation pair that differs in NOTHING the
 * current comparison looks at, so any reported violation is attributable to the
 * one field under test. `pricingDigest` / `usdMicrosPerCall` are the fields
 * §R4 requires the artifact to bind; they are cast in because the v2 type does
 * not carry them yet — which is the point of the RED.
 */
function identityFixture(): {
  artifact: ToolCallEfficiencyPreregistrationV2;
  observation: PreregisteredCampaignObservationV2;
} {
  const sha = (c: string): string => c.repeat(64);
  const identity = {
    candidateSourceSha: "a".repeat(40),
    baselineArmDigest: sha("b"),
    candidateArmDigest: sha("c"),
    runtimeConfigDigest: sha("d"),
    guidanceDigest: sha("e"),
    contractDigest: sha("f"),
    providerId: REAL_PROVIDER_ID,
    modelId: RELAY_MODEL,
    endpointDigest: sha("1"),
    requestProfileDigest: sha("2"),
    decisionPolicyDigest: sha("3"),
    selectionProvenanceDigest: sha("4"),
    caseContentDigest: sha("5"),
    eligibilityDigest: sha("6"),
  };
  const artifact = {
    subject: {
      candidateSourceSha: identity.candidateSourceSha,
      baselineArmDigest: identity.baselineArmDigest,
      candidateArmDigest: identity.candidateArmDigest,
      runtimeConfigDigest: identity.runtimeConfigDigest,
    },
    prompt: { guidanceDigest: identity.guidanceDigest, contractDigest: identity.contractDigest },
    provider: {
      providerId: identity.providerId,
      modelId: identity.modelId,
      endpointDigest: identity.endpointDigest,
      requestProfileDigest: identity.requestProfileDigest,
    },
    evaluation: { decisionPolicyDigest: identity.decisionPolicyDigest },
    dataset: {
      selectionProvenanceDigest: identity.selectionProvenanceDigest,
      cases: [
        {
          caseId: "case-r0-0001",
          contentDigest: identity.caseContentDigest,
          eligibilityDigest: identity.eligibilityDigest,
        },
      ],
    },
    // The approved pricing basis (what R4 must bind into the pre-registration).
    pricingDigest: sha("7"),
    usdMicrosPerCall: 1_000_000,
  } as unknown as ToolCallEfficiencyPreregistrationV2;
  const observation = {
    ...identity,
    cleanTree: true,
    caseContentDigests: { "case-r0-0001": identity.caseContentDigest },
    eligibilityDigests: { "case-r0-0001": identity.eligibilityDigest },
    // The SAME approved basis...
    pricingDigest: sha("7"),
    usdMicrosPerCall: 1_000_000,
    endpointIsLoopback: true,
  } as unknown as PreregisteredCampaignObservationV2;
  return { artifact, observation };
}

describe("R0/F5 — the operator pricing declaration is not a frozen identity input", () => {
  it("R0-F5-fold (control, PASSES today): a valid declared rate still prices the relay through the helper that IS handed the env", () => {
    // This is the mechanism R4 must KEEP. It is the positive control that proves
    // the RED tests below fail on their target assertion and not on a broken
    // fixture/module resolution.
    const raw = declaration({
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(
      resolveDeclaredUsdMicrosPerCall({ modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, { [DECLARED_PRICING_ENV]: raw }),
    ).toBe(1_000_000);
  });

  it("R0-F5-A (RED): a declaration with NO validity period must not be usable as a price", () => {
    // Minimal input: the declaration exactly as the current schema defines it —
    // baseUrl + source + boundByModel, and no validity metadata at all.
    const raw = declaration();
    // TARGET: a declaration that cannot state when it was issued or when it
    // lapses is not a bound price (plan §R4: "过期、重复键、遗漏字段…被拒绝").
    expect(
      resolveDeclaredUsdMicrosPerCall({ modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, { [DECLARED_PRICING_ENV]: raw }),
    ).toBeNull();
  });

  it("R0-F5-B (RED): a declaration whose validity window has LAPSED must not price the relay", () => {
    const raw = declaration({
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-02T00:00:00.000Z",
    });
    // TARGET: an expired declaration is void. Today both unknown fields are
    // ignored, so the stale 1_000_000 µUSD/call bound is still returned.
    expect(
      resolveDeclaredUsdMicrosPerCall({ modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, { [DECLARED_PRICING_ENV]: raw }),
    ).toBeNull();
  });

  it("R0-F5-C (RED): a swapped pricing basis is INVISIBLE to the identity comparison (no pricing drift)", () => {
    const { artifact, observation } = identityFixture();
    // Sanity: the fixture differs in nothing the current comparison inspects.
    expect(observationViolationsV2(artifact, observation)).toEqual([]);
    // Minimal input: the SAME run, with the approved pricing basis replaced by a
    // 99x-more-expensive one (price + digest) after approval.
    const swapped = { ...observation, pricingDigest: "8".repeat(64), usdMicrosPerCall: 99_000_000 };
    // TARGET: swapping the pricing basis must be execution-identity drift.
    const violations = observationViolationsV2(artifact, swapped);
    expect(
      violations.some((v) => /pricing|usdMicrosPerCall/i.test(v)),
      `expected a pricing-drift violation; got: ${JSON.stringify(violations)}`,
    ).toBe(true);
  });

  it("R0-F5-D (RED): resolveUsdMicrosPerCall must read the env it was HANDED, not process.env", () => {
    const raw = declaration();
    const withEnv = resolveUsdMicrosPerCall as unknown as EnvAwareResolve;
    const query = { modelId: RELAY_MODEL, endpointBaseUrl: RELAY };

    // Minimal input 1: the declaration exists ONLY in the injected env.
    delete process.env[DECLARED_PRICING_ENV];
    // TARGET: the injected env is the source of truth (plan §R4 #1).
    expect(withEnv(REAL_PROVIDER_ID, query, { [DECLARED_PRICING_ENV]: raw })).toBe(1_000_000);

    // Minimal input 2: the declaration exists ONLY in the global env.
    process.env[DECLARED_PRICING_ENV] = raw;
    // TARGET: a call handed an EMPTY env must not be priced by process.env.
    expect(withEnv(REAL_PROVIDER_ID, query, {})).toBeNull();
  });

  it("R0-F5-E (RED): observeExecutionIdentity(env) must not price from a DIFFERENT process.env declaration", () => {
    // Minimal input: the caller's env declares 1_000_000 µUSD/call; the global
    // process env declares 99_000_000 µUSD/call for the same endpoint+model.
    const injected = {
      OPENAI_API_KEY: FAKE_KEY,
      OPENAI_MODEL: RELAY_MODEL,
      OPENAI_BASE_URL: RELAY,
      [DECLARED_PRICING_ENV]: declaration({ boundByModel: { [RELAY_MODEL]: 1_000_000 } }),
    } as NodeJS.ProcessEnv;
    process.env[DECLARED_PRICING_ENV] = declaration({ boundByModel: { [RELAY_MODEL]: 99_000_000 } });

    const observed = observeExecutionIdentity(REPO_ROOT, injected);

    // TARGET: the observed price comes from the env that was handed in.
    // This is the production call site: `formalExecutionProfile(env)` and
    // `env["R97_ARM_*"]` use `injected`, but the price silently uses the global.
    expect(observed.usdMicrosPerCall).toBe(1_000_000);
  });
});
