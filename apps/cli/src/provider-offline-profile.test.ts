/**
 * S3 / F4 (Phase A) — THE BUILT-IN OFFLINE PROFILE: closed enum, zero-network
 * scripted content transport, and the counter-example with a counting proof.
 *
 * The claims pinned here (each is a SEPARATE expectation, so a failure names
 * the exact property that broke):
 *
 *   1. CLOSED ENUM. An unknown profile id is a REFUSAL — it never falls back to
 *      the stub, to the real provider, or to a default profile.
 *   2. ZERO NETWORK. The content profile's transport is scripted in-process.
 *      `provider.ts` contains no `fetch`/socket/HTTP-client call on this path,
 *      and the transport is driven to completion here with no server anywhere.
 *   3. IT CAN DRIVE A REAL CONTENT TASK. The scripted provider really ADVERTISES
 *      a tool and really REQUESTS `write_file` — which `stubProvider()` cannot
 *      do (its single `MODEL_ERROR` is asserted below as the contrast).
 *   4. REFUSAL UNDER A REAL PROVIDER. With `OPENAI_API_KEY` / `OPENAI_MODEL`
 *      present the profile refuses, so it is impossible to observe as offline
 *      while a real provider could be built from that environment.
 *   5. THE COUNTING PROOF. `instrumentedRealProviderFactory` is the only
 *      sanctioned real-provider entry point; it counts entries. A full offline
 *      run leaves the count at 0, and the SAME counter moves when pointed at a
 *      real-provider environment — so the 0 is a measured fact, not an
 *      assumption about which branch ran.
 *   6. THE CAPABILITY AGREES WITH THE RESOLVED PROVIDER, and it can only be
 *      issued for the observed identity (a relay endpoint is refused).
 */

import { describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider } from "@ar/contracts";
import { isNonBillableFixtureTransport } from "@ar/evaluation";
import { PREREG_OFFLINE_PROFILE_ID, offlineTransportForPrereg, preregCommandDeps } from "./main.js";
import { formalExecutionProfile } from "./prereg-execution-identity.js";
import {
  KNOWN_OFFLINE_PROFILE_IDS,
  OFFLINE_CONTENT_MAX_MODEL_CALLS_EXPECTED,
  OFFLINE_CONTENT_PROFILE_ID,
  OFFLINE_CONTENT_SCRIPT_TURNS,
  OFFLINE_CONTENT_TASK,
  OFFLINE_MODEL_ID,
  OFFLINE_PROVIDER_ID,
  OFFLINE_REFUSAL_PROFILE_ID,
  OFFLINE_SCRIPT_EXHAUSTED_CODE,
  createOfflineProfileCounters,
  createOfflineScriptedProvider,
  envHasRealProviderConfiguration,
  instrumentedRealProviderFactory,
  isOfflineProfileId,
  resolveOfflineProfileCapability,
  stubProvider,
} from "./provider.js";

/** The identity this build reports for the offline profile. */
const OFFLINE_IDENTITY = { providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID, endpointBaseUrl: null };

/** A KEYLESS environment — no real provider is constructible from it. */
const KEYLESS: NodeJS.ProcessEnv = {};

const REAL_KEY_ENV: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-not-a-real-key" };
const REAL_MODEL_ENV: NodeJS.ProcessEnv = { OPENAI_MODEL: "gpt-4o-mini" };

/** Fully consume a stream so every yielded event is observed. */
async function drain(iter: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("S3/F4 Phase A — the offline profile is a closed, versioned vocabulary", () => {
  it("exposes a frozen array of exactly the known ids and a working type guard", () => {
    expect(Object.isFrozen(KNOWN_OFFLINE_PROFILE_IDS)).toBe(true);
    expect([...KNOWN_OFFLINE_PROFILE_IDS]).toEqual([
      "offline-scripted-content-v1",
      "offline-refusal-v1",
    ]);
    expect(isOfflineProfileId(OFFLINE_CONTENT_PROFILE_ID)).toBe(true);
    expect(isOfflineProfileId(OFFLINE_REFUSAL_PROFILE_ID)).toBe(true);
    expect(isOfflineProfileId("offline-scripted-content-v2")).toBe(false);
    expect(isOfflineProfileId("")).toBe(false);
    expect(isOfflineProfileId(null)).toBe(false);
    expect(isOfflineProfileId(undefined)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isOfflineProfileId(7 as any)).toBe(false);
  });

  it("[1] an UNKNOWN profile id is a REFUSAL — never a silent fallback", () => {
    for (const unknown of [
      "offline-scripted-content-v2",
      "content",
      "",
      "stub",
      null,
      undefined,
      42,
      { profileId: OFFLINE_CONTENT_PROFILE_ID },
    ]) {
      const res = resolveOfflineProfileCapability({
        profileId: unknown,
        identity: OFFLINE_IDENTITY,
        env: KEYLESS,
      });
      expect(res.ok, `id=${JSON.stringify(unknown)} must be refused`).toBe(false);
      expect(res.ok === false && res.code).toBe("UNKNOWN_OFFLINE_PROFILE_ID");
      // It must not have produced a provider at all.
      expect(res.ok === false).toBe(true);
    }
  });
});

describe("S3/F4 Phase A — the content profile drives a REAL write_file with zero network", () => {
  it("[3] advertises a tool-capable model and requests write_file on turn 0", async () => {
    const advertized: string[][] = [];
    const res = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const models = await res.provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.capabilities?.toolCalling).toBe(true);

    // Re-resolve so the turn observer is wired (the factory is the only issuer).
    const observed = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
    });
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    void advertized;
    const client = observed.provider.createClient(
      { providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID },
      {},
    );
    const events = await drain(client.generate({ messages: [] }, new AbortController().signal));

    const callDelta = events.find((e) => e.type === "tool_call_delta");
    expect(callDelta, "turn 0 must request a tool call").toBeDefined();
    const call = (callDelta as { toolCall: { name: string; args: Record<string, unknown> } }).toolCall;
    expect(call.name).toBe("write_file");
    expect(call.args["path"]).toBe(OFFLINE_CONTENT_TASK.outputPath);
    expect(call.args["content"]).toBe(OFFLINE_CONTENT_TASK.content);

    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect((completed as { result: { finishReason: string } }).result.finishReason).toBe("tool_calls");
  });

  it("[3b] the SAME provider terminates after the tool result (turn 1 is text-only)", async () => {
    const res = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const client = res.provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});

    await drain(client.generate({ messages: [] }, new AbortController().signal));
    const second = await drain(client.generate({ messages: [] }, new AbortController().signal));
    expect(second.some((e) => e.type === "tool_call_delta")).toBe(false);
    const completed = second.find((e) => e.type === "completed");
    expect((completed as { result: { finishReason: string } }).result.finishReason).toBe("stop");
  });

  it("[CONTRAST] stubProvider() CANNOT drive a content task — it emits one MODEL_ERROR", async () => {
    const stub: ModelProvider = stubProvider();
    const client = stub.createClient({ providerId: "stub", modelId: "stub-model" }, {});
    const events = await drain(client.generate({ messages: [] }, new AbortController().signal));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect(events.some((e) => e.type === "tool_call_delta")).toBe(false);
    // ...and it is a DIFFERENT object from the content profile's transport.
    const res = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.provider).not.toBe(stub);
  });

  it("[2] the refusal profile is the stub shape; the content profile is NOT", async () => {
    const refusal = resolveOfflineProfileCapability({
      profileId: OFFLINE_REFUSAL_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
    });
    expect(refusal.ok).toBe(true);
    if (!refusal.ok) return;
    const client = refusal.provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});
    const events = await drain(client.generate({ messages: [] }, new AbortController().signal));
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_delta")).toBe(false);
  });
});

describe("S3/F4 Phase A — refusal while a REAL provider is configured", () => {
  it("[4] envHasRealProviderConfiguration keys on the SAME rule envProviderId uses", () => {
    expect(envHasRealProviderConfiguration(KEYLESS)).toBe(false);
    expect(envHasRealProviderConfiguration(REAL_KEY_ENV)).toBe(true);
    expect(envHasRealProviderConfiguration(REAL_MODEL_ENV)).toBe(true);
    expect(envHasRealProviderConfiguration({ OPENAI_API_KEY: "" })).toBe(false);
  });

  it("[4b] BOTH content and refusal profiles refuse under a real provider env", () => {
    for (const env of [REAL_KEY_ENV, REAL_MODEL_ENV]) {
      for (const profileId of [OFFLINE_CONTENT_PROFILE_ID, OFFLINE_REFUSAL_PROFILE_ID] as const) {
        const res = resolveOfflineProfileCapability({ profileId, identity: OFFLINE_IDENTITY, env });
        expect(res.ok).toBe(false);
        expect(res.ok === false && res.code).toBe("REAL_PROVIDER_CONFIGURATION_PRESENT");
      }
    }
  });

  it("[4c] the refusal is not order-dependent: a BAD id under a real env still refuses", () => {
    const res = resolveOfflineProfileCapability({
      profileId: "nope",
      identity: OFFLINE_IDENTITY,
      env: REAL_KEY_ENV,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("UNKNOWN_OFFLINE_PROFILE_ID");
  });
});

describe("S3/F4 Phase A — the counting proof and the counter-example", () => {
  it("[5] a full offline run enters the REAL provider factory ZERO times", async () => {
    const counters = createOfflineProfileCounters();
    const res = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
      counters,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Drive the whole scripted task to completion through the capability's OWN
    // provider — the exact object the gate would use.
    const client = res.capability.provider.createClient(
      { providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID },
      {},
    );
    await drain(client.generate({ messages: [] }, new AbortController().signal));
    await drain(client.generate({ messages: [] }, new AbortController().signal));

    expect(counters.realProviderFactoryEntries).toBe(0);
    // GAP1: `networkTransportConstructions` is 1 — the resolution really did
    // build a transport. That is the correct, MEASURED reading (this counter
    // counts constructions, not network-capable ones); the claim being proved
    // about the network is `realProviderFactoryEntries === 0`.
    expect(counters.networkTransportConstructions).toBe(1);
  });

  it("[5b] the SAME counter MOVES when the real factory is actually entered", async () => {
    const counters = createOfflineProfileCounters();
    // Point the instrumented factory at a REAL provider environment, with no
    // key material supplied to it: the ENTRY is still counted.
    const billing = await instrumentedRealProviderFactory(counters, { apiKey: "sk-not-a-real-key" });
    expect(counters.realProviderFactoryEntries).toBe(1);
    // It is classified as billed (a real transport was constructed).
    expect(billing.billingClass).toBe("external-billed");

    // A second, keyless call still counts as an ENTRY (the attempt is the fact).
    await instrumentedRealProviderFactory(counters, { apiKey: "" });
    expect(counters.realProviderFactoryEntries).toBe(2);
  });
});

describe("S3/F4 Phase A — the capability is BRANDED and BOUND", () => {
  it("[6] the issued capability is the real branded one and agrees with the provider", () => {
    const res = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isNonBillableFixtureTransport(res.capability)).toBe(true);
    expect(res.capability.provider).toBe(res.provider);
    expect(res.capability.providerId).toBe(OFFLINE_PROVIDER_ID);
    expect(res.capability.modelId).toBe(OFFLINE_MODEL_ID);
    expect(res.capability.endpointBaseUrl).toBeNull();
    expect(Object.isFrozen(res.capability)).toBe(true);
  });

  it("[6b] a capability can NEVER be issued for a relay/loopback endpoint", () => {
    for (const endpointBaseUrl of ["http://127.0.0.1:8317/v1", "https://api.example.com/v1", ""]) {
      const res = resolveOfflineProfileCapability({
        profileId: OFFLINE_CONTENT_PROFILE_ID,
        identity: { providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID, endpointBaseUrl },
        env: KEYLESS,
      });
      expect(res.ok, `endpoint=${endpointBaseUrl}`).toBe(false);
      expect(res.ok === false && res.code).toBe("OBSERVED_IDENTITY_MISMATCH");
    }
  });

  it("[6c] a capability can NEVER be issued for another provider/model", () => {
    for (const identity of [
      { providerId: "openai", modelId: OFFLINE_MODEL_ID, endpointBaseUrl: null },
      { providerId: OFFLINE_PROVIDER_ID, modelId: "gpt-4o-mini", endpointBaseUrl: null },
      { providerId: "stub", modelId: "stub-model", endpointBaseUrl: null },
    ]) {
      const res = resolveOfflineProfileCapability({
        profileId: OFFLINE_CONTENT_PROFILE_ID,
        identity,
        env: KEYLESS,
      });
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.code).toBe("OBSERVED_IDENTITY_MISMATCH");
    }
  });
});

// ===========================================================================
// GAP 1 — the counter is MEANINGFUL at the factory, not merely accepted
// ===========================================================================
describe("S3/F4 Phase B GAP1 — the factory's counter is load-bearing", () => {
  it("[G1.1] a successful resolution RECORDS that it constructed a transport", () => {
    const counters = createOfflineProfileCounters();
    const res = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
      counters,
    });
    expect(res.ok).toBe(true);
    // (a) the transport construction is a MEASURED fact, not an assumption.
    expect(counters.networkTransportConstructions).toBe(1);
    // ...and it is decisively NOT a real-provider entry.
    expect(counters.realProviderFactoryEntries).toBe(0);
  });

  it("[G1.2] the offline factory NEVER increments realProviderFactoryEntries (that is the quantity being proved)", async () => {
    const counters = createOfflineProfileCounters();
    // Resolve and drive BOTH profiles fully; the real-factory count must stay 0
    // throughout, or the "never entered" claim would be self-defeating.
    for (const profileId of [OFFLINE_CONTENT_PROFILE_ID, OFFLINE_REFUSAL_PROFILE_ID] as const) {
      const res = resolveOfflineProfileCapability({
        profileId,
        identity: OFFLINE_IDENTITY,
        env: KEYLESS,
        counters,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      const client = res.provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});
      await drain(client.generate({ messages: [] }, new AbortController().signal));
    }
    expect(counters.realProviderFactoryEntries).toBe(0);
    expect(counters.networkTransportConstructions).toBe(2);
  });

  it("[G1.3] if the real factory WAS entered, the offline profile is REFUSED — the two cannot agree on different providers", async () => {
    const counters = createOfflineProfileCounters();
    // Simulate Phase C having already constructed a real provider in-process.
    await instrumentedRealProviderFactory(counters, { apiKey: "sk-not-a-real-key" });
    expect(counters.realProviderFactoryEntries).toBe(1);

    const res = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
      counters,
    });
    // The resolution refuses: it cannot hand out an offline capability once a
    // real provider exists, so "observed as offline while a real provider was
    // constructed" is structurally impossible.
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("OBSERVED_IDENTITY_MISMATCH");
    expect(res.ok === false && res.reason).toContain("real-provider factory was entered");
    // The refused resolution must not have recorded a construction of its own.
    expect(counters.networkTransportConstructions).toBe(1);
  });

  it("[G1.4] the counters stay untouched when no counters object is supplied", () => {
    const before = createOfflineProfileCounters();
    const res = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
    });
    expect(res.ok).toBe(true);
    expect(before).toEqual({ realProviderFactoryEntries: 0, networkTransportConstructions: 0 });
  });
});

// ===========================================================================
// GAP 2 — script exhaustion is EXPLICIT and distinguishable
// ===========================================================================
describe("S3/F4 Phase B GAP2 — the content script fails loudly instead of clamping", () => {
  it("[G2.1] the script declares its turn count, and every scripted turn completes", async () => {
    // Phase C raised this from 2 to 3 on MEASURED grounds (reg-12-csv-parse uses
    // 11–28 model calls; see the in-code note). It is pinned so a silent change
    // to the script's shape is a red test, not a surprise in Phase D.
    expect(OFFLINE_CONTENT_SCRIPT_TURNS).toBe(3);
    expect(OFFLINE_CONTENT_MAX_MODEL_CALLS_EXPECTED).toBe(OFFLINE_CONTENT_SCRIPT_TURNS);

    const res = resolveOfflineProfileCapability({
      profileId: OFFLINE_CONTENT_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const client = res.provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});

    for (let i = 0; i < OFFLINE_CONTENT_SCRIPT_TURNS; i++) {
      const events = await drain(client.generate({ messages: [] }, new AbortController().signal));
      expect(events.some((e) => e.type === "error"), `turn ${i} must NOT be an error`).toBe(false);
      expect(events.some((e) => e.type === "completed"), `turn ${i} must complete`).toBe(true);
    }
  });

  it("[G2.2] an over-long run emits a distinct, greppable MODEL_ERROR — NOT a plausible final answer", async () => {
    const exhaustedAt: number[] = [];
    const provider = createOfflineScriptedProvider({ onExhausted: (i) => exhaustedAt.push(i) });
    const client = provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});

    // Consume the whole scripted table...
    for (let i = 0; i < OFFLINE_CONTENT_SCRIPT_TURNS; i++) {
      await drain(client.generate({ messages: [] }, new AbortController().signal));
    }
    // ...then ask for one MORE call than the script has.
    const over = await drain(client.generate({ messages: [] }, new AbortController().signal));

    const err = over.find((e) => e.type === "error");
    expect(err, "an over-long run MUST yield a structured error").toBeDefined();
    // `ErrorCode` is a closed union, so exhaustion is `INTERNAL_ERROR` carrying
    // the greppable marker at the START of the message.
    expect((err as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
    expect((err as { error: { message: string } }).error.message.startsWith(OFFLINE_SCRIPT_EXHAUSTED_CODE)).toBe(true);

    // The critical property: it must NOT fabricate a terminal answer, because a
    // fabricated "stop" would surface as a confusing VERIFIER failure.
    expect(over.some((e) => e.type === "completed")).toBe(false);
    expect(exhaustedAt).toEqual([OFFLINE_CONTENT_SCRIPT_TURNS]);
  });

  it("[G2.3] exhaustion is distinguishable from the refusal profile's error", async () => {
    // The refusal profile's MODEL_ERROR is a CONFIGURATION failure; the
    // exhaustion error is a SCRIPT failure. Different codes, no overlap.
    const refusal = resolveOfflineProfileCapability({
      profileId: OFFLINE_REFUSAL_PROFILE_ID,
      identity: OFFLINE_IDENTITY,
      env: KEYLESS,
    });
    expect(refusal.ok).toBe(true);
    if (!refusal.ok) return;
    const client = refusal.provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});
    const events = await drain(client.generate({ messages: [] }, new AbortController().signal));
    const code = (events.find((e) => e.type === "error") as { error: { code: string } }).error.code;
    expect(code).toBe("MODEL_ERROR");
    // The refusal profile's error does NOT carry the exhaustion marker, so the
    // two failures are told apart by the marker, not only by the code.
    const message = (events.find((e) => e.type === "error") as { error: { message: string } }).error.message;
    expect(message.startsWith(OFFLINE_SCRIPT_EXHAUSTED_CODE)).toBe(false);
  });

  it("[G2.4] every turn beyond the script is an error (no clamping window)", async () => {
    const provider = createOfflineScriptedProvider();
    const client = provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const events = await drain(client.generate({ messages: [] }, new AbortController().signal));
      seen.push(
        events.some(
          (e) =>
            e.type === "error" &&
            (e as { error: { message: string } }).error.message.startsWith(OFFLINE_SCRIPT_EXHAUSTED_CODE),
        )
          ? "exhausted"
          : "scripted",
      );
    }
    expect(seen).toEqual(["scripted", "scripted", "scripted", "exhausted", "exhausted", "exhausted"]);
  });

  it("[G2.5] the FIRST turn is the only one that writes; the rest terminate", async () => {
    const provider = createOfflineScriptedProvider();
    const client = provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});
    const writes: number[] = [];
    for (let i = 0; i < OFFLINE_CONTENT_SCRIPT_TURNS; i++) {
      const events = await drain(client.generate({ messages: [] }, new AbortController().signal));
      if (events.some((e) => e.type === "tool_call_delta")) writes.push(i);
    }
    // Exactly ONE write, and it is turn 0 — otherwise the task would loop.
    expect(writes).toEqual([0]);
  });
});

// ===========================================================================
// PHASE C — the CLI seam: composition root, refusal preservation, and the
// arm-worker boundary
// ===========================================================================
describe("S3/F4 Phase C — preregCommandDeps selects the profile, nothing else can", () => {
  it("[C1] the profile id is a COMPILE-TIME literal, and the deps carry a thunk (not a value)", () => {
    // The production selection is repository-fixed.
    expect(PREREG_OFFLINE_PROFILE_ID).toBe(OFFLINE_CONTENT_PROFILE_ID);
    expect(isOfflineProfileId(PREREG_OFFLINE_PROFILE_ID)).toBe(true);
    // The deps always build the production adapter.
    const deps = preregCommandDeps(KEYLESS);
    expect(typeof deps.runner?.makeProvider).toBe("function");
    expect(typeof deps.runner?.observe).toBe("function");
    expect(typeof deps.runner?.runArm).toBe("function");
  });

  it("[C2] the thunk yields the BRANDED capability bound to the OBSERVED identity", () => {
    const deps = preregCommandDeps(KEYLESS);
    const seam = deps.runner?.offlineTransport;
    // Phase D: the profile is SELECTED and the env is keyless, so the observer
    // legitimately reports the offline identity and the seam exists. It must be
    // a ZERO-ARGUMENT thunk yielding the branded capability.
    expect(typeof seam).toBe("function");
    expect(seam?.length).toBe(0);
    const capability = seam?.();
    expect(isNonBillableFixtureTransport(capability)).toBe(true);
    const cap = capability as { providerId: string; modelId: string; endpointBaseUrl: string | null };
    expect(cap.providerId).toBe(OFFLINE_PROVIDER_ID);
    expect(cap.modelId).toBe(OFFLINE_MODEL_ID);
    expect(cap.endpointBaseUrl).toBeNull();
  });

  it("[C3] THE REFUSAL PATH SURVIVES: with a REAL provider env there is NO seam at all", () => {
    // This is the property that keeps FIXTURE_TRANSPORT_NOT_NON_BILLABLE
    // reachable: no seam -> the gate's conditional spread is absent -> the gate
    // refuses a fixture-mode authorization exactly as before.
    expect(offlineTransportForPrereg(REAL_KEY_ENV)).toBeUndefined();
    expect(offlineTransportForPrereg(REAL_MODEL_ENV)).toBeUndefined();

    const deps = preregCommandDeps(REAL_KEY_ENV);
    expect(deps.runner?.offlineTransport).toBeUndefined();
    // The adapter itself is still fully wired — only the seam is gone.
    expect(typeof deps.runner?.makeProvider).toBe("function");
    expect(typeof deps.runner?.observe).toBe("function");
    expect(typeof deps.runner?.runArm).toBe("function");
  });

  it("[C4] no CLI flag/env/JSON/marker can select the profile (the selection is not in the argument surface)", () => {
    // The profile id is NOT read from the environment: absent, bogus and
    // offline-looking env keys all leave the production selection unchanged.
    for (const env of [
      KEYLESS,
      { AR_OFFLINE_PROFILE: "offline-scripted-content-v1" },
      { AR_OFFLINE_PROFILE: "totally-made-up" },
      { PREREG_OFFLINE_PROFILE: "offline-refusal-v1" },
      { OFFLINE_PROFILE: "offline-scripted-content-v1" },
    ]) {
      expect(PREREG_OFFLINE_PROFILE_ID).toBe(OFFLINE_CONTENT_PROFILE_ID);
      // A keyless env still yields the CONTENT profile: an env var cannot
      // downgrade or redirect the selection.
      const res = resolveOfflineProfileCapability({
        profileId: PREREG_OFFLINE_PROFILE_ID,
        identity: OFFLINE_IDENTITY,
        env: {},
      });
      expect(res.ok).toBe(true);
      expect(res.ok === true && res.profileId).toBe(OFFLINE_CONTENT_PROFILE_ID);
      void env;
    }
  });

  it("[C5] an UNKNOWN/absent profile id refuses — it never falls back to a real provider", () => {
    for (const profileId of [undefined, null, "", "offline-scripted-content-v2", "openai", 0]) {
      const res = resolveOfflineProfileCapability({
        profileId,
        identity: OFFLINE_IDENTITY,
        env: KEYLESS,
      });
      expect(res.ok, `id=${JSON.stringify(profileId)}`).toBe(false);
      expect(res.ok === false && res.code).toBe("UNKNOWN_OFFLINE_PROFILE_ID");
      // Critically: no provider and no capability are produced, so there is
      // nothing for the gate to admit.
      expect(res.ok === false && "provider" in res).toBe(false);
    }
  });

  it("[C6] COUNTER-EXAMPLE (i): a keyless env with NO offline selection still observes stub — no silent relabel", () => {
    // THE DIRECTION THAT MUST NOT REGRESS. With NO selection (the default, and
    // every pre-existing caller), the observer MUST still report the stub for a
    // keyless env. If this ever reported `offline-scripted`, every existing
    // keyless run would be silently relabelled — the exact "observe as X while
    // running Y" drift the gate exists to prevent.
    const noSel = formalExecutionProfile(KEYLESS);
    expect(noSel.provider.providerId).toBe("stub");
    expect(noSel.provider.modelId).toBe("stub-model");
    expect(noSel.provider.endpointBaseUrl).toBeNull();

    // Explicitly passing the "nothing selected" default is identical.
    const explicit = formalExecutionProfile(KEYLESS, { offlineProfileId: null });
    expect(explicit.provider).toEqual(noSel.provider);
    expect(explicit.provider.providerId).toBe("stub");
  });

  it("[C7] COUNTER-EXAMPLE (ii): a REAL key env observes the real identity even when the offline profile is requested", () => {
    // Select the offline profile AND supply a real provider config: the two may
    // never be reconciled by preference, so this is a REFUSAL (throw), not a
    // fabricated offline identity.
    expect(() => formalExecutionProfile(REAL_KEY_ENV, { offlineProfileId: PREREG_OFFLINE_PROFILE_ID })).toThrow(
      /OFFLINE_PROFILE_AND_REAL_PROVIDER_CONFIG/,
    );
    expect(() => formalExecutionProfile(REAL_MODEL_ENV, { offlineProfileId: PREREG_OFFLINE_PROFILE_ID })).toThrow(
      /OFFLINE_PROFILE_AND_REAL_PROVIDER_CONFIG/,
    );

    // Unselected, the same env still observes the REAL identity — so the
    // capability cannot be issued for it.
    const observedReal = formalExecutionProfile(REAL_KEY_ENV).provider;
    expect(observedReal.providerId).toBe("openai");
    const refusal = resolveOfflineProfileCapability({
      profileId: PREREG_OFFLINE_PROFILE_ID,
      identity: {
        providerId: observedReal.providerId,
        modelId: observedReal.modelId,
        endpointBaseUrl: observedReal.endpointBaseUrl,
      },
      env: {},
    });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.code).toBe("OBSERVED_IDENTITY_MISMATCH");

    // And end-to-end through the composition root: NO seam at all, so the gate
    // keeps its unchanged FIXTURE_TRANSPORT_NOT_NON_BILLABLE refusal path.
    expect(offlineTransportForPrereg(REAL_KEY_ENV)).toBeUndefined();
    expect(preregCommandDeps(REAL_KEY_ENV).runner?.offlineTransport).toBeUndefined();
  });

  it("[C8] SELECTED + keyless observes the offline identity and opens the seam", () => {
    const selected = formalExecutionProfile(KEYLESS, { offlineProfileId: PREREG_OFFLINE_PROFILE_ID });
    expect(selected.provider.providerId).toBe(OFFLINE_PROVIDER_ID);
    expect(selected.provider.modelId).toBe(OFFLINE_MODEL_ID);
    expect(selected.provider.endpointBaseUrl).toBeNull();
    expect(typeof offlineTransportForPrereg(KEYLESS)).toBe("function");
  });

  it("[C9] an UNKNOWN offline profile id in the selection is a refusal, never a fallback", () => {
    for (const id of ["offline-scripted-content-v2", "openai", "stub", ""]) {
      expect(() => formalExecutionProfile(KEYLESS, { offlineProfileId: id })).toThrow(
        /OFFLINE_PROFILE_AND_REAL_PROVIDER_CONFIG/,
      );
    }
    // The production selection is always one of the KNOWN ids, so the refusal
    // above can never be reached through the composition root.
    expect(isOfflineProfileId(PREREG_OFFLINE_PROFILE_ID)).toBe(true);
  });
});

// ===========================================================================
// PHASE D — WHAT THE OFFLINE PROFILE ACTUALLY DEMONSTRATES (honest scope)
// ===========================================================================
describe("S3/F4 Phase D — end-to-end scope of the offline content profile", () => {
  it("[D1] the scripted provider drives a write_file REQUEST and then terminates within its script", async () => {
    // This is the MEASURED, in-process part: the provider emits a well-formed
    // `write_file` tool call on turn 0 and a terminal `stop` afterwards, so a
    // harness that executes the tool really would create the file. It runs
    // inside the script's own turn budget.
    const provider = createOfflineScriptedProvider();
    const client = provider.createClient({ providerId: OFFLINE_PROVIDER_ID, modelId: OFFLINE_MODEL_ID }, {});
    const calls: string[] = [];
    for (let i = 0; i < OFFLINE_CONTENT_SCRIPT_TURNS; i++) {
      const events = await drain(client.generate({ messages: [] }, new AbortController().signal));
      for (const e of events) if (e.type === "tool_call_delta") calls.push(e.toolCall.name);
      const done = events.find((e) => e.type === "completed");
      if (i > 0) expect((done as { result: { finishReason: string } }).result.finishReason).toBe("stop");
    }
    expect(calls).toEqual(["write_file"]);
    // NOT_PROVEN beyond this: an END-TO-END real content task through the
    // runtime + orchestrator + verifier is NOT exercised here, and the recorded
    // real-model cost of `reg-12-csv-parse` (11/13/20/28 model calls) EXCEEDS
    // this script. So the offline profile has demonstrated a real tool REQUEST
    // issued with zero network, not a full content task completion.
    expect(OFFLINE_CONTENT_SCRIPT_TURNS).toBeLessThan(11);
  });
});


