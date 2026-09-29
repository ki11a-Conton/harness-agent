import { describe, expect, it, afterEach } from "vitest";
import {
  DECLARED_PRICING_ENV,
  PRICING_SNAPSHOT_V1,
  decidePhysicalSend,
  detectPricingDrift,
  describePricingInspection,
  findDuplicateJsonKey,
  migrateLegacyDeclarationToV2,
  normalizeEndpointBaseUrl,
  parseDeclaredPricing,
  parseDeclaredPricingStrict,
  pricingExecutionEligibility,
  pricingSnapshotValid,
  redactEndpointForDisplay,
  resolveDeclaredUsdMicrosPerCall,
  resolveExecutionEnvironment,
  resolvePricingBasis,
  resolvePricingBasisReadOnly,
  resolveUsdMicrosPerCall,
  SUPPORTED_PRICING_CURRENCY,
  type PricingRejection,
} from "./prereg-execution-identity.js";
import { DEFAULT_REAL_MODEL_ID, REAL_PROVIDER_ID, STUB_PROVIDER_ID } from "./provider.js";
import { observeExecutionIdentity } from "./prereg-production-runner.js";
import { fileURLToPath } from "node:url";

/**
 * The relay/model that was actually refused in this session. It is the concrete
 * case the declaration mechanism exists for: a loopback relay with a non-empty
 * base URL and a model id the first-party snapshot does not list.
 */
const RELAY = "http://127.0.0.1:8317/v1";
const RELAY_MODEL = "workbuddy-deepseek-v4.1-flash";

/** The repository root, for the production observation call site. */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const ORIGINAL = process.env[DECLARED_PRICING_ENV];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[DECLARED_PRICING_ENV];
  else process.env[DECLARED_PRICING_ENV] = ORIGINAL;
});

/**
 * F6 — the HISTORICAL minimal shape: `{ baseUrl, source, boundByModel }`.
 *
 * It stays fully READABLE (parse / inspect / diagnose) and keeps its real
 * `legacy_ephemeral` + `operator_declared` labels, but it carries NO validity
 * window and NO covered token ceiling, so it has NO automatic execution
 * eligibility (plan(20260929-015956).md §9).
 */
function legacyDeclaration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    baseUrl: RELAY,
    source: "operator-declared rate for the local relay (test)",
    boundByModel: { [RELAY_MODEL]: 1_000_000 },
    ...overrides,
  });
}

/**
 * F6 — the EXECUTABLE declaration: the v2 windowed form. `expiresAt` is far
 * enough in the future that the REAL clock (used by the end-to-end call sites)
 * stays inside the window, so these cases test the contract, not the date.
 */
function relayDeclaration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "prereg-pricing-v2",
    sourceKind: "operator_declared",
    source: "operator-declared rate for the local relay (test)",
    baseUrl: RELAY,
    currency: "USD",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    coveredTokenCeiling: 64_000,
    ceilingByModel: { [RELAY_MODEL]: 1_000_000 },
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
    process.env[DECLARED_PRICING_ENV] = relayDeclaration();
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY })).toBe(1_000_000);
  });

  it("the first-party snapshot is unchanged and the stub is still a genuine 0", () => {
    process.env[DECLARED_PRICING_ENV] = relayDeclaration();
    expect(resolveUsdMicrosPerCall(STUB_PROVIDER_ID)).toBe(0);
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: DEFAULT_REAL_MODEL_ID })).toBe(
      PRICING_SNAPSHOT_V1.requestBoundByModel[DEFAULT_REAL_MODEL_ID],
    );
    expect(pricingSnapshotValid()).toBe(true);
  });

  it("a declaration covers EXACTLY the endpoint it names", () => {
    process.env[DECLARED_PRICING_ENV] = relayDeclaration();
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
    process.env[DECLARED_PRICING_ENV] = relayDeclaration();
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: "some-other-model", endpointBaseUrl: RELAY })).toBeNull();
  });

  it("an untraceable, malformed or non-bounding declaration is REJECTED, never treated as a rate", () => {
    const cases: Array<[string, string]> = [
      ["no source", legacyDeclaration({ source: "" })],
      ["missing source", JSON.stringify({ baseUrl: RELAY, boundByModel: { [RELAY_MODEL]: 1_000_000 } })],
      ["malformed json", "{not json"],
      ["no bounds", JSON.stringify({ baseUrl: RELAY, source: "x" })],
      ["empty bounds", JSON.stringify({ baseUrl: RELAY, source: "x", boundByModel: {} })],
      ["zero bound", legacyDeclaration({ boundByModel: { [RELAY_MODEL]: 0 } })],
      ["negative bound", legacyDeclaration({ boundByModel: { [RELAY_MODEL]: -5 } })],
      ["non-integer bound", legacyDeclaration({ boundByModel: { [RELAY_MODEL]: 1.5 } })],
      ["string bound", legacyDeclaration({ boundByModel: { [RELAY_MODEL]: "1000000" } })],
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
    const raw = relayDeclaration();
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
    ["unknown field (legacy)", legacyDeclaration({ extra: 1 }), "unknown_field"],
    ["unknown field (v2)", v2Declaration({ extra: 1 }), "unknown_field"],
    ["unknown nested field", v2Declaration({ rates: { input: 1, output: 1, extra: 1 } }), "unknown_field"],
    ["unsupported schema string", v2Declaration({ schema: "prereg-pricing-v3" }), "unknown_field"],
    ["missing baseUrl", JSON.stringify({ source: "s", boundByModel: { m: 1 } }), "missing_base_url"],
    ["empty baseUrl", legacyDeclaration({ baseUrl: "" }), "missing_base_url"],
    ["empty source", legacyDeclaration({ source: "  " }), "empty_source"],
    ["zero bound", legacyDeclaration({ boundByModel: { [RELAY_MODEL]: 0 } }), "illegal_numeric"],
    ["one bad entry poisons the whole map", legacyDeclaration({ boundByModel: { [RELAY_MODEL]: 1_000_000, other: -1 } }), "illegal_numeric"],
    ["empty bounds", JSON.stringify({ baseUrl: RELAY, source: "x", boundByModel: {} }), "empty_bounds"],
    ["empty model id", legacyDeclaration({ boundByModel: { "": 1_000_000 } }), "missing_field"],
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

  it("keeps the legacy shape READABLE and labelled, but gives it NO execution eligibility (F6)", () => {
    const parsed = parseDeclaredPricing(legacyDeclaration());
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("legacy_ephemeral");
    expect(parsed!.sourceKind).toBe("operator_declared");
    expect(parsed!.coveredTokenCeiling).toBeNull();
    expect(parsed!.issuedAt).toBeNull();
    expect(parsed!.digest).toMatch(/^[0-9a-f]{64}$/);
    // The read-only interpretation still EXPOSES the declared amount: legacy
    // information is not hidden by turning it into `null`.
    expect(parsed!.boundByModel[RELAY_MODEL]).toBe(1_000_000);
    // A non-empty `source` string is NOT proof of a price: the level stays
    // operator_declared, and it can never be provider_verified.
    //
    // F6: a legacy declaration has NO validity window and NO covered token
    // ceiling, so it must NOT authorize a new billed run or a resume. It is
    // refused with a stable migration reason instead of being silently priced.
    const resolved = resolvePricingBasis(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: RELAY }, envWith(legacyDeclaration()), FIXED_NOW);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("legacy_not_executable");
    expect(resolved.detail).toContain("prereg-pricing-v2");
  });
});

describe("R4/F6 legacy price is READABLE but has NO automatic execution eligibility", () => {
  const query = { modelId: RELAY_MODEL, endpointBaseUrl: RELAY };

  it("F6.1 keeps the legacy declaration fully readable (parse + labels + amount)", () => {
    const parsed = parseDeclaredPricingStrict(legacyDeclaration());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mode).toBe("legacy_ephemeral");
    expect(parsed.value.sourceKind).toBe("operator_declared");
    expect(parsed.value.boundByModel[RELAY_MODEL]).toBe(1_000_000);
    expect(parsed.value.coveredTokenCeiling).toBeNull();
    expect(parsed.value.perClassRates).toBeNull();
    expect(parsed.value.issuedAt).toBeNull();
    expect(parsed.value.expiresAt).toBeNull();
  });

  it("F6.2 REFUSES the legacy declaration for billed execution with a stable migration reason", () => {
    const resolved = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(legacyDeclaration()), FIXED_NOW);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("legacy_not_executable");
    // The reason names the migration target, so it is actionable rather than
    // merely "invalid".
    expect(resolved.detail).toContain("prereg-pricing-v2");
    // Every execution-facing numeric surface agrees: no price ⇒ the money-bounded
    // gate refuses PRICING_UNKNOWN and constructs no provider.
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, query, envWith(legacyDeclaration()), FIXED_NOW)).toBeNull();
    expect(resolveDeclaredUsdMicrosPerCall(query, envWith(legacyDeclaration()), FIXED_NOW)).toBeNull();
    // Parse and eligibility are SEPARATE questions: the read-only layer still
    // resolves the legacy basis (so it stays inspectable), and only the explicit
    // eligibility decision refuses it.
    const readOnly = resolvePricingBasisReadOnly(REAL_PROVIDER_ID, query, envWith(legacyDeclaration()), FIXED_NOW);
    expect(readOnly.ok).toBe(true);
    if (!readOnly.ok) return;
    expect(readOnly.basis.declarationMode).toBe("legacy_ephemeral");
    expect(readOnly.basis.usdMicrosPerCall).toBe(1_000_000);
    const eligibility = pricingExecutionEligibility(readOnly.basis, FIXED_NOW);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("legacy_not_executable");
    expect(eligibility.migrationNote).toContain("prereg-pricing-v2");
    // A windowed basis at the SAME amount IS eligible: the refusal is about the
    // missing window/coverage, not about the operator-declared level.
    const windowed = resolvePricingBasisReadOnly(REAL_PROVIDER_ID, query, envWith(relayDeclaration()), FIXED_NOW);
    expect(windowed.ok).toBe(true);
    if (windowed.ok) {
      const windowedEligibility = pricingExecutionEligibility(windowed.basis, FIXED_NOW);
      expect(windowedEligibility.eligible).toBe(true);
      expect(windowed.basis.sourceKind).toBe("operator_declared");
    }
  });

  it("F6.3 keeps legacy INSPECT/diagnose-visible: the declared amount and level are SHOWN, not hidden as NONE", () => {
    const text = describePricingInspection({
      providerId: REAL_PROVIDER_ID,
      query,
      env: envWith(legacyDeclaration()),
      nowMs: FIXED_NOW,
      maxModelCalls: 20,
    }).join("\n");
    // The legacy declaration is still reviewable: its real mode, level, amount
    // and endpoint are displayed.
    expect(text).toContain("legacy_ephemeral");
    expect(text).toContain("operator_declared");
    expect(text).toContain("1.000000 USD");
    expect(text).toContain(RELAY);
    // ...and the execution verdict is explicit rather than implied by silence.
    expect(text).toContain("legacy_not_executable");
    expect(text).toContain("execution eligibility");
    expect(text).toContain("prereg-pricing-v2");
    // The legacy basis is never upgraded to a provider-verified level.
    expect(text).not.toContain("provider_verified (provider-published rate card)");
  });

  it("F6.4 a COMPLETE, unexpired, sufficiently-covering v2 declaration still passes and keeps operator_declared", () => {
    const resolved = resolvePricingBasis(
      REAL_PROVIDER_ID,
      { ...query, requiredTokenCeiling: 64_000 },
      envWith(relayDeclaration()),
      FIXED_NOW,
    );
    expect(resolved.ok, resolved.ok ? "" : `${resolved.reason}: ${resolved.detail}`).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.basis.usdMicrosPerCall).toBe(1_000_000);
    expect(resolved.basis.sourceKind).toBe("operator_declared");
    expect(resolved.basis.isConservativeUpperBound).toBe(true);
    expect(resolved.basis.validity.kind).toBe("windowed");
    expect(resolved.basis.coverage.coveredTokenCeiling).toBe(64_000);
  });

  it("F6.5 refuses each v2 defect distinctly: missing validity, future-effective, expired, coverage shrink", () => {
    const missingValidity = resolvePricingBasis(
      REAL_PROVIDER_ID,
      query,
      envWith(relayDeclaration({ issuedAt: undefined, expiresAt: undefined })),
      FIXED_NOW,
    );
    expect(missingValidity.ok).toBe(false);
    if (!missingValidity.ok) expect(missingValidity.reason).toBe("missing_field");

    const future = resolvePricingBasis(
      REAL_PROVIDER_ID,
      query,
      envWith(relayDeclaration({ issuedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" })),
      FIXED_NOW,
    );
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.reason).toBe("not_yet_valid");

    const expired = resolvePricingBasis(
      REAL_PROVIDER_ID,
      query,
      envWith(relayDeclaration({ expiresAt: "2026-09-01T00:00:00.000Z" })),
      FIXED_NOW,
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toBe("expired");

    const shrunk = resolvePricingBasis(
      REAL_PROVIDER_ID,
      { ...query, requiredTokenCeiling: 64_001 },
      envWith(relayDeclaration()),
      FIXED_NOW,
    );
    expect(shrunk.ok).toBe(false);
    if (!shrunk.ok) expect(shrunk.reason).toBe("insufficient_token_coverage");
  });

  it("F6.6 the validity BOUNDARY is exact: eligible one millisecond before expiry, refused AT expiry", () => {
    const raw = relayDeclaration();
    const expiresMs = Date.parse("2099-01-01T00:00:00.000Z");
    const justBefore = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(raw), expiresMs - 1);
    expect(justBefore.ok).toBe(true);
    const atExpiry = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(raw), expiresMs);
    expect(atExpiry.ok).toBe(false);
    if (!atExpiry.ok) expect(atExpiry.reason).toBe("expired");
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, query, envWith(raw), expiresMs)).toBeNull();
  });

  it("F6.7 the legacy migration note is offline, explicit and never guesses a rate or a window", () => {
    // The migration helper is a pure converter: the operator supplies the window
    // and the coverage; the rates come from the legacy declaration UNCHANGED.
    // It never auto-fills "never expires" and never invents a rate.
    const migrated = migrateLegacyDeclarationToV2(legacyDeclaration(), {
      issuedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      coveredTokenCeiling: 64_000,
    });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.value.mode).toBe("v2_windowed");
    expect(migrated.value.sourceKind).toBe("operator_declared");
    expect(migrated.value.boundByModel[RELAY_MODEL]).toBe(1_000_000);
    expect(migrated.value.issuedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(migrated.value.expiresAt).toBe("2026-10-01T00:00:00.000Z");
    expect(migrated.value.coveredTokenCeiling).toBe(64_000);
    // The converted JSON is accepted by the strict parser and IS executable.
    const reparsed = parseDeclaredPricingStrict(migrated.json);
    expect(reparsed.ok).toBe(true);
    const executable = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(migrated.json), FIXED_NOW);
    expect(executable.ok).toBe(true);
    // Refusals: a missing/never-ending window is never invented for the operator.
    expect(migrateLegacyDeclarationToV2(legacyDeclaration(), { issuedAt: "", expiresAt: "", coveredTokenCeiling: 64_000 }).ok).toBe(false);
    expect(
      migrateLegacyDeclarationToV2(legacyDeclaration(), {
        issuedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "9999-12-31T00:00:00.000Z",
        coveredTokenCeiling: 64_000,
      }).ok,
    ).toBe(false);
    // ...and the legacy shape itself is not migrated twice / silently accepted.
    expect(migrateLegacyDeclarationToV2(relayDeclaration(), {
      issuedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      coveredTokenCeiling: 64_000,
    }).ok).toBe(false);
  });

  it("F6.8 the price expiry is folded into EVERY physical send and retry (nothing sent after expiry)", () => {
    const raw = relayDeclaration();
    const expiresMs = Date.parse("2099-01-01T00:00:00.000Z");
    const basis = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(raw), expiresMs - 1000);
    expect(basis.ok).toBe(true);
    if (!basis.ok) return;

    // Before the expiry a new physical send is allowed, at the bound price.
    const beforeSend = decidePhysicalSend({ basis: basis.basis, nowMs: expiresMs - 1, alreadySent: 0 });
    expect(beforeSend.allow).toBe(true);
    expect(beforeSend.settlementUsdMicrosPerCall).toBe(1_000_000);

    // At/after expiry the FIRST send is refused: nothing goes out.
    const afterExpiryFirst = decidePhysicalSend({ basis: basis.basis, nowMs: expiresMs, alreadySent: 0 });
    expect(afterExpiryFirst.allow).toBe(false);
    expect(afterExpiryFirst.reason).toBe("expired");
    expect(afterExpiryFirst.sentNothing).toBe(true);

    // A RETRY after expiry is refused too, and the ALREADY-SENT request settles
    // at the ORIGINAL reservation — no new price is invented.
    const retry = decidePhysicalSend({ basis: basis.basis, nowMs: expiresMs + 60_000, alreadySent: 1 });
    expect(retry.allow).toBe(false);
    expect(retry.reason).toBe("expired");
    expect(retry.settlesAtOriginalReservation).toBe(true);
    expect(retry.settlementUsdMicrosPerCall).toBe(1_000_000);
    expect(retry.detail).toContain("original reservation");
  });

  it("F6.10 the PRODUCTION observation binds no price for a legacy declaration (refused before the first request)", () => {
    // `observeExecutionIdentity` is the production call site whose output the
    // money-bounded gate consumes: `usdMicrosPerCall === null` + no
    // `pricingDigest` is exactly what makes `openPreregisteredCampaignGate`
    // refuse PRICING_UNKNOWN with 0 provider-factory calls. The fixture env is
    // entirely offline (an inert loopback STRING, an obviously fake key that is
    // never transmitted) and the endpoint is never contacted.
    const injected: Record<string, string | undefined> = {
      OPENAI_API_KEY: "f6-not-a-real-credential",
      OPENAI_MODEL: RELAY_MODEL,
      OPENAI_BASE_URL: RELAY,
      [DECLARED_PRICING_ENV]: legacyDeclaration(),
    };
    const observed = observeExecutionIdentity(REPO_ROOT, injected as NodeJS.ProcessEnv);
    expect(observed.usdMicrosPerCall).toBeNull();
    expect(observed.pricingDigest).toBeUndefined();
    expect(observed.pricingSourceKind).toBeNull();

    // The positive control: the SAME env with the v2 WINDOWED declaration DOES
    // bind a price and a digest, so the refusal above is about the missing
    // window/coverage and not about a broken fixture.
    const windowedObserved = observeExecutionIdentity(REPO_ROOT, {
      ...injected,
      [DECLARED_PRICING_ENV]: relayDeclaration(),
    } as NodeJS.ProcessEnv);
    expect(windowedObserved.usdMicrosPerCall).toBe(1_000_000);
    expect(windowedObserved.pricingDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(windowedObserved.pricingSourceKind).toBe("operator_declared");
  });

  it("F6.11 the parse/eligibility split is what keeps legacy readable: the refusal is NOT a parse failure", () => {
    // `parseDeclaredPricingStrict` still ACCEPTS the legacy shape (it is a
    // supported, labelled mode), and `parseDeclaredPricing` — the legacy
    // read-only view — still returns it. Only the EXECUTION decision refuses.
    expect(parseDeclaredPricing(legacyDeclaration())).not.toBeNull();
    expect(parseDeclaredPricingStrict(legacyDeclaration()).ok).toBe(true);
    const readOnly = resolvePricingBasisReadOnly(REAL_PROVIDER_ID, query, envWith(legacyDeclaration()), FIXED_NOW);
    expect(readOnly.ok).toBe(true);
    const executed = resolvePricingBasis(REAL_PROVIDER_ID, query, envWith(legacyDeclaration()), FIXED_NOW);
    expect(executed.ok).toBe(false);
    if (!executed.ok) expect(executed.reason).toBe("legacy_not_executable");
  });

  it("F6.9 the SAME injected env resolves the provider, the price AND the construction input", () => {
    const injected: Record<string, string | undefined> = {
      OPENAI_API_KEY: "fixture-key-a",
      OPENAI_MODEL: RELAY_MODEL,
      OPENAI_BASE_URL: RELAY,
      [DECLARED_PRICING_ENV]: relayDeclaration(),
    };
    // A conflicting GLOBAL env: a different endpoint, model, key and rate.
    const originalKey = process.env["OPENAI_API_KEY"];
    const originalModel = process.env["OPENAI_MODEL"];
    const originalBase = process.env["OPENAI_BASE_URL"];
    process.env["OPENAI_API_KEY"] = "decoy-global-key";
    process.env["OPENAI_MODEL"] = "decoy-global-model";
    process.env["OPENAI_BASE_URL"] = "http://127.0.0.1:9999/v1";
    process.env[DECLARED_PRICING_ENV] = relayDeclaration({
      baseUrl: "http://127.0.0.1:9999/v1",
      ceilingByModel: { "decoy-global-model": 7_777_777 },
    });
    try {
      const resolution = resolveExecutionEnvironment(injected, FIXED_NOW);
      // Observed provider identity comes from the INJECTED env.
      expect(resolution.provider.providerId).toBe(REAL_PROVIDER_ID);
      expect(resolution.provider.modelId).toBe(RELAY_MODEL);
      expect(resolution.provider.endpointBaseUrl).toBe(RELAY);
      // ...and so does the price, for exactly that provider/model/endpoint.
      expect(resolution.pricing.ok).toBe(true);
      if (!resolution.pricing.ok) return;
      expect(resolution.pricing.basis.usdMicrosPerCall).toBe(1_000_000);
      expect(resolution.pricing.basis.endpointBaseUrl).toBe(RELAY);
      expect(resolution.pricing.basis.modelId).toBe(RELAY_MODEL);
      // A's price cannot execute B's provider: the construction input is derived
      // from the SAME resolution, so the constructed provider IS the observed one.
      expect(resolution.priceMatchesProvider).toBe(true);
      expect(resolution.constructionInput).toEqual({
        apiKey: "fixture-key-a",
        baseUrl: RELAY,
        modelId: RELAY_MODEL,
      });
      // The decoy global values are never consulted.
      expect(resolution.constructionInput.apiKey).not.toBe("decoy-global-key");
      expect(resolution.constructionInput.modelId).not.toBe("decoy-global-model");
      expect(resolution.constructionInput.baseUrl).not.toBe("http://127.0.0.1:9999/v1");
    } finally {
      if (originalKey === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = originalKey;
      if (originalModel === undefined) delete process.env["OPENAI_MODEL"];
      else process.env["OPENAI_MODEL"] = originalModel;
      if (originalBase === undefined) delete process.env["OPENAI_BASE_URL"];
      else process.env["OPENAI_BASE_URL"] = originalBase;
    }
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
    // F6: the legacy basis has no execution eligibility, so it is compared
    // through the READ-ONLY interpretation (the declaration digest) rather than
    // through the execution resolver.
    const legacy = parseDeclaredPricingStrict(legacyDeclaration());
    const windowed = parseDeclaredPricingStrict(v2Declaration());
    expect(legacy.ok && windowed.ok).toBe(true);
    if (legacy.ok && windowed.ok) expect(legacy.value.digest).not.toBe(windowed.value.digest);
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
