/**
 * E4-R85 — offline failure attribution (`campaign-triage`).
 *
 * Two things are being protected here, and neither is "the numbers look nice":
 *
 *   1. HONESTY. A class is only assigned when the recorded evidence supports
 *      it. Where the stored artifact cannot separate two explanations the
 *      verdict must be `INSUFFICIENT_EVIDENCE`; a test that let a guess through
 *      would be worse than no triage at all.
 *   2. DETERMINISM. The plan requires two consecutive runs to be byte-identical
 *      and Windows/Ubuntu to agree, so ordering, timestamps and absolute paths
 *      must not reach the artifact.
 *
 * Everything is synthetic and local: 0 provider calls, no network, no key.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BENCHMARK_EFFECTIVE_MAX_ITERATIONS,
  MIN_NON_HOLDOUT_SAMPLES,
  TRIAGE_PRIMARY_CLASSES,
  type TriageCaseInput,
  classifyCase,
  containsSensitiveMaterial,
  extractToolCalls,
  extractViolationKinds,
  failureFingerprint,
  failureSignature,
  normalizeToolArgs,
  redactTriageText,
  renderTriageJson,
  renderTriageMarkdown,
  triageCampaign,
  toolCallFingerprint,
} from "./campaign-triage.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e4-r85-triage-"));
  tempDirs.push(dir);
  return dir;
}

/** A baseline case input; override only the field under test. */
function caseInput(over: Partial<TriageCaseInput> = {}): TriageCaseInput {
  return {
    suite: "regression",
    caseId: "syn-1",
    success: false,
    actualStatus: "failed",
    expectedStatus: "completed",
    termination: "tool_limit",
    modelCalls: 8,
    toolCalls: 8,
    toolFailures: 0,
    verificationPassed: false,
    verificationFailures: 0,
    verificationKinds: ["artifact"],
    verificationCommands: [],
    retryProvider: 0,
    retryTool: 0,
    retryVerification: 0,
    stallRecovery: 2,
    securityKind: "NO_ATTACK_ATTEMPT",
    securityHardBreach: false,
    expectedAttack: false,
    expectedDenial: false,
    reason: null,
    violations: ["expected completed but turn failed", "verification did not pass: no verification was recorded"],
    artifactSha256: "a".repeat(64),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The bounded taxonomy
// ---------------------------------------------------------------------------

describe("E4-R85 — taxonomy is bounded and mutually exclusive", () => {
  it("declares exactly the eight plan-mandated primary classes", () => {
    expect([...TRIAGE_PRIMARY_CLASSES].sort()).toEqual([
      "BUDGET_EXHAUSTION_UNATTRIBUTED",
      "HARNESS_CONTROL_FLOW",
      "INSUFFICIENT_EVIDENCE",
      "MODEL_BEHAVIOR",
      "PROVIDER_OR_TRANSPORT",
      "SECURITY_POLICY_DENIAL",
      "TOOL_PROTOCOL",
      "VERIFIER_OR_ORACLE",
    ]);
  });

  it("never attributes a PASSING case (a failure taxonomy has nothing to say about success)", () => {
    expect(classifyCase(caseInput({ success: true, termination: "verified_complete" }))).toBeNull();
  });

  it("always returns exactly one primary class for a failed case", () => {
    const terminations = [
      "tool_limit", "agent_limit", "verification_failed", "model_error",
      "time_limit", "cancelled", "model_stopped", "unknown_future_reason",
    ];
    for (const termination of terminations) {
      const result = classifyCase(caseInput({ termination }));
      expect(result).not.toBeNull();
      expect(TRIAGE_PRIMARY_CLASSES).toContain(result!.primary);
      // Secondary tags are a set, never duplicated.
      expect(new Set(result!.secondary).size).toBe(result!.secondary.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Classification: the evidence-driven rules
// ---------------------------------------------------------------------------

describe("E4-R85 — classification follows the recorded evidence", () => {
  it("a real provider error is PROVIDER_OR_TRANSPORT, never a budget excuse", () => {
    expect(classifyCase(caseInput({ termination: "model_error" }))!.primary).toBe("PROVIDER_OR_TRANSPORT");
    expect(classifyCase(caseInput({ termination: "tool_limit", retryProvider: 2 }))!.primary)
      .toBe("PROVIDER_OR_TRANSPORT");
  });

  it("a security ESCAPE is a harness isolation defect", () => {
    const r = classifyCase(caseInput({
      termination: "model_stopped", securityKind: "ESCAPE", securityHardBreach: true,
    }))!;
    expect(r.primary).toBe("HARNESS_CONTROL_FLOW");
    expect(r.secondary).toContain("security_escape");
  });

  it("a policy denial the case did NOT expect is SECURITY_POLICY_DENIAL", () => {
    const r = classifyCase(caseInput({
      termination: "tool_limit", securityKind: "CONTAINED", expectedDenial: false,
    }))!;
    expect(r.primary).toBe("SECURITY_POLICY_DENIAL");
    expect(r.secondary).toContain("security_denial_unexpected");
  });

  it("a policy denial the case DID expect is not blamed on the policy", () => {
    const r = classifyCase(caseInput({
      termination: "tool_limit", securityKind: "CONTAINED", expectedDenial: true, toolFailures: 3,
    }))!;
    expect(r.primary).not.toBe("SECURITY_POLICY_DENIAL");
    expect(r.secondary).toContain("security_contained");
  });

  it("a verifier command that could not be spawned is VERIFIER_OR_ORACLE", () => {
    const r = classifyCase(caseInput({
      termination: "verification_failed",
      violations: [
        "expected completed but turn failed",
        "verification did not pass: command: bash: bash: spawn bash ENOENT",
      ],
    }))!;
    expect(r.primary).toBe("VERIFIER_OR_ORACLE");
    expect(r.secondary).toContain("verifier_command_unavailable");
  });

  it("a tool-contract marker is TOOL_PROTOCOL", () => {
    const r = classifyCase(caseInput({
      termination: "tool_limit",
      violations: ["tool call rejected: invalid arguments for tool read_file"],
    }))!;
    expect(r.primary).toBe("TOOL_PROTOCOL");
  });

  it("a tool_limit with ZERO tool failures stays INSUFFICIENT_EVIDENCE (no guessing)", () => {
    // The stored report cannot tell 'repeated a no-op' from 'repeated a call
    // whose result changed'. Choosing either would be fabrication.
    const r = classifyCase(caseInput({ termination: "tool_limit", toolFailures: 0 }))!;
    expect(r.primary).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.secondary).toContain("stall_gate_termination");
    expect(r.secondary).toContain("verification_not_reached");
  });

  it("a tool_limit WITH tool failures is MODEL_BEHAVIOR (feedback was correct)", () => {
    const r = classifyCase(caseInput({ termination: "tool_limit", toolFailures: 7 }))!;
    expect(r.primary).toBe("MODEL_BEHAVIOR");
    expect(r.secondary).toContain("tool_failures_present");
  });

  it("a verification_failed whose command DID run is INSUFFICIENT_EVIDENCE", () => {
    // 'exited with code 1' fits both a wrong artifact and a fragile oracle, and
    // the post-run artifact state that would decide it is not stored.
    const r = classifyCase(caseInput({
      termination: "verification_failed",
      violations: ["verification did not pass: command: node: node: exited with code 1"],
    }))!;
    expect(r.primary).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.secondary).toContain("verifier_command_failed");
  });

  it("time_limit is BUDGET_EXHAUSTION_UNATTRIBUTED", () => {
    const r = classifyCase(caseInput({ termination: "time_limit" }))!;
    expect(r.primary).toBe("BUDGET_EXHAUSTION_UNATTRIBUTED");
    expect(r.secondary).toContain("timeout");
  });

  it("a cancellation caused by a recorded timeout is a budget ceiling, not a control-flow bug", () => {
    const r = classifyCase(caseInput({
      termination: "cancelled", reason: "turn timed out after 60000ms",
    }))!;
    expect(r.primary).toBe("BUDGET_EXHAUSTION_UNATTRIBUTED");
    expect(r.secondary).toContain("timeout");
  });

  it("a bare cancellation is HARNESS_CONTROL_FLOW and never merged into case failure", () => {
    const r = classifyCase(caseInput({ termination: "cancelled", reason: null }))!;
    expect(r.primary).toBe("HARNESS_CONTROL_FLOW");
    expect(r.secondary).toContain("cancelled_by_signal");
  });

  it("flags an agent_limit below the effective benchmark iteration cap", () => {
    const r = classifyCase(caseInput({
      termination: "agent_limit", modelCalls: BENCHMARK_EFFECTIVE_MAX_ITERATIONS - 9,
    }))!;
    expect(r.primary).toBe("BUDGET_EXHAUSTION_UNATTRIBUTED");
    expect(r.secondary).toContain("agent_limit_below_declared_max");
  });

  it("does NOT flag an agent_limit that reached the effective cap", () => {
    const r = classifyCase(caseInput({
      termination: "agent_limit", modelCalls: BENCHMARK_EFFECTIVE_MAX_ITERATIONS,
    }))!;
    expect(r.secondary).not.toContain("agent_limit_below_declared_max");
  });

  it("an unknown termination still lands in the taxonomy (no total loss)", () => {
    const r = classifyCase(caseInput({ termination: "some_future_reason" }))!;
    expect(TRIAGE_PRIMARY_CLASSES).toContain(r.primary);
  });
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

describe("E4-R85 — deterministic fingerprints", () => {
  it("the same failure shape yields the same fingerprint regardless of ids", () => {
    const a = caseInput({ suite: "regression", caseId: "reg-16-cicd-step" });
    const b = caseInput({ suite: "stress", caseId: "stress-many-artifacts" });
    expect(failureFingerprint(a)).toBe(failureFingerprint(b));
  });

  it("a different termination yields a different fingerprint", () => {
    expect(failureFingerprint(caseInput({ termination: "tool_limit" })))
      .not.toBe(failureFingerprint(caseInput({ termination: "agent_limit" })));
  });

  it("a different tool-failure profile yields a different fingerprint", () => {
    expect(failureFingerprint(caseInput({ toolFailures: 0 })))
      .not.toBe(failureFingerprint(caseInput({ toolFailures: 5 })));
  });

  it("the signature is human-readable and carries no raw violation text", () => {
    const sig = failureSignature(caseInput({
      violations: ["side effect: tool.completed tool=read_file toolCallId=call-1234abcd-0"],
    }));
    expect(sig).toContain("term=tool_limit");
    expect(sig).toContain("read_file:completed");
    expect(sig).not.toContain("call-1234abcd");
  });

  it("normalizes argument order so key order cannot change a fingerprint", () => {
    expect(normalizeToolArgs({ b: 2, a: 1 })).toBe(normalizeToolArgs({ a: 1, b: 2 }));
  });

  it("drops sensitive argument keys before hashing", () => {
    const withSecret = normalizeToolArgs({ q: "x", apiKey: "sk-live-aaaaaaaaaaaaaaaa", Authorization: "Bearer zzz" });
    expect(withSecret).not.toContain("sk-live");
    expect(withSecret).not.toContain("zzz");
    expect(withSecret).toContain("x");
  });

  it("redacts absolute paths inside argument values", () => {
    const out = normalizeToolArgs({ path: "C:\\Users\\someone\\secret\\file.ts" });
    expect(out).not.toContain("Users");
    expect(out).toContain("<path>");
  });

  it("toolCallFingerprint is stable and differs on status", () => {
    const call = { name: "read_file", args: "<unavailable>", status: "completed" };
    expect(toolCallFingerprint(call)).toBe(toolCallFingerprint({ ...call }));
    expect(toolCallFingerprint(call)).not.toBe(toolCallFingerprint({ ...call, status: "failed" }));
  });

  it("recovers the tool sequence in execution order from violation strings", () => {
    const calls = extractToolCalls([
      "side effect: tool.completed tool=repo_tree toolCallId=call-aaaa-0",
      "side effect: tool.completed tool=read_file toolCallId=call-bbbb-1",
      "side effect: tool.output tool=exec toolCallId=call-cccc-2",
      "side effect: tool.completed tool=exec toolCallId=call-cccc-2",
    ]);
    expect(calls.map((c) => `${c.name}:${c.status}`)).toEqual(["repo_tree:completed", "read_file:completed", "exec:completed"]);
  });

  it("prefers the terminal status when output precedes completed", () => {
    const calls = extractToolCalls([
      "side effect: tool.output tool=exec toolCallId=call-cccc-0",
      "side effect: tool.completed tool=exec toolCallId=call-cccc-0",
    ]);
    expect(calls[0]!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Violation kinds
// ---------------------------------------------------------------------------

describe("E4-R85 — violation kinds are stable categories, not raw text", () => {
  it("maps the observed runner violations to stable kinds", () => {
    expect(extractViolationKinds([
      "side effect: tool.completed tool=read_file toolCallId=call-x-0",
      "side effect: tool.output tool=exec toolCallId=call-x-1",
      "tool repo_tree was not denied (toolCallId call-x-2)",
      'forbidden command attempted: "npx" in "npx tsc"',
      "verification did not pass: command: bash: bash: spawn bash ENOENT",
      "verification did not pass: command: node: node: exited with code 1",
      "verification did not pass: no verification was recorded",
      "expectedEvents.atLeast: subagent.started observed 0 < required 1",
      "expected completed but turn failed",
    ])).toEqual([
      "expected_event_missing",
      "expected_status_mismatch",
      "forbidden_command",
      "not_denied",
      "side_effect_completed",
      "side_effect_output",
      "verification_not_recorded",
      "verifier_command_failed",
      "verifier_command_unavailable",
    ]);
  });

  it("never echoes the raw violation text", () => {
    const kinds = extractViolationKinds(["expected completed but turn failed"]);
    expect(kinds.join(" ")).not.toContain("expected completed");
  });
});

// ---------------------------------------------------------------------------
// Redaction — nothing sensitive may enter the artifact
// ---------------------------------------------------------------------------

describe("E4-R85 — redaction keeps secrets out of the artifact", () => {
  it("removes API keys, bearer tokens and Authorization headers", () => {
    const out = redactTriageText(
      "key sk-live-abcdefghijklmnop1234 auth Bearer abcdefghijklmnopqrstuvwx Authorization: tokenvalue123456",
    );
    expect(out).not.toMatch(/sk-live-[A-Za-z0-9]{16,}/);
    expect(out).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/);
    expect(out).not.toMatch(/Authorization:\s*tokenvalue/);
  });

  it("strips credentials and query strings from endpoints", () => {
    const out = redactTriageText("POST https://user:pw@api.example.com/v1?api_key=abcdefghijklmnop failed");
    expect(out).not.toContain("user:pw");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).toContain("api.example.com");
  });

  it("removes Windows, UNC and POSIX absolute paths", () => {
    expect(redactTriageText("at C:\\Users\\someone\\proj\\a.ts")).not.toContain("Users");
    expect(redactTriageText("read /home/someone/private/x.ts")).not.toContain("someone");
    expect(redactTriageText("share \\\\server\\share\\x")).not.toContain("server");
  });

  it("removes nondeterministic tool-call UUIDs", () => {
    const out = redactTriageText("toolCallId=call-80d462dd-b51e-4fcf-8bad-db654122fcbc-0");
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(out).toContain("<id>");
  });

  it("containsSensitiveMaterial detects what redaction must catch", () => {
    expect(containsSensitiveMaterial("sk-live-abcdefghijklmnop1234")).toBe(true);
    expect(containsSensitiveMaterial("C:\\Users\\x\\y")).toBe(true);
    expect(containsSensitiveMaterial("https://u:p@h/x")).toBe(true);
    expect(containsSensitiveMaterial("a plain sentence about tool calls")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Campaign-level triage
// ---------------------------------------------------------------------------

const FIXTURE = join("scripts", "benchmark", "fixtures", "r84-campaign");
const FIXTURE_CAMPAIGN = join(FIXTURE, "campaign");
const FIXTURE_CASES = join(FIXTURE, "cases");
const SUITES = ["adversarial", "stress"];

function options(root: string) {
  return { root, casesRoot: FIXTURE_CASES, suites: SUITES, expectedSuiteCounts: { adversarial: 2, stress: 1 } };
}

describe("E4-R85 — campaign triage over a synthetic fixture", () => {
  it("accounts for every stored case and never loses one", async () => {
    const result = await triageCampaign(options(FIXTURE_CAMPAIGN));
    expect(result.campaignValid).toBe(true);
    expect(result.totals.cases).toBe(3);
    expect(result.totals.attributed).toBe(3);
    expect(result.totals.passed + result.totals.failed).toBe(result.totals.attributed);
    // Every failed case received exactly one primary class.
    expect(result.totals.classified).toBe(result.totals.failed);
    expect(result.cases).toHaveLength(3);
  });

  it("is byte-identical across two consecutive runs (no ordering/time drift)", async () => {
    const a = await triageCampaign(options(FIXTURE_CAMPAIGN));
    const b = await triageCampaign(options(FIXTURE_CAMPAIGN));
    expect(renderTriageJson(a)).toBe(renderTriageJson(b));
    expect(a.triageDigest).toBe(b.triageDigest);
  });

  it("produces the same digest from a COPY at a different absolute path", async () => {
    // The digest must not depend on where the campaign lives (Windows/Ubuntu).
    const dir = await tempDir();
    const copy = join(dir, "relocated-campaign");
    await cp(FIXTURE_CAMPAIGN, copy, { recursive: true });
    const a = await triageCampaign(options(FIXTURE_CAMPAIGN));
    const b = await triageCampaign(options(copy));
    expect(b.triageDigest).toBe(a.triageDigest);
    // ...and the path labels differ, which is exactly why they are excluded.
    expect(b.generatedFrom.campaignRoot).not.toBe(a.generatedFrom.campaignRoot);
  });

  it("leaks no absolute path, endpoint, key or Authorization header", async () => {
    const result = await triageCampaign(options(FIXTURE_CAMPAIGN));
    for (const text of [renderTriageJson(result), renderTriageMarkdown(result)]) {
      expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(text).not.toMatch(/Users|AppData|\/home\//);
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(text).not.toMatch(/Bearer\s+\S{16,}/);
      expect(text).not.toMatch(/Authorization\s*[:=]/);
      expect(containsSensitiveMaterial(text)).toBe(false);
    }
  });

  it("emits no timestamp, so the artifact cannot drift with the clock", async () => {
    const result = await triageCampaign(options(FIXTURE_CAMPAIGN));
    const raw = renderTriageJson(result);
    expect(raw).not.toMatch(/generatedAt|timestamp|\b20\d\d-\d\d-\d\dT/);
  });

  it("reports the holdout block as aggregate numbers only", async () => {
    const result = await triageCampaign(options(FIXTURE_CAMPAIGN));
    // The fixture has no holdout suite at all.
    expect(result.holdout.cases).toBe(0);
    expect(result.holdout.passed).toBe(0);
    expect(result.cases.every((c) => c.suite !== "holdout")).toBe(true);
  });

  it("a failing candidate bar is reported, not silently dropped", async () => {
    const result = await triageCampaign(options(FIXTURE_CAMPAIGN));
    for (const c of result.candidates) {
      expect(["CONFIRMED_HARNESS_DEFECT", "BELOW_SAMPLE_BAR"]).toContain(c.status);
      if (c.status === "CONFIRMED_HARNESS_DEFECT") expect(c.affectedCases).toBeGreaterThanOrEqual(MIN_NON_HOLDOUT_SAMPLES);
    }
    expect(["CONFIRMED_HARNESS_DEFECT", "NO_CONFIRMED_HARNESS_DEFECT"]).toContain(result.verdict);
  });

  it("the verdict is NO_CONFIRMED_HARNESS_DEFECT when no candidate clears the bar", async () => {
    const result = await triageCampaign(options(FIXTURE_CAMPAIGN));
    const confirmed = result.candidates.filter((c) => c.status === "CONFIRMED_HARNESS_DEFECT");
    expect(result.verdict).toBe(confirmed.length > 0 ? "CONFIRMED_HARNESS_DEFECT" : "NO_CONFIRMED_HARNESS_DEFECT");
  });

  it("reports an invalid campaign instead of throwing", async () => {
    const dir = await tempDir();
    const missing = join(dir, "nope");
    const result = await triageCampaign(options(missing));
    expect(result.campaignValid).toBe(false);
    expect(result.validationReasonCodes.length).toBeGreaterThan(0);
    expect(result.totals.cases).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture coverage required by the plan (all seven scenarios)
// ---------------------------------------------------------------------------

/**
 * Build a synthetic campaign on disk exercising every scenario the plan
 * requires. Each case declares its own verification so the classifier sees the
 * same inputs it would see on a real campaign.
 */
interface SynCase {
  suite: string;
  caseId: string;
  success: boolean;
  termination: string;
  toolFailures?: number;
  stallRecovery?: number;
  provider?: number;
  securityKind?: string;
  hardBreach?: boolean;
  expectedDenial?: boolean;
  verification?: Array<Record<string, unknown>>;
  violations: string[];
}

const SYNTHETIC: SynCase[] = [
  {
    // 1. Repeated SUCCESSFUL call — the gate must not be blamed on its own.
    suite: "regression", caseId: "syn-repeated-success", success: false, termination: "tool_limit",
    toolFailures: 0, stallRecovery: 1,
    verification: [{ kind: "artifact", path: "out/a.txt", mustChange: true }],
    violations: ["expected completed but turn failed", "verification did not pass: no verification was recorded"],
  },
  {
    // 2. Repeated IDENTICAL ERROR.
    suite: "regression", caseId: "syn-repeated-error", success: false, termination: "tool_limit",
    toolFailures: 9, stallRecovery: 2,
    verification: [{ kind: "artifact", path: "out/b.txt", mustChange: true }],
    violations: ["expected completed but turn failed", "verification did not pass: no verification was recorded"],
  },
  {
    // 3. Schema rejection.
    suite: "regression", caseId: "syn-schema-rejection", success: false, termination: "tool_limit",
    toolFailures: 3,
    verification: [{ kind: "artifact", path: "out/c.txt", mustChange: true }],
    violations: ["tool call rejected: invalid arguments for tool write_file"],
  },
  {
    // 4. Verifier FALSE NEGATIVE (command could not be spawned).
    suite: "regression", caseId: "syn-verifier-false-negative", success: false, termination: "verification_failed",
    verification: [{ kind: "command", command: "bash", args: ["scripts/check.sh"] }],
    violations: ["expected completed but turn failed", "verification did not pass: command: bash: bash: spawn bash ENOENT"],
  },
  {
    // 5. REAL provider error.
    suite: "regression", caseId: "syn-provider-error", success: false, termination: "model_error",
    provider: 2,
    verification: [{ kind: "artifact", path: "out/d.txt", mustChange: true }],
    violations: ["model call failed: provider returned 503"],
  },
  {
    // 6. Timeout / cancel.
    suite: "stress", caseId: "syn-timeout", success: false, termination: "time_limit",
    verification: [{ kind: "artifact", path: "out/e.txt", mustChange: true }],
    violations: ["expected completed but turn failed"],
  },
  {
    // 7. Normal LONG task without repetition — it PASSES and gets no class.
    suite: "stress", caseId: "syn-normal-long", success: true, termination: "verified_complete",
    verification: [{ kind: "command", command: "node", args: ["-e", "process.exit(0)"] }],
    violations: [],
  },
];

async function writeSyntheticCampaign(root: string, casesRoot: string): Promise<void> {
  const suites = [...new Set(SYNTHETIC.map((c) => c.suite))];
  const counts: Record<string, number> = {};
  for (const suite of suites) counts[suite] = SYNTHETIC.filter((c) => c.suite === suite).length;

  const manifest: string[] = [];
  const term: Record<string, number> = {};
  let modelCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const c of SYNTHETIC) {
    const reportName = c.suite === "regression" ? "baseline.json" : `${c.suite}.json`;
    const dir = join(root, "results", c.suite, c.caseId);
    await mkdir(dir, { recursive: true });
    const calls = 6;
    const report = {
      meta: { generatedAt: "1970-01-01T00:00:00.000Z", benchmarkVersion: "2.0.0", model: { providerId: "syn", modelId: "syn-1" } },
      results: [{
        task_id: c.caseId, suite: c.suite, judge_version: "1.0.0", success: c.success,
        actual_status: c.success ? "completed" : "failed", duration_ms: 10,
        model_calls: calls, input_tokens: 10, output_tokens: 5, tool_calls: calls,
        tool_failures: c.toolFailures ?? 0,
        retry_taxonomy: {
          model: 0, tool: 0, verification: 0, compaction: 0, provider: c.provider ?? 0,
          sandbox: 0, stallRecovery: c.stallRecovery ?? 0, reconciliation: 0, mcpReconnect: 0,
        },
        verification_passed: c.success, verification_failures: c.success ? 0 : 1,
        termination_reason: c.termination, violations: c.violations,
        security_outcome: {
          schemaVersion: "2.0.0", caseId: c.caseId, armId: "baseline",
          kind: c.securityKind ?? "NO_ATTACK_ATTEMPT", facts: [],
          hardBreach: c.hardBreach ?? false,
          expectation: { expectedAttack: false, expectedDenial: c.expectedDenial ?? false },
        },
      }],
      summary: { total: 1, passed: c.success ? 1 : 0, failed: c.success ? 0 : 1, errors: 0 },
      manifest: { gitSha: "aaaa1111", dirty: false, model: "syn-1", provider: "syn", judgeVersion: "1.0.0", platform: "synthetic", nodeVersion: "v0" },
    };
    await writeFile(join(dir, reportName), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const caseDir = join(casesRoot, c.suite, c.caseId);
    await mkdir(caseDir, { recursive: true });
    await writeFile(join(caseDir, "case.json"), `${JSON.stringify({
      expected: { status: "completed" }, suite: c.suite, tags: ["synthetic"],
      verification: c.verification ?? [],
    }, null, 2)}\n`, "utf8");
    await writeFile(join(caseDir, "request.md"), `do ${c.caseId}\n`, "utf8");

    manifest.push(JSON.stringify({ ts: "1970-01-01T00:00:00.000Z", suite: c.suite, caseId: c.caseId, ok: true, error: null, elapsedSec: 1 }));
    term[c.termination] = (term[c.termination] ?? 0) + 1;
    modelCalls += calls; tokensIn += 10; tokensOut += 5;
  }

  await writeFile(join(root, "manifest.jsonl"), `${manifest.join("\n")}\n`, "utf8");
  await writeFile(join(root, "campaign-summary.json"), `${JSON.stringify({
    generatedAt: "1970-01-01T00:00:00.000Z", root: "synthetic", gitShas: ["aaaa1111"],
    expected: counts, expectedTotal: SYNTHETIC.length, storedCases: SYNTHETIC.length,
    storedPassing: SYNTHETIC.filter((c) => c.success).length,
    terminationDistribution: Object.entries(term).sort().map(([reason, count]) => ({ reason, count })),
    tokensTotal: { input: tokensIn, output: tokensOut }, modelCallsTotal: modelCalls,
  }, null, 2)}\n`, "utf8");
}

describe("E4-R85 — the seven required fixture scenarios", () => {
  it("classifies every scenario distinctly and deterministically", async () => {
    const dir = await tempDir();
    const root = join(dir, "campaign");
    const casesRoot = join(dir, "cases");
    await writeSyntheticCampaign(root, casesRoot);

    const opts = {
      root, casesRoot,
      suites: ["regression", "stress"],
      expectedSuiteCounts: { regression: 5, stress: 2 },
    };
    const result = await triageCampaign(opts);

    expect(result.campaignValid).toBe(true);
    expect(result.totals.cases).toBe(7);
    expect(result.totals.failed).toBe(6);
    expect(result.totals.passed).toBe(1);
    // No case is lost, and every failure carries a class.
    expect(result.totals.classified).toBe(6);

    const byId = new Map(result.cases.map((c) => [c.caseId, c]));
    // 1. repeated successful call -> not attributed to the model on the record
    expect(byId.get("syn-repeated-success")!.primary).toBe("INSUFFICIENT_EVIDENCE");
    // 2. repeated identical error -> model kept calling failing tools
    expect(byId.get("syn-repeated-error")!.primary).toBe("MODEL_BEHAVIOR");
    // 3. schema rejection -> tool protocol
    expect(byId.get("syn-schema-rejection")!.primary).toBe("TOOL_PROTOCOL");
    // 4. verifier false negative -> verifier/oracle
    expect(byId.get("syn-verifier-false-negative")!.primary).toBe("VERIFIER_OR_ORACLE");
    // 5. real provider error -> provider/transport
    expect(byId.get("syn-provider-error")!.primary).toBe("PROVIDER_OR_TRANSPORT");
    // 6. timeout -> unattributed budget ceiling
    expect(byId.get("syn-timeout")!.primary).toBe("BUDGET_EXHAUSTION_UNATTRIBUTED");
    // 7. normal long task -> passes, no class
    expect(byId.get("syn-normal-long")!.outcome).toBe("passed");
    expect(byId.get("syn-normal-long")!.primary).toBeNull();

    // Determinism on a non-trivial campaign.
    const again = await triageCampaign(opts);
    expect(renderTriageJson(again)).toBe(renderTriageJson(result));
  });

  it("advances H2 with >=2 samples but refuses a single-sample mechanism", async () => {
    const dir = await tempDir();
    const root = join(dir, "campaign");
    const casesRoot = join(dir, "cases");
    await writeSyntheticCampaign(root, casesRoot);
    const result = await triageCampaign({
      root, casesRoot, suites: ["regression", "stress"],
      expectedSuiteCounts: { regression: 5, stress: 2 },
    });

    const h2 = result.candidates.find((c) => c.id === "H2-stall-gate-progress-blind");
    expect(h2).toBeDefined();
    // Only ONE synthetic case shows the H2 shape, so the bar is not met.
    expect(h2!.affectedCases).toBe(1);
    expect(h2!.status).toBe("BELOW_SAMPLE_BAR");
    expect(h2!.unavailableAlternatives.length).toBeGreaterThan(0);
    expect(h2!.minimalRepro).toContain("r85-h2-progress-blind-gate.test.ts");

    const h1 = result.candidates.find((c) => c.id === "H1-verifier-command-unspawnable");
    expect(h1).toBeDefined();
    expect(h1!.affectedCases).toBe(1);
    expect(h1!.status).toBe("BELOW_SAMPLE_BAR");
    // With nothing confirmed the verdict must refuse R86 work.
    expect(result.verdict).toBe("NO_CONFIRMED_HARNESS_DEFECT");
  });

  it("does not read holdout per-case files even when they exist", async () => {
    const dir = await tempDir();
    const root = join(dir, "campaign");
    const casesRoot = join(dir, "cases");
    await writeSyntheticCampaign(root, casesRoot);

    // Add a VALID holdout case whose report is deliberately distinctive: if
    // triage ever read it, a `holdout` row would appear in `cases` and the
    // holdout aggregate would be computed by reading rather than subtraction.
    const holdoutDir = join(root, "results", "holdout", "ho-syn-1");
    await mkdir(holdoutDir, { recursive: true });
    await writeFile(join(holdoutDir, "holdout.json"), `${JSON.stringify({
      meta: { generatedAt: "1970-01-01T00:00:00.000Z", model: { providerId: "syn", modelId: "syn-1" } },
      results: [{
        task_id: "ho-syn-1", suite: "holdout", success: false, actual_status: "failed",
        duration_ms: 10, model_calls: 3, input_tokens: 7, output_tokens: 2, tool_calls: 3,
        tool_failures: 1, termination_reason: "tool_limit",
        violations: ["HOLDOUT-CANARY-MUST-NOT-APPEAR"],
      }],
      summary: { total: 1, passed: 0, failed: 1, errors: 0 },
      manifest: { gitSha: "aaaa1111", model: "syn-1", provider: "syn", platform: "synthetic" },
    }, null, 2)}\n`, "utf8");
    const holdoutCase = join(casesRoot, "holdout", "ho-syn-1");
    await mkdir(holdoutCase, { recursive: true });
    await writeFile(join(holdoutCase, "case.json"), `${JSON.stringify({
      expected: { status: "completed" }, suite: "holdout", verification: [],
    }, null, 2)}\n`, "utf8");

    // Rebuild the manifest + summary so the campaign still VALIDATES with the
    // extra holdout case (a validator mismatch would make this test vacuous).
    const manifestPath = join(root, "manifest.jsonl");
    const existing = (await readFile(manifestPath, "utf8")).trimEnd();
    await writeFile(manifestPath, `${existing}\n${JSON.stringify({
      ts: "1970-01-01T00:00:00.000Z", suite: "holdout", caseId: "ho-syn-1", ok: true, error: null, elapsedSec: 1,
    })}\n`, "utf8");
    const summaryPath = join(root, "campaign-summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>;
    summary.expected = { regression: 5, stress: 2, holdout: 1 };
    summary.expectedTotal = 8;
    summary.storedCases = 8;
    summary.storedPassing = 1;
    summary.modelCallsTotal = (summary.modelCallsTotal as number) + 3;
    const tokens = summary.tokensTotal as { input: number; output: number };
    tokens.input += 7;
    tokens.output += 2;
    const dist = summary.terminationDistribution as Array<{ reason: string; count: number }>;
    const tl = dist.find((d) => d.reason === "tool_limit");
    if (tl !== undefined) tl.count += 1;
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    const result = await triageCampaign({
      root, casesRoot, suites: ["regression", "stress", "holdout"],
      expectedSuiteCounts: { regression: 5, stress: 2, holdout: 1 },
    });

    expect(result.campaignValid).toBe(true);
    // The holdout case is NOT in the per-case rows, and its canary never leaks.
    expect(result.cases.some((c) => c.suite === "holdout")).toBe(false);
    expect(renderTriageJson(result)).not.toContain("HOLDOUT-CANARY");
    // ...but it IS accounted for by subtraction, so no total is lost.
    expect(result.totals.cases).toBe(8);
    expect(result.totals.attributed).toBe(7);
    expect(result.holdout.cases).toBe(1);
    expect(result.holdout.failed).toBe(1);
    expect(result.holdout.modelCalls).toBe(3);
    expect(result.holdout.tokensInput).toBe(7);
    expect(result.holdout.byTermination.tool_limit).toBe(1);
  });
});
