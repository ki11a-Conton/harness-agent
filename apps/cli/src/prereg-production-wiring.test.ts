/**
 * S0 — reproducers for F1: the RELEASE CLI's own entry point.
 *
 * The N5 suite proved the chain works when a test injects `CommandDeps.preregRunner`.
 * That is not the shipped path. `node apps/cli/dist/main.js prereg …` goes through
 * `main()` in `main.ts`, and `main()` called `createDefaultDeps()` — which resolves
 * a model provider from the environment — BEFORE it dispatched the command.
 *
 * Two invariants are pinned here:
 *
 *   F1a — a 0-call command (`prereg validate`) must not resolve/construct a
 *         provider at all. FIXED: `main()` now dispatches `prereg` before
 *         `createDefaultDeps()`, so the resolution count is 0.
 *   F1b — the release CLI must actually BE able to run the formal chain. STILL
 *         OPEN: `preregRunner` is not yet wired in production, so
 *         `prereg validate`/`run` refuse with "no harness adapter wired" no
 *         matter how valid the artifact is. Tracked as `it.fails` until S2.
 *
 * `resolveModelProvider` is mocked so the resolution COUNT is observable and the
 * test itself performs 0 external calls. `main()` writes to stdout, so that is
 * captured to read the refusal reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  buildToolCallEfficiencyPreregistrationV2,
  serializePreregistrationV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";

const hoisted = vi.hoisted(() => ({ resolveCalls: 0 }));

/**
 * Count provider RESOLUTION on the release path. The real resolver constructs an
 * OpenAI-compatible provider whenever OPENAI_API_KEY is set; this mock keeps the
 * count observable while always returning the local stub, so the test makes no
 * external call even with a key present.
 */
vi.mock("./provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider.js")>();
  return {
    ...actual,
    resolveModelProvider: async (...args: Parameters<typeof actual.resolveModelProvider>) => {
      hoisted.resolveCalls += 1;
      return { provider: actual.stubProvider(), billingClass: "offline-test" as const };
    },
  };
});

const { main } = await import("./main.js");

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../scripts/e4/fixtures/n5-prereg-config.json", import.meta.url), "utf8"),
) as PreregistrationV2Options;

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "s0-cli-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_KEY = process.env["OPENAI_API_KEY"];
const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
let claimsDir: string | null = null;

beforeEach(async () => {
  hoisted.resolveCalls = 0;
  // A key is present so that, on 1c9a848, the resolver really WOULD construct a
  // billable provider before the command runs.
  process.env["OPENAI_API_KEY"] = "s0-test-key-not-real";
  claimsDir = await mkdtemp(join(tmpdir(), "s0-cli-claims-"));
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = claimsDir;
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (PREVIOUS_KEY === undefined) delete process.env["OPENAI_API_KEY"];
  else process.env["OPENAI_API_KEY"] = PREVIOUS_KEY;
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  if (claimsDir !== null) {
    await rm(claimsDir, { recursive: true, force: true }).catch(() => undefined);
    claimsDir = null;
  }
});

/** Run the REAL `main()` and capture whatever it wrote to stdout. */
async function runMain(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await main(["node", "agent", ...argv]);
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

async function writeArtifact(dir: string): Promise<{ preregPath: string; authPath: string; artifact: ToolCallEfficiencyPreregistrationV2 }> {
  const artifact = buildToolCallEfficiencyPreregistrationV2(FIXTURE);
  const preregPath = join(dir, "prereg.json");
  await writeFile(preregPath, serializePreregistrationV2(artifact), "utf8");
  const authPath = join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      schemaVersion: "tool-call-efficiency-authorization-v2",
      preregistrationDigest: artifact.preregistrationDigest,
      candidateSourceSha: artifact.subject.candidateSourceSha,
      baselineArmDigest: artifact.subject.baselineArmDigest,
      candidateArmDigest: artifact.subject.candidateArmDigest,
      providerId: artifact.provider.providerId,
      modelId: artifact.provider.modelId,
      endpointDigest: artifact.provider.endpointDigest,
      caps: {
        maxModelCalls: artifact.budget.campaignWorstCaseModelCalls,
        maxToolCalls: artifact.budget.maxToolCalls,
        maxDurationMs: artifact.budget.maxDurationMs,
        maxInputTokens: artifact.budget.maxInputTokens,
        maxOutputTokens: artifact.budget.maxOutputTokens,
        maxTotalTokens: artifact.budget.maxTotalTokens,
        maxUsdMicros: artifact.budget.maxUsdMicros,
      },
      issuedAtMs: 1_000,
      expiresAtMs: 9_000_000_000_000,
      approvalId: "approval-1",
      allowResume: true,
      paid: true,
    }),
    "utf8",
  );
  return { preregPath, authPath, artifact };
}

describe("S0/F1 — the release CLI must not build a provider before dispatch", () => {
  it("prereg validate resolves NO provider (0-call command)", async () => {
    const dir = await tempDir();
    const { preregPath } = await writeArtifact(dir);

    await runMain(["prereg", "validate", preregPath]);

    // THE INVARIANT: the number of provider resolutions on the release path.
    expect(hoisted.resolveCalls).toBe(0);
  });
});

describe("S0/F1 — the release CLI must be able to run the formal chain", () => {
  // KNOWN GAP (S2/F1b): `main()` now dispatches `prereg` before
  // `createDefaultDeps()` (no provider is resolved — see the F1a test above),
  // but the release CLI still injects no production `PreregRunnerAdapter`, so
  // `prereg run` refuses with "no harness adapter wired". This pins the REQUIRED
  // invariant and is `it.fails` until S2 wires a real observer + paired arm
  // runner — at which point it will start passing and MUST be promoted to
  // `it(...)` (vitest fails a stale `it.fails`).
  it.fails("prereg run does not refuse with 'no harness adapter wired'", async () => {
    const dir = await tempDir();
    const { preregPath, authPath } = await writeArtifact(dir);

    const res = await runMain([
      "prereg",
      "run",
      preregPath,
      "--authorization",
      authPath,
      "--budget-dir",
      join(dir, "budget"),
      "--out",
      join(dir, "out"),
      "--mode",
      "first-run",
    ]);

    // THE INVARIANT: production wiring exists, so the refusal — if any — is about
    // the artifact/identity/authorization, never about a missing adapter.
    expect(res.out).not.toContain("no harness adapter wired");
    // And a refusal must still not have resolved a provider first.
    expect(hoisted.resolveCalls).toBe(0);
  });
});