import { describe, expect, it, afterEach } from "vitest";
import {
  DECLARED_PRICING_ENV,
  PRICING_SNAPSHOT_V1,
  parseDeclaredPricing,
  pricingSnapshotValid,
  resolveDeclaredUsdMicrosPerCall,
  resolveUsdMicrosPerCall,
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
    // A trailing-slash variant is a different endpoint string, so it is not covered.
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID, { modelId: RELAY_MODEL, endpointBaseUrl: `${RELAY}/` })).toBeNull();
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
