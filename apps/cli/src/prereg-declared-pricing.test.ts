import { describe, expect, it, afterEach } from "vitest";
import {
  DECLARED_PRICING_ENV,
  PRICING_SNAPSHOT_V1,
  detectPricingDrift,
  describePricingInspection,
  findDuplicateJsonKey,
  normalizeEndpointBaseUrl,
  parseDeclaredPricing,
  parseDeclaredPricingStrict,
  pricingSnapshotValid,
  redactEndpointForDisplay,
  resolveDeclaredUsdMicrosPerCall,
  resolvePricingBasis,
  resolveUsdMicrosPerCall,
  SUPPORTED_PRICING_CURRENCY,
  type PricingRejection,
} from "./prereg-execution-identity.js";
import { DEFAULT_REAL_MODEL_ID, REAL_PROVIDER_ID, STUB_PROVIDER_ID } from "./provider.js";

/**
 * The relay/model that was actually refused in this session. It is the concrete
 * case the declaration mechanism exists for: a loopback relay with a non-empty
 * base URL and a model id the first-party snapshot does not list.
 */
const RELAY = "http://127.0.0.1:8317/v1";
const RELAY_MODEL = "workbuddy-deepseek-v4.1-flash";

const ORIGINAL = process.env[DECLARED_PRICING_ENV];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[DECLARED_PRICING_ENV];
  else process.env[DECLARED_PRICING_ENV] = ORIGINAL;
});

function declaration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    baseUrl: RELAY,
    source: "operator-declared rate for the local relay (test)",
    boundByModel: { [RELAY_MODEL]: 1_000_000 },
    ...overrides,
  });
}

describe("E4-N8 pricing gate: an OPERATOR DECLARATION prices a relay, nothing else does", () => {
  it("WITHOUT a declaration the relay is still refused (the refusal is not weakened)", () => {
    delete process.env[DECLARED_PRICING_ENV];
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY })).toBeNull();
    // ...and so is an unlisted model on the first-party endpoint.
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: "not-in-snapshot" })).toBeNull();
  });

  it("WITH a declaration the relay resolves to the DECLARED bound", () => {
    process.env[DECLARED_PRICING_ENV] = declaration();
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY })).toBe(1_000_000);
  });

  it("the first-party snapshot is unchanged and the stub is still a genuine 0", () => {
    process.env[DECLARED_PRICING_ENV] = declaration();
    expect(resolveUsdMicrosPerCall(STUB_PROVIDER_ID)).toBe(0);
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: DEFAULT_REAL_MODEL_ID })).toBe(
      PRICING_SNAPSHOT_V1.requestBoundByModel[DEFAULT_REAL_MODEL_ID],
    );
    expect(pricingSnapshotValid()).toBe(true);
  });

  it("a declaration covers EXACTLY the endpoint it names", () => {
    process.env[DECLARED_PRICING_ENV] = declaration();
    // A different relay must not inherit the rate.
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: "http://127.0.0.1:9999/v1" })).toBeNull();
    // R4/F5 CHANGE: a trailing-slash variant IS the same endpoint. The real
    // transport strips trailing slashes (`baseUrl.replace(/\/+$/,"")` in
    // packages/model/src/openai.ts) before fetching `${baseUrl}/chat/completions`,
    // so `…/v1/` and `…/v1` are the SAME endpoint and must resolve to the SAME
    // rate. The old expectation (null) encoded the defect R4 fixes: a declaration
    // written the way a URL is usually printed silently did not cover the run.
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: `${RELAY}/` })).toBe(1_000_000);
    expect(normalizeEndpointBaseUrl(`${RELAY}///`)).toBe(RELAY);
    expect(normalizeEndpointBaseUrl("")).toBeNull();
    expect(normalizeEndpointBaseUrl(null)).toBeNull();
    // The first-party endpoint ("" / absent) is not covered by a relay declaration.
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL })).toBeNull();
  });

  it("a declaration covers EXACTLY the models it names", () => {
    process.env[DECLARED_PRICING_ENV] = declaration();
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: "some-other-model", endpointBaseUrl: RELAY })).toBeNull();
  });

  it("an untraceable, malformed or non-bounding declaration is REJECTED, never treated as a rate", () => {
    const cases: Array<[string, string]> = [
      ["no source", declaration({ source: "" })],
      ["missing source", JSON.stringify({ baseUrl: RELAY, boundByModel: { [RELAY_MODEL]: 1_000_000 } })],
      ["malformed json", "{not json"],
      ["no bounds", JSON.stringify({ baseUrl: RELAY, source: "x" })],
      ["empty bounds", JSON.stringify({ baseUrl: RELAY, source: "x", boundByModel: {} })],
      ["zero bound", declaration({ boundByModel: { [RELAY_MODEL]: 0 } })],
      ["negative bound", declaration({ boundByModel: { [RELAY_MODEL]: -5 } })],
      ["non-integer bound", declaration({ boundByModel: { [RELAY_MODEL]: 1.5 } })],
      ["string bound", declaration({ boundByModel: { [RELAY_MODEL]: "1000000" } })],
      ["array", JSON.stringify([RELAY])],
    ];
    for (const [label, raw] of cases) {
      expect(parseDeclaredPricing(raw), label).toBeNull();
      expect(resolveDeclaredUsdMicrosPerCall({ modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, { [DECLARED_PRICING_ENV]: raw }), label).toBeNull();
    }
    // An absent/blank variable is the normal case and must stay a refusal.
    expect(parseDeclaredPricing(undefined)).toBeNull();
    expect(parseDeclaredPricing("")).toBeNull();
    expect(parseDeclaredPricing("   ")).toBeNull();
  });

  it("a declaration is honoured even when the first-party snapshot window has lapsed", () => {
    // The declaration is an operator statement about an endpoint the snapshot
    // never covered, so the snapshot's own expiry must not silently void it.
    // (`resolveUsdMicrosPerCall` reads the real clock, so the lapsed-window fact
    // is asserted on `pricingSnapshotValid` directly rather than faked here.)
    const raw = declaration();
    expect(
      resolveDeclaredUsdMicrosPerCall({ modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, { [DECLARED_PRICING_ENV]: raw }),
    ).toBe(1_000_000);
    expect(pricingSnapshotValid(PRICING_SNAPSHOT_V1.invalidatedAtMs + 1)).toBe(false);
    // The declaration is checked BEFORE the snapshot window, which is what keeps
    // it usable past the snapshot's expiry.
    process.env[DECLARED_PRICING_ENV] = raw;
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY })).toBe(1_000_000);
  });
});

/* ── R4 / F5 (task-6) ─────────────────────────────────────────────────────── */

/** A deterministic instant inside the fixture declaration's validity window. */
const FIXED_NOW = Date.parse("2026-09-15T00:00:00.000Z");

/** The v2 declaration mode: source level, window, currency and coverage. */
function v2Declaration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "prereg-pricing-v2",
    sourceKind: "operator_declared",
    source: "operator-declared ceiling for the local relay (test fixture, not an invoice)",
    baseUrl: RELAY,
    currency: "USD",
    issuedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    coveredTokenCeiling: 32_000,
    ceilingByModel: { [RELAY_MODEL]: 1_000_000 },
    ...overrides,
  });
}

const envWith = (raw: string | undefined): Record<string, string | undefined> =>
  raw === undefined ? {} : { [DECLARED_PRICING_ENV]: raw };

const reject = (raw: string | undefined | null): PricingRejection => {
  const parsed = parseDeclaredPricingStrict(raw);
  if (parsed.ok) throw new Error("expected a rejection");
  return parsed;
};

describe("R4/F5 strict declaration schema: every rejection has a DISTINCT, stable reason", () => {
  const table: Array<[string, string | undefined, string]> = [
    ["absent variable", undefined, "absent"],
    ["malformed json", "{not json", "malformed_json"],
    ["duplicate key", '{"baseUrl":"a","source":"s","baseUrl":"b","boundByModel":{"m":1}}', "duplicate_key"],
    ["array instead of object", "[1,2]", "not_an_object"],
    ["unknown field (legacy)", declaration({ extra: 1 }), "unknown_field"],
    ["unknown field (v2)", v2Declaration({ extra: 1 }), "unknown_field"],
    ["unknown nested field", v2Declaration({ rates: { input: 1, output: 1, extra: 1 } }), "unknown_field"],
    ["unsupported schema string", v2Declaration({ schema: "prereg-pricing-v3" }), "unknown_field"],
    ["missing baseUrl", JSON.stringify({ source: "s", boundByModel: { m: 1 } }), "missing_base_url"],
    ["empty baseUrl", declaration({ baseUrl: "" }), "missing_base_url"],
    ["empty source", declaration({ source: "  " }), "empty_source"],
    ["zero bound", declaration({ boundByModel: { [RELAY_MODEL]: 0 } }), "illegal_numeric"],
    ["one bad entry poisons the whole map", declaration({ boundByModel: { [RELAY_MODEL]: 1_000_000, other: -1 } }), "illegal_numeric"],
    ["empty bounds", JSON.stringify({ baseUrl: RELAY, source: "x", boundByModel: {} }), "empty_bounds"],
    ["empty model id", declaration({ boundByModel: { "": 1_000_000 } }), "missing_field"],
    ["self-declared provider_verified", v2Declaration({ sourceKind: "provider_verified" }), "self_declared_provider_verified"],
    ["different currency", v2Declaration({ currency: "EUR" }), "unsupported_currency"],
    ["missing issuedAt", v2Declaration({ issuedAt: undefined }), "missing_field"],
    ["non-advancing window", v2Declaration({ expiresAt: "2026-09-01T00:00:00.000Z" }), "invalid_validity_window"],
    ["unparseable window", v2Declaration({ expiresAt: "whenever" }), "invalid_validity_window"],
    ["zero coveredTokenCeiling", v2Declaration({ coveredTokenCeiling: 0 }), "illegal_numeric"],
    ["fractional rate", v2Declaration({ rates: { input: 1.5, output: 2 }, ceilingByModel: undefined }), "illegal_numeric"],
    ["no bounding value at all", v2Declaration({ ceilingByModel: undefined, rates: undefined }), "empty_bounds"],
  ];

  for (const [label, raw, reason] of table) {
    it(`rejects ${label} as ${reason}`, () => {
      expect(reject(raw).reason, label).toBe(reason);
      // A PRESENT but invalid declaration never falls through to the rate card:
      // that would price the endpoint on a basis the operator did not declare.
      const resolved = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, envWith(raw), FIXED_NOW);
      if (reason === "absent") {
        expect(resolved.ok, label).toBe(false);
      } else {
        expect(resolved.ok, label).toBe(false);
        if (!resolved.ok) expect(resolved.reason, label).toBe(reason);
      }
      // Never labelled provider_verified, whatever the string said.
      expect(resolved.ok && resolved.basis.sourceKind === "provider_verified", label).toBe(false);
    });
  }

  it("counts object keys correctly (nested, escaped and array strings)", () => {
    expect(findDuplicateJsonKey('{"a":1,"a":2}')).toBe("a");
    expect(findDuplicateJsonKey('{"o":{"x":1,"x":2}}')).toBe("x");
    // A string inside an ARRAY is a value, never a key.
    expect(findDuplicateJsonKey('{"a":[1,2,3]}')).toBeNull();
    // Escaped forms of the SAME key are a duplicate (JSON.parse decodes them).
    expect(findDuplicateJsonKey('{"a":1,"\\u0061":2}')).toBe("a");
    expect(findDuplicateJsonKey(v2Declaration())).toBeNull();
  });
});

describe("R4/F5 validity window and token coverage", () => {
  it("accepts a windowed declaration inside its window and labels it a conservative bound", () => {
    const resolved = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, envWith(v2Declaration()), FIXED_NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.basis.sourceKind).toBe("operator_declared");
    expect(resolved.basis.isConservativeUpperBound).toBe(true);
    expect(resolved.basis.validity.kind).toBe("windowed");
    expect(resolved.basis.coverage.coveredTokenCeiling).toBe(32_000);
    expect(resolved.basis.currency).toBe(SUPPORTED_PRICING_CURRENCY);
    expect(resolved.basis.envSource).toBe("injected");
  });

  it("refuses an EXPIRED declaration with an explicit reason", () => {
    const afterExpiry = Date.parse("2026-11-01T00:00:00.000Z");
    const resolved = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, envWith(v2Declaration()), afterExpiry);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("expired");
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, envWith(v2Declaration()), afterExpiry)).toBeNull();
  });

  it("refuses a NOT-YET-VALID declaration", () => {
    const beforeIssue = Date.parse("2026-08-01T00:00:00.000Z");
    const resolved = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, envWith(v2Declaration()), beforeIssue);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe("not_yet_valid");
  });

  it("refuses a declaration too small to cover the request's token ceiling", () => {
    const resolved = resolvePricingBasis(
      REAL_PROVIDER_ID,
      { modelId: RELAY_MODEL, endpointBaseUrl: RELAY, requiredTokenCeiling: 40_000 },
      envWith(v2Declaration()),
      FIXED_NOW,
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe("insufficient_token_coverage");
    // ...and accepts it when the request fits.
    const fitting = resolvePricingBasis(
      REAL_PROVIDER_ID,
      { modelId: RELAY_MODEL, endpointBaseUrl: RELAY, requiredTokenCeiling: 32_000 },
      envWith(v2Declaration()),
      FIXED_NOW,
    );
    expect(fitting.ok).toBe(true);
  });

  it("derives a conservative per-call bound from per-class rates when no explicit ceiling is given", () => {
    // 50 µUSD per 1M tokens (max of input/output) over 1,000,000 covered tokens.
    const raw = v2Declaration({
      ceilingByModel: undefined,
      rates: { input: 40, output: 50 },
      coveredTokenCeiling: 1_000_000,
    });
    const resolved = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, envWith(raw), FIXED_NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.basis.usdMicrosPerCall).toBe(50);
    expect(resolved.basis.coverage.perClassRates).toEqual({ input: 40, output: 50 });
  });

  it("keeps the legacy shape usable but labels it operator_declared with no expiry claim", () => {
    const parsed = parseDeclaredPricing(declaration());
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("legacy_ephemeral");
    expect(parsed!.sourceKind).toBe("operator_declared");
    expect(parsed!.coveredTokenCeiling).toBeNull();
    expect(parsed!.issuedAt).toBeNull();
    expect(parsed!.digest).toMatch(/^[0-9a-f]{64}$/);
    // A non-empty `source` string is NOT proof of a price: the level stays
    // operator_declared, and it can never be provider_verified.
    const resolved = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, envWith(declaration()), FIXED_NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.basis.sourceKind).toBe("operator_declared");
    expect(resolved.basis.isConservativeUpperBound).toBe(true);
  });
});

describe("R4/F5 two fixed environments never cross-contaminate", () => {
  const RELAY_B = "http://127.0.0.1:9999/v1";
  const MODEL_B = "another-relay-model";
  const ENV_A: Record<string, string | undefined> = {
    OPENAI_API_KEY: "fixture-key-a",
    OPENAI_BASE_URL: RELAY,
    OPENAI_MODEL: RELAY_MODEL,
    [DECLARED_PRICING_ENV]: v2Declaration(),
  };
  const ENV_B: Record<string, string | undefined> = {
    OPENAI_API_KEY: "fixture-key-b",
    OPENAI_BASE_URL: RELAY_B,
    OPENAI_MODEL: MODEL_B,
    [DECLARED_PRICING_ENV]: v2Declaration({
      baseUrl: RELAY_B,
      ceilingByModel: { [MODEL_B]: 2_000_000 },
      source: "fixture B declaration",
    }),
  };

  it("resolves each env to its OWN price, endpoint and model", () => {
    const a = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, ENV_A, FIXED_NOW);
    const b = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: MODEL_B, endpointBaseUrl: RELAY_B }, ENV_B, FIXED_NOW);
    expect(a.ok && a.basis.usdMicrosPerCall).toBe(1_000_000);
    expect(b.ok && b.basis.usdMicrosPerCall).toBe(2_000_000);
    if (a.ok && b.ok) {
      expect(a.basis.endpointBaseUrl).toBe(RELAY);
      expect(b.basis.endpointBaseUrl).toBe(RELAY_B);
      expect(a.basis.modelId).toBe(RELAY_MODEL);
      expect(b.basis.modelId).toBe(MODEL_B);
      expect(a.basis.pricingDigest).not.toBe(b.basis.pricingDigest);
    }
  });

  it("does not lend env A's declaration to env B's query, or vice versa", () => {
    // Query A against env B: the env-B declaration names a different endpoint.
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, ENV_B, FIXED_NOW)).toBeNull();
    // Query B against env A: same, in the other direction.
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: MODEL_B, endpointBaseUrl: RELAY_B }, ENV_A, FIXED_NOW)).toBeNull();
  });

  it("never reads the GLOBAL declaration when an env is injected (the F5 defect)", () => {
    // A decoy in the process environment that must be ignored, and whose
    // presence would otherwise change the price.
    process.env[DECLARED_PRICING_ENV] = v2Declaration({
      baseUrl: RELAY_B,
      ceilingByModel: { [MODEL_B]: 7_777_777 },
      source: "decoy in the process env",
    });
    const injected = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, ENV_A, FIXED_NOW);
    expect(injected.ok).toBe(true);
    if (injected.ok) {
      expect(injected.basis.usdMicrosPerCall).toBe(1_000_000);
      expect(injected.basis.source).toContain("fixture");
      expect(injected.basis.endpointBaseUrl).toBe(RELAY);
      expect(injected.basis.envSource).toBe("injected");
    }
    // Positive control: the decoy IS honoured when it is the env that was passed
    // explicitly, so the assertion above proves the resolver ignored it rather
    // than that the decoy was unreadable.
    const decoy = resolvePricingBasis(
      REAL_PROVIDER_ID,
      { modelId: MODEL_B, endpointBaseUrl: RELAY_B },
      { [DECLARED_PRICING_ENV]: process.env[DECLARED_PRICING_ENV] },
      FIXED_NOW,
    );
    expect(decoy.ok && decoy.basis.usdMicrosPerCall).toBe(7_777_777);
    // The wrapper records WHERE its env came from, so a legacy call that DOES
    // read the process env is visible rather than silent.
    const legacyShape = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, ENV_A, FIXED_NOW, "process_env");
    expect(legacyShape.ok && legacyShape.basis.envSource).toBe("process_env");
  });

  it("keeps the provider/model identity of each env separate too", () => {
    // The unit of the F5 defect is the identity as a whole; assert the env the
    // pricing resolver is given is the one the identity resolution used.
    const a = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: ENV_A["OPENAI_MODEL"], endpointBaseUrl: ENV_A["OPENAI_BASE_URL"] }, ENV_A, FIXED_NOW);
    const b = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: ENV_B["OPENAI_MODEL"], endpointBaseUrl: ENV_B["OPENAI_BASE_URL"] }, ENV_B, FIXED_NOW);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect([a.basis.modelId, a.basis.endpointBaseUrl]).toEqual([RELAY_MODEL, RELAY]);
      expect([b.basis.modelId, b.basis.endpointBaseUrl]).toEqual([MODEL_B, RELAY_B]);
    }
  });
});

describe("R4/F5 the canonical pricingDigest binds the WHOLE basis", () => {
  const query = { modelId: RELAY_MODEL, endpointBaseUrl: RELAY };
  const digestOf = (raw: string): string => {
    const resolved = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(raw), FIXED_NOW);
    if (!resolved.ok) throw new Error(`expected a basis, got ${resolved.reason}`);
    return resolved.basis.pricingDigest;
  };

  it("is a stable 64-hex digest for the same basis", () => {
    const a = digestOf(v2Declaration());
    const b = digestOf(v2Declaration());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of WHEN the basis was checked", () => {
    const early = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(v2Declaration()), Date.parse("2026-09-02T00:00:00.000Z"));
    const late = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(v2Declaration()), Date.parse("2026-09-30T00:00:00.000Z"));
    expect(early.ok && late.ok).toBe(true);
    if (early.ok && late.ok) {
      expect(early.basis.validity.checkedAtMs).not.toBe(late.basis.validity.checkedAtMs);
      expect(early.basis.pricingDigest).toBe(late.basis.pricingDigest);
    }
  });

  it("changes when the AMOUNT changes", () => {
    expect(digestOf(v2Declaration({ ceilingByModel: { [RELAY_MODEL]: 1_000_001 } }))).not.toBe(digestOf(v2Declaration()));
  });

  it("changes when the SOURCE changes (the same amount is a different basis)", () => {
    expect(digestOf(v2Declaration({ source: "a different rate source" }))).not.toBe(digestOf(v2Declaration()));
  });

  it("changes when the declared endpoint changes", () => {
    const otherRelay = "http://127.0.0.1:9999/v1";
    const other = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: otherRelay }, envWith(v2Declaration({ baseUrl: otherRelay })), FIXED_NOW);
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.basis.pricingDigest).not.toBe(digestOf(v2Declaration()));
  });

  it("changes when the MODEL changes", () => {
    const perModel = v2Declaration({ ceilingByModel: { [RELAY_MODEL]: 1_000_000, other: 1_000_000 } });
    const forRelay = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(perModel), FIXED_NOW);
    const forOther = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: "other", endpointBaseUrl: RELAY }, envWith(perModel), FIXED_NOW);
    expect(forRelay.ok && forOther.ok).toBe(true);
    if (forRelay.ok && forOther.ok) expect(forRelay.basis.pricingDigest).not.toBe(forOther.basis.pricingDigest);
  });

  it("changes when the VALIDITY window changes", () => {
    expect(digestOf(v2Declaration({ expiresAt: "2026-09-20T00:00:00.000Z" }))).not.toBe(digestOf(v2Declaration()));
    expect(digestOf(v2Declaration({ issuedAt: "2026-09-02T00:00:00.000Z" }))).not.toBe(digestOf(v2Declaration()));
  });

  it("changes when the COVERAGE ceiling changes", () => {
    expect(digestOf(v2Declaration({ coveredTokenCeiling: 32_001 }))).not.toBe(digestOf(v2Declaration()));
  });

  it("changes when the declaration MODE changes, even at the same amount", () => {
    // legacy (unspecified validity) vs v2 (windowed) at the same 1_000_000 µUSD.
    expect(digestOf(declaration())).not.toBe(digestOf(v2Declaration()));
  });

  it("binds the currency", () => {
    const parsed = parseDeclaredPricingStrict(v2Declaration());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.currency).toBe(SUPPORTED_PRICING_CURRENCY);
  });
});

describe("R4/F5 the pricing drift detector", () => {
  const query = { modelId: RELAY_MODEL, endpointBaseUrl: RELAY };
  const resolveNow = (raw: string | undefined, nowMs = FIXED_NOW) =>
    resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(raw), nowMs);

  it("reports NONE when the bound digest still matches", () => {
    const current = resolveNow(v2Declaration());
    const bound = current.ok ? current.basis.pricingDigest : "";
    const drift = detectPricingDrift(bound, current);
    expect(drift.drifted).toBe(false);
    expect(drift.code).toBe("NONE");
    expect(drift.observedPricingDigest).toBe(bound);
  });

  it("reports PRICING_DIGEST_DRIFT when the declaration changes after the build", () => {
    const built = resolveNow(v2Declaration());
    const bound = built.ok ? built.basis.pricingDigest : "";
    // Same AMOUNT, different source: `maxUsdMicros` alone would not notice.
    const changed = resolveNow(v2Declaration({ source: "swapped rate source" }));
    const drift = detectPricingDrift(bound, changed);
    expect(drift.drifted).toBe(true);
    expect(drift.code).toBe("PRICING_DIGEST_DRIFT");
    expect(drift.boundPricingDigest).toBe(bound);
    expect(drift.observedPricingDigest).not.toBe(bound);

    // Same amount AND same source, different validity window: still drift.
    const windowSwapped = resolveNow(v2Declaration({ expiresAt: "2026-09-25T00:00:00.000Z" }));
    expect(detectPricingDrift(bound, windowSwapped).code).toBe("PRICING_DIGEST_DRIFT");

    // Same amount AND same source AND same window, different AMOUNT: still drift.
    const amountSwapped = resolveNow(v2Declaration({ ceilingByModel: { [RELAY_MODEL]: 1_500_000 } }));
    expect(detectPricingDrift(bound, amountSwapped).code).toBe("PRICING_DIGEST_DRIFT");
  });

  it("reports PRICING_UNKNOWN (providerFactory = 0) when the run cannot be priced", () => {
    const built = resolveNow(v2Declaration());
    const bound = built.ok ? built.basis.pricingDigest : "";
    // The declaration disappears before the resume.
    const missing = detectPricingDrift(bound, resolveNow(undefined));
    expect(missing.drifted).toBe(true);
    expect(missing.code).toBe("PRICING_UNKNOWN");
    expect(missing.observedPricingDigest).toBeNull();
    // The declaration expired before the resume: the basis is unpriceable too.
    const expired = detectPricingDrift(bound, resolveNow(v2Declaration(), Date.parse("2026-11-01T00:00:00.000Z")));
    expect(expired.code).toBe("PRICING_UNKNOWN");
  });

  it("reports PRICING_UNKNOWN when nothing was bound", () => {
    const current = resolveNow(v2Declaration());
    expect(detectPricingDrift(null, current).code).toBe("PRICING_UNKNOWN");
    expect(detectPricingDrift("", current).code).toBe("PRICING_UNKNOWN");
  });
});

describe("R4/F5 the default (provider rate card) snapshot obeys the same rules", () => {
  const query = { modelId: DEFAULT_REAL_MODEL_ID };

  it("is labelled provider_verified with a currency and a window, never a declared bound", () => {
    const resolved = resolvePricingBasis(REAL_PROVIDER_ID, query, {}, FIXED_NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.basis.basisKind).toBe("provider_verified");
    expect(resolved.basis.sourceKind).toBe("provider_verified");
    expect(resolved.basis.isConservativeUpperBound).toBe(false);
    expect(resolved.basis.currency).toBe(SUPPORTED_PRICING_CURRENCY);
    expect(resolved.basis.validity.kind).toBe("snapshot");
    expect(resolved.basis.coverage.coveredTokenCeiling).toBe(PRICING_SNAPSHOT_V1.coveredTokenCeiling);
  });

  it("marks the run unknown (never 0) once the window has lapsed or the source does not review", () => {
    const lapsed = resolvePricingBasis(REAL_PROVIDER_ID, query, {}, PRICING_SNAPSHOT_V1.invalidatedAtMs + 1);
    expect(lapsed.ok).toBe(false);
    if (!lapsed.ok) expect(lapsed.reason).toBe("snapshot_expired");
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, query, {}, PRICING_SNAPSHOT_V1.invalidatedAtMs + 1)).toBeNull();

    const proxy = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: DEFAULT_REAL_MODEL_ID, endpointBaseUrl: RELAY }, {}, FIXED_NOW);
    expect(proxy.ok).toBe(false);
    if (!proxy.ok) expect(proxy.reason).toBe("endpoint_mismatch");

    const unlisted = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: "not-in-snapshot" }, {}, FIXED_NOW);
    expect(unlisted.ok).toBe(false);
    if (!unlisted.ok) expect(unlisted.reason).toBe("model_not_declared");

    const oversized = resolvePricingBasis(
      REAL_PROVIDER_ID,
      { modelId: DEFAULT_REAL_MODEL_ID, requiredTokenCeiling: PRICING_SNAPSHOT_V1.coveredTokenCeiling + 1 },
      {},
      FIXED_NOW,
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.reason).toBe("insufficient_token_coverage");
  });

  it("still gives the unbilled stub a genuine 0 without inventing a declared basis", () => {
    const stub = resolvePricingBasis(STUB_PROVIDER_ID, {}, {}, FIXED_NOW);
    expect(stub.ok).toBe(true);
    if (!stub.ok) return;
    expect(stub.basis.usdMicrosPerCall).toBe(0);
    expect(stub.basis.basisKind).toBe("unbilled_stub");
    expect(stub.basis.sourceKind).toBeNull();
    expect(stub.basis.currency).toBe(SUPPORTED_PRICING_CURRENCY);
  });

  it("refuses an unknown provider rather than defaulting it", () => {
    const other = resolvePricingBasis("some-other-provider", {}, {}, FIXED_NOW);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toBe("provider_unknown");
  });
});

describe("R4/F5 read-only inspection: credentials redacted, budget SHOWN", () => {
  const SECRET = "sk-live-fixture-secret-123456";
  const CREDENTIALED_RELAY = `http://operator:${SECRET}@127.0.0.1:8317/v1?api_key=${SECRET}`;

  it("redacts credentials but shows the source level and the budget computation", () => {
    // The digest is bound to the SAME basis the inspection observes (endpoint
    // included), so this asserts the drift line rather than manufacturing one.
    const credentialedEnv = envWith(v2Declaration({ baseUrl: CREDENTIALED_RELAY }));
    const credentialedQuery = { modelId: RELAY_MODEL, endpointBaseUrl: CREDENTIALED_RELAY };
    const basis = resolvePricingBasis(REAL_PROVIDER_ID, credentialedQuery, credentialedEnv, FIXED_NOW);
    expect(basis.ok).toBe(true);
    if (!basis.ok) return;
    const lines = describePricingInspection({
      providerId: REAL_PROVIDER_ID,
      query: credentialedQuery,
      env: credentialedEnv,
      nowMs: FIXED_NOW,
      maxModelCalls: 20,
      boundPricingDigest: basis.basis.pricingDigest,
    });
    const text = lines.join("\n");
    // The source LEVEL is shown, and it is labelled as a bound, not an actual.
    expect(text).toContain("operator_declared");
    expect(text).toContain("CONSERVATIVE UPPER BOUND");
    // The budget computation is shown.
    expect(text).toContain("budget computation: 20 model calls");
    expect(text).toContain("20.000000 USD");
    // The digest and the drift verdict are shown.
    expect(text).toContain(`pricingDigest: ${basis.basis.pricingDigest}`);
    expect(text).toContain("pricing drift: NONE");
    // The actual cost is explicitly not observed.
    expect(text).toContain("actual provider cost: NOT_OBSERVED");
    // Credentials are gone.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("operator:");
    expect(text).toContain("<redacted>");
  });

  it("shows the refusal and provider calls 0 when there is no reviewable source", () => {
    const text = describePricingInspection({
      providerId: REAL_PROVIDER_ID,
      query: { modelId: RELAY_MODEL, endpointBaseUrl: RELAY },
      env: {},
      nowMs: FIXED_NOW,
      maxModelCalls: 20,
    }).join("\n");
    expect(text).toContain("pricing source level: NONE");
    expect(text).toContain("pricing rejection: endpoint_mismatch");
    expect(text).toContain("provider calls: 0");
    expect(text).toContain("actual provider cost: NOT_OBSERVED");
  });

  it("redacts userinfo and credential-shaped query parameters", () => {
    const redacted = redactEndpointForDisplay(CREDENTIALED_RELAY);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain("operator:");
    expect(redacted).toContain("127.0.0.1:8317");
    expect(redactEndpointForDisplay(null)).toBe("(provider default endpoint)");
  });
});
