/**
 * E4-R98 — the redaction contract of the campaign driver's failure text.
 *
 * MEASURED DEFECT (plan finding F6, plan `plan(20260919-091015).md` §0.1):
 * the driver's failure recording used to be a pass-through. `failureTextOf` only
 * collapsed whitespace and truncated to a fixed width, and the `catch` branch in
 * `runDriver` stored `err.message` DIRECTLY. A synthetic `Bearer <canary>` — and
 * any `sk-…` key the provider echoed back — therefore survived VERBATIM into the
 * persisted `driver-result.json`, its `failures[].error`, and the durable
 * execution state's `detail`. That is a release-integrity / secret-leak defect:
 * the artifact an operator attaches as evidence carried live-looking credentials.
 *
 * Plan §R98 adds `redactFailureText` and makes `failureTextOf` route through it,
 * with ONE ordering constraint that this file exists to lock in:
 *
 *   redaction happens BEFORE the length cap.
 *
 * The orders are not interchangeable. Truncate-then-redact leaves an un-redacted
 * prefix for a secret that follows the cut; redact-then-truncate can still expose
 * a secret whose head survives the cut. The implementation resolves this by
 * replacing the whole credential SHAPE with a marker first, so the cap can only
 * ever cut an already-safe string — a secret can never be half-printed.
 *
 * These tests are deliberately written against the PERSISTED-text contract, not
 * against an implementation detail: they assert on what `failureTextOf` RETURNS,
 * because that string is what lands in the artifact. Each `it` names the specific
 * leak it locks in, so a regression that reopens F6 fails here with a secret
 * visible in the diff.
 *
 * Scope note: the end-to-end "the driver never persists a canary" integration
 * test lives with the closed-loop driver suite and is NOT duplicated here. This
 * file covers the pure rendering contract plus the one env-assignment shape.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Loaded at module scope, exactly as `r97-driver-closed-loop.test.ts` does, so the
// driver is imported once by the module graph and never from inside a `describe`
// callback. The driver guards its CLI entry behind an `invokedDirectly` check, so
// importing it here has no side effects.
const DRIVER = pathToFileURL(join(process.cwd(), "scripts", "e4", "r97-campaign-driver.mjs")).href;

const mod = (await import(DRIVER)) as {
  failureTextOf: (value: unknown) => string;
  redactFailureText: (raw: unknown) => string;
};

const { failureTextOf, redactFailureText } = mod;

/** The marker the implementation emits for a whole credential SHAPE. */
const REDACTED = "<redacted>";
/** The marker emitted for a bare provider API key (the `sk-…` family). */
const REDACTED_KEY = "<redacted-key>";

describe("R98 redaction — F6: a provider failure text must never carry a credential", () => {
  it("redacts a Bearer token echoed back inside an HTTP 401 message (the F6 canary shape)", () => {
    // THE defect: this exact message shape is what the provider produced, and the
    // old `failureTextOf` returned it byte-for-byte. The canary below is the
    // synthetic credential F6 used to prove the leak.
    const canary = "sk-live-ABCDEF1234567890";
    const out = failureTextOf({
      message: `OpenAI chat completion failed: HTTP 401: Bearer ${canary} rejected`,
    });

    expect(out).not.toContain(canary);
    // Not merely "shorter": the credential POSITION must carry the marker, which
    // proves the text was redacted in place rather than the whole line discarded.
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).toContain("HTTP 401");
  });

  it("redacts a raw sk- API key that appears with no Bearer prefix", () => {
    // A provider that echoes `key sk-…` in a validation error has no `Bearer`
    // keyword for the first pattern to anchor on. Before the `sk-` pattern this
    // key travelled through untouched.
    const key = "sk-F_wtNzOghM6YPaSXuouh7uY7p71auuZDIUnIrp9VWR0";
    const out = failureTextOf(`key ${key} is invalid`);

    expect(out).not.toContain(key);
    // The distinctive tail is asserted separately: a partial redaction that keeps
    // enough of the key to be usable must fail too.
    expect(out).not.toContain("UnIrp9VWR0");
    expect(out).toContain(REDACTED_KEY);
  });

  it("redacts query-string secrets from a URL", () => {
    const out = failureTextOf("https://example.invalid/v1?api_key=SECRETVALUE&token=OTHERSECRET");

    expect(out).not.toContain("SECRETVALUE");
    expect(out).not.toContain("OTHERSECRET");
    // Both values must be replaced, not just the first one the regex happened to
    // match — a global replace is the contract.
    expect(out).toContain("api_key=<redacted>");
    expect(out).toContain("token=<redacted>");
  });

  it("redacts URL userinfo (user:password@host)", () => {
    const out = failureTextOf("https://user:hunter2@example.invalid/v1");

    expect(out).not.toContain("hunter2");
    expect(out).toContain("<redacted>@example.invalid");
  });

  it("redacts both a thrown Error instance and a thrown plain string", () => {
    // The driver stores failures from BOTH sources: the `error` event's payload
    // and the `catch` branch (whose `err.message` was the original F6 leak path).
    const fromError = failureTextOf(new Error("Bearer abc123456789 knocked back"));
    expect(fromError).not.toContain("abc123456789");
    expect(fromError).toContain(REDACTED);

    const fromString = failureTextOf("Token deadbeefdeadbeef");
    expect(fromString).not.toContain("deadbeefdeadbeef");
    expect(fromString).toContain(REDACTED);
  });

  it("redacts a fake OPENAI_API_KEY=… assignment embedded in a message", () => {
    // The environment-assignment shape: a message that quotes config rather than
    // an HTTP header. The `Bearer`/`Token` patterns do not match it, so this is
    // the case that proves the bare-key pattern is doing real work.
    const out = failureTextOf("request failed: OPENAI_API_KEY=sk-abcdef1234567890 missing scopes");

    expect(out).not.toContain("sk-abcdef1234567890");
    expect(out).toContain(REDACTED_KEY);
  });
});

describe("R98 redaction — the function is not a blunt 'delete everything' filter", () => {
  it("leaves the allowlisted benign failure text VERBATIM", () => {
    // The over-redaction failure mode is its own defect: if a harmless error were
    // mangled, operators would lose the diagnosis that makes the persisted
    // failures useful. Exact equality is the assertion that prevents a future
    // "redact more aggressively" change from silently destroying triage signal.
    const benign = "OpenAI chat completion failed: HTTP 429: rate limit exceeded";
    expect(failureTextOf(benign)).toBe(benign);
  });

  it("leaves a normal short error code intact (code-only branch)", () => {
    // When an event carries no `message`, the driver falls back to `code`. That
    // code is an identifier an operator matches on, so it must survive.
    expect(failureTextOf({ code: "MODEL_ERROR" })).toBe("MODEL_ERROR");
  });
});

describe("R98 redaction — total input domain and the ordering of cap vs redaction", () => {
  it("never throws and always returns a short non-empty string for weird inputs", () => {
    // `failureTextOf` sits on the failure path: anything it throws would replace
    // the real provider error with a rendering crash and could abort the campaign
    // bookkeeping. Every shape below must render.
    const nested = { error: { detail: { nested: { deep: true } } }, list: [1, 2, 3] };
    const long = "e".repeat(5000);
    const inputs: unknown[] = [undefined, null, 0, {}, [], nested, long];

    for (const value of inputs) {
      const out = failureTextOf(value);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
      // The cap is a hard contract: the persisted field is bounded at 300 so a
      // pathological provider message cannot bloat the result artifact.
      expect(out.length).toBeLessThanOrEqual(300);
    }

    // The nested object is called out explicitly: it is serialised rather than
    // dropped, and the serialisation itself is still bounded.
    const nestedOut = failureTextOf(nested);
    expect(typeof nestedOut).toBe("string");
    expect(nestedOut.length).toBeLessThanOrEqual(300);
  });

  it("applies the 300-char cap AFTER redaction, so a secret near the boundary is still removed", () => {
    // THE ORDERING DEFECT this locks in. The secret is placed so that it STRADDLES
    // the 300-char boundary:
    //   - truncate-then-redact: the cut leaves the key's head inside the string
    //     and no longer matches the full `sk-…` shape, so it leaks.
    //   - redact-then-truncate (the implementation): the whole key is replaced by
    //     the marker BEFORE the cut, so only the marker reaches the boundary and
    //     the key's tail cannot survive.
    const key = "sk-AAAABBBBCCCCDDDDEEEEFFFF1234";
    // The key starts at index 276 and runs to 307 — its tail is past the 300-char
    // cut, so no matcher can see the full `sk-…` shape within the truncated text.
    // (Arithmetic is asserted below rather than assumed, because a pad that is
    // merely too short would make this test pass without ever exercising the
    // boundary it exists to probe.)
    const pad = "x".repeat(275);
    const straddling = `${pad} ${key} tailmarker`;
    expect(straddling.indexOf(key)).toBe(276);
    expect(straddling.indexOf(key) + key.length).toBeGreaterThan(300); // the input really does cross the cap

    const out = failureTextOf(straddling);
    expect(out.length).toBeLessThanOrEqual(300);
    // The discriminating assertion. The full key cannot appear in EITHER ordering,
    // so asserting its absence would be vacuous: a truncate-first implementation
    // leaks the first 24 characters (`sk-AAAABBBBCCCCDDDDEEEEF`) and the surviving
    // substring no longer matches the `sk-…` pattern. Asserting the absence of the
    // key's PREFIX is therefore what separates the two orders — it fails loudly on
    // truncate-first, and is reported with the leaked prefix so a regression shows
    // the secret in the assertion message.
    expect(out.slice(-40), `leaked key prefix in: ${out.slice(-40)}`).not.toContain("sk-AAAA");
    expect(out).not.toContain("BBBBCCCC");
    // The redacted marker must be present: it is the evidence that the secret was
    // removed rather than merely pushed past the truncation point.
    expect(out).toContain(REDACTED_KEY);
  });

  it("collapses newlines and tabs into a single line", () => {
    // A multi-line failure would otherwise break the JSONL/one-record-per-line
    // state the durability layer writes.
    const out = failureTextOf("provider error\n\tat Step 1\r\n\tat Step 2");

    expect(out).not.toContain("\n");
    expect(out).not.toContain("\t");
    expect(out).not.toContain("\r");
    expect(out).toContain("provider error at Step 1 at Step 2");
  });

  it("is idempotent: re-redacting its own output changes nothing", () => {
    // The 300-char cap can slice a marker in half (e.g. `<redac`). Idempotence on
    // COMPLETE text is what this asserts — a second pass over already-redacted
    // text must be a fixed point, so re-persisting a stored failure is safe.
    const raw = "Bearer sk-live-ABCDEF1234567890 https://u:p@h.invalid/v1?token=SECRETVALUE";
    const once = redactFailureText(raw);
    const twice = redactFailureText(once);

    expect(twice).toBe(once);
    expect(once).not.toContain("sk-live-ABCDEF1234567890");
    expect(once).not.toContain("SECRETVALUE");
    expect(once).not.toContain(":p@");
  });
});
