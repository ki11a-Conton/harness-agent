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
  parseDeclaredPricingStrict,
  resolveDeclaredUsdMicrosPerCall,
  resolvePricingBasis,
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

/**
 * R7 refresh — the V2 WINDOWED declaration, as `parseDeclaredPricingStrict`
 * actually accepts it (`schema: "prereg-pricing-v2"`, `sourceKind` never
 * `provider_verified`, one validity window, and `rates`/`ceilingByModel` bounds).
 * The LEGACY shape's allowed keys are exactly `baseUrl`/`source`/`boundByModel`,
 * so validity metadata on the legacy shape is an `unknown_field` rejection — which
 * is why the old `R0-F5-fold` call site failed.
 */
function windowedDeclaration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "prereg-pricing-v2",
    sourceKind: "operator_declared",
    source: "operator-declared per-call ceiling (R0 test fixture)",
    baseUrl: RELAY,
    currency: "USD",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    coveredTokenCeiling: 64_000,
    ceilingByModel: { [RELAY_MODEL]: 1_000_000 },
    ...overrides,
  });
}

/** The two-argument production signature R4 must widen to take the same env. */
type EnvAwareResolve = (
  providerId: string,
  query: { modelId?: string; endpointBaseUrl?: string | null },
  env: Record<string, string | undefined>,
  nowMs?: number,
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
    //
    // R7 REFRESH: the call site was written against the OLD minimal declaration
    // shape, and it fed `issuedAt`/`expiresAt` into the LEGACY shape whose allowed
    // keys are exactly `baseUrl`/`source`/`boundByModel` — the strict parser
    // correctly rejected it as `unknown_field`. Both ACCEPTED forms are pinned
    // here instead: the labelled legacy mode, and the v2 windowed mode.
    //
    // F6 REFRESH (plan(20260929-015956).md §9): the legacy form is READABLE but
    // has NO execution eligibility, so the positive control must use the v2
    // WINDOWED form. The legacy form is pinned as an explicit refusal instead of
    // being silently priced — this is the F6 fix, not a weakened assertion.
    const legacy = declaration();
    expect(
      resolveDeclaredUsdMicrosPerCall({ modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, { [DECLARED_PRICING_ENV]: legacy }),
    ).toBeNull();
    const legacyParsed = parseDeclaredPricingStrict(legacy);
    expect(legacyParsed.ok).toBe(true);
    if (legacyParsed.ok) {
      expect(legacyParsed.value.mode).toBe("legacy_ephemeral");
      expect(legacyParsed.value.boundByModel[RELAY_MODEL]).toBe(1_000_000);
    }

    const windowed = windowedDeclaration();
    const parsed = parseDeclaredPricingStrict(windowed);
    expect(parsed.ok, parsed.ok ? "" : `${parsed.reason}: ${parsed.detail}`).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.mode).toBe("v2_windowed");
      expect(parsed.value.issuedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(parsed.value.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    }
    expect(
      resolveDeclaredUsdMicrosPerCall({ modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, { [DECLARED_PRICING_ENV]: windowed }),
    ).toBe(1_000_000);
  });

  it("R0-F5-A (re-expressed): a validity-less declaration is admitted ONLY as an explicitly-labelled legacy mode", () => {
    // R7 — THE ASSERTION IS RE-EXPRESSED, THE CONTRACT IS NOT WEAKENED.
    //
    // The original RED demanded `null` for a declaration with no validity period.
    // That is no longer the accepted contract: task-6 deliberately KEEPS the
    // historical minimal shape as an explicitly-labelled `legacy_ephemeral` mode
    // (`sourceKind: "operator_declared"`), which is a supported mode rather than a
    // gap. Demanding `null` would have required weakening the production contract
    // to satisfy a stale test — refused.
    //
    // What MUST hold (and is what the gap was really about) is that such a
    // declaration can never masquerade as a windowed or provider-verified price:
    // it is labelled, its validity is explicitly `null`, and its digest commits to
    // that label, so a reviewer can always tell the two modes apart.
    const raw = declaration();
    const parsed = parseDeclaredPricingStrict(raw);
    expect(parsed.ok, parsed.ok ? "" : `${parsed.reason}: ${parsed.detail}`).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mode).toBe("legacy_ephemeral");
    expect(parsed.value.sourceKind).toBe("operator_declared");
    expect(parsed.value.issuedAt).toBeNull();
    expect(parsed.value.expiresAt).toBeNull();
    // The two modes are DIFFERENT bases: a legacy declaration can never produce
    // the windowed digest (so a mode swap is visible to the identity comparison).
    const windowed = parseDeclaredPricingStrict(windowedDeclaration());
    expect(windowed.ok).toBe(true);
    if (windowed.ok) expect(windowed.value.digest).not.toBe(parsed.value.digest);
    // ...and the env var can never self-declare a provider-verified price.
    const forged = parseDeclaredPricingStrict(declaration({ sourceKind: "provider_verified" }));
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.reason).toBe("unknown_field");
    const forgedV2 = parseDeclaredPricingStrict(windowedDeclaration({ sourceKind: "provider_verified" }));
    expect(forgedV2.ok).toBe(false);
    if (!forgedV2.ok) expect(forgedV2.reason).toBe("self_declared_provider_verified");
    // F6 REFRESH (plan(20260929-015956).md §9): READABLE is no longer the same as
    // EXECUTABLE. The legacy declaration is still parsed, labelled and reviewable
    // (asserted above), but it carries no validity window and no covered token
    // ceiling, so it must NOT price a new billed run or a resume. The execution
    // surfaces refuse it; an empty env prices nothing either way.
    expect(
      resolveDeclaredUsdMicrosPerCall({ modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, { [DECLARED_PRICING_ENV]: raw }),
    ).toBeNull();
    expect(resolveDeclaredUsdMicrosPerCall({ modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, {})).toBeNull();
    // The refusal is the STABLE F6 reason, not a generic "invalid", and the
    // windowed form is the one that still prices the same relay/rate.
    const refusal = resolvePricingBasis(
      REAL_PROVIDER_ID,
      { modelId: RELAY_MODEL, endpointBaseUrl: RELAY, requiredTokenCeiling: 32_000 },
      { [DECLARED_PRICING_ENV]: raw },
      Date.parse("2026-06-01T00:00:00.000Z"),
    );
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.reason).toBe("legacy_not_executable");
      expect(refusal.detail).toContain("prereg-pricing-v2");
    }
    expect(
      resolveDeclaredUsdMicrosPerCall(
        { modelId: RELAY_MODEL, endpointBaseUrl: RELAY },
        { [DECLARED_PRICING_ENV]: windowedDeclaration() },
        Date.parse("2026-06-01T00:00:00.000Z"),
      ),
    ).toBe(1_000_000);
  });

  it("R0-F5-B: a declaration whose validity window has LAPSED must not price the relay", () => {
    // F6 REFRESH: expressed on the v2 WINDOWED shape, which is the only shape
    // that can carry a window at all. The old call put `issuedAt`/`expiresAt` on
    // the LEGACY shape, where they are `unknown_field` — so it "passed" on a
    // parse error rather than on the expiry rule. This pins the expiry rule.
    const raw = windowedDeclaration({
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-02T00:00:00.000Z",
    });
    expect(parseDeclaredPricingStrict(raw).ok).toBe(true);
    expect(
      resolveDeclaredUsdMicrosPerCall(
        { modelId: RELAY_MODEL, endpointBaseUrl: RELAY },
        { [DECLARED_PRICING_ENV]: raw },
        Date.parse("2026-06-01T00:00:00.000Z"),
      ),
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

  it("R0-F5-D: resolveUsdMicrosPerCall must read the env it was HANDED, not process.env", () => {
    // F6 REFRESH: the env-source contract is asserted on the v2 WINDOWED shape,
    // which is the one that is execution-eligible. The legacy shape is refused
    // for a DIFFERENT reason (no window/coverage), so it could no longer
    // distinguish "read the wrong env" from "not executable" — using it here
    // would have made this test pass for the wrong reason.
    const raw = windowedDeclaration();
    const withEnv = resolveUsdMicrosPerCall as unknown as EnvAwareResolve;
    const query = { modelId: RELAY_MODEL, endpointBaseUrl: RELAY };
    const nowMs = Date.parse("2026-06-01T00:00:00.000Z");

    // Minimal input 1: the declaration exists ONLY in the injected env.
    delete process.env[DECLARED_PRICING_ENV];
    // TARGET: the injected env is the source of truth (plan §R4 #1).
    expect(withEnv(REAL_PROVIDER_ID, query, { [DECLARED_PRICING_ENV]: raw }, nowMs)).toBe(1_000_000);

    // Minimal input 2: the declaration exists ONLY in the global env.
    process.env[DECLARED_PRICING_ENV] = raw;
    // TARGET: a call handed an EMPTY env must not be priced by process.env.
    expect(withEnv(REAL_PROVIDER_ID, query, {}, nowMs)).toBeNull();
    // ...and the legacy shape is refused on the injected env too (F6).
    expect(withEnv(REAL_PROVIDER_ID, query, { [DECLARED_PRICING_ENV]: declaration() }, nowMs)).toBeNull();
  });

  it("R0-F5-E: observeExecutionIdentity(env) must not price from a DIFFERENT process.env declaration", () => {
    // F6 REFRESH: the injected/global conflict is asserted on the v2 WINDOWED
    // shape (execution-eligible), with the SAME amount in both envs so the only
    // thing under test is WHICH ENV was read. The legacy shape is refused for
    // its own reason and can no longer isolate this defect.
    const nowMs = Date.parse("2026-06-01T00:00:00.000Z");
    const injected = {
      OPENAI_API_KEY: FAKE_KEY,
      OPENAI_MODEL: RELAY_MODEL,
      OPENAI_BASE_URL: RELAY,
      [DECLARED_PRICING_ENV]: windowedDeclaration({ source: "injected env declaration" }),
    } as NodeJS.ProcessEnv;
    // The GLOBAL env names a DIFFERENT endpoint + model + source. If the observer
    // read the global declaration it could not price the injected endpoint at all.
    process.env[DECLARED_PRICING_ENV] = windowedDeclaration({
      baseUrl: "http://127.0.0.1:45998/v1",
      source: "decoy global declaration",
      ceilingByModel: { "decoy-global-model": 99_000_000 },
    });
    process.env["OPENAI_MODEL"] = "decoy-global-model";
    process.env["OPENAI_BASE_URL"] = "http://127.0.0.1:45998/v1";

    try {
      const observed = observeExecutionIdentity(REPO_ROOT, injected);
      // TARGET: the observed price comes from the env that was handed in.
      // This is the production call site: `formalExecutionProfile(env)` and
      // `env["R97_ARM_*"]` use `injected`, but the price silently uses the global.
      expect(observed.usdMicrosPerCall).toBe(1_000_000);
      expect(observed.modelId).toBe(RELAY_MODEL);
      expect(observed.pricingSourceKind).toBe("operator_declared");
      // F6: the observed basis is EXECUTION-ELIGIBLE, so it carries a digest the
      // pre-registration can bind (a non-executable price binds none).
      expect(observed.pricingDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      delete process.env["OPENAI_MODEL"];
      delete process.env["OPENAI_BASE_URL"];
    }
    void nowMs;
  });
});
