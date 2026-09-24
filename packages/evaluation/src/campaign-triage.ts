/**
 * E4-R85 — offline, zero-provider-call failure attribution for a benchmark
 * campaign.
 *
 * ## What this is
 *
 * `campaign-validate.ts` (R84) answers "are these numbers real?". THIS module
 * answers the next question: "of the cases that failed, which failures are the
 * MODEL's fault and which are the HARNESS's fault?" It reads only what the
 * runner already stored on disk, so it costs nothing and can run in CI.
 *
 * ## The two disciplines that shape every design decision here
 *
 * 1. **HOLDOUT DISCIPLINE.** Plan R85 §3: for the holdout suite we keep
 *    AGGREGATE NUMBERS ONLY — no per-case prompt, no model output, no failure
 *    detail — so triage cannot keep contaminating holdout. This module enforces
 *    that structurally: it never opens a holdout per-case report. The holdout
 *    block is derived by SUBTRACTING the development suites (which we do read)
 *    from the totals the R84 validator already computed. "Do not read" is
 *    implemented as "cannot read", not as "promises not to look".
 *
 * 2. **NO GUESSING.** Plan R85 §1: `INSUFFICIENT_EVIDENCE` is a first-class
 *    verdict, not a failure to classify. The stored artifacts are thin — a
 *    per-case report has counters and violation strings, but NO per-tool-call
 *    sequence, NO arguments and NO post-run artifact state. When the recorded
 *    fields cannot distinguish two explanations, the honest answer is
 *    `INSUFFICIENT_EVIDENCE`, and this module returns it rather than picking the
 *    more flattering story.
 *
 * ## Determinism
 *
 * Plan R85 acceptance requires two consecutive runs over the same campaign to
 * produce byte-identical JSON, and Windows/Ubuntu to agree on the digest. So:
 * every collection is sorted by a stable key, no timestamp is ever emitted, and
 * `triageDigest` covers the ANALYSIS BODY only — deliberately excluding
 * `generatedFrom`, whose path labels legitimately differ across machines.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CampaignValidateOptions,
  CAMPAIGN_SUITE_ORDER,
  campaignReportFileName,
  safePathLabel,
  scanCampaignForSecrets,
  validateCampaign,
} from "./campaign-validate.js";

// ---------------------------------------------------------------------------
// The bounded taxonomy (plan R85 §1)
// ---------------------------------------------------------------------------

/**
 * Mutually exclusive PRIMARY classes. Exactly one is assigned to every failed
 * case, so the counts always sum back to the failure total.
 */
export const TRIAGE_PRIMARY_CLASSES = [
  /** Model kept choosing ineffective/repeated actions; tools and feedback were correct. */
  "MODEL_BEHAVIOR",
  /** Schema, result shape, error feedback or tool selection reproducibly misled the model. */
  "TOOL_PROTOCOL",
  /** The task was satisfied but the verifier/oracle rejected it, or the oracle is inconsistent. */
  "VERIFIER_OR_ORACLE",
  /** State machine, termination, recovery or repeated-call handling is defective. */
  "HARNESS_CONTROL_FLOW",
  /** A budget/time ceiling was hit and nothing yet says WHO caused it. */
  "BUDGET_EXHAUSTION_UNATTRIBUTED",
  /** A real 429/5xx/disconnect/invalid response from the provider. */
  "PROVIDER_OR_TRANSPORT",
  /** A security policy blocked the operation by design. */
  "SECURITY_POLICY_DENIAL",
  /** The recorded trace cannot support any attribution. */
  "INSUFFICIENT_EVIDENCE",
] as const;

export type TriagePrimaryClass = (typeof TRIAGE_PRIMARY_CLASSES)[number];

/** Optional, non-exclusive secondary tags that add actionable detail. */
export const TRIAGE_SECONDARY_TAGS = [
  "stall_gate_termination",
  "stall_recovery_exhausted",
  "tool_failures_present",
  /**
   * R90: tool failures were recorded but nothing says WHO produced them. A tool
   * error can originate in the harness, the environment or a schema, so the
   * failure count alone cannot convict the model.
   */
  "tool_failure_provenance_unknown",
  /** R90: raw events show the repeated call's result CHANGED and the gate fired. */
  "progress_blind_gate_fired",
  /** R90: no per-call result record exists, so progress vs. stall is undecidable. */
  "result_change_unknown",
  "verifier_command_unavailable",
  "verifier_command_failed",
  "verification_not_reached",
  "agent_limit_below_declared_max",
  "cancelled_by_signal",
  "timeout",
  "security_contained",
  "security_escape",
  "security_denial_unexpected",
  "expected_status_mismatch",
  "missing_expected_event",
  "forbidden_command_attempted",
  "not_denied",
] as const;

export type TriageSecondaryTag = (typeof TRIAGE_SECONDARY_TAGS)[number];

/**
 * How a candidate defect is judged against the plan R85 §7 evidence bar.
 * `CONFIRMED_HARNESS_DEFECT` is the ONLY status that may advance to R86.
 */
export type TriageCandidateStatus =
  | "CONFIRMED_HARNESS_DEFECT"
  | "BELOW_SAMPLE_BAR";

/**
 * R90 §1: whether the DEFECT MECHANISM has been reproduced under controlled
 * conditions. This is a fact about the code, provable offline with a
 * deterministic reproducer, and it is INDEPENDENT of whether any historical
 * campaign case was actually affected by it.
 */
export type TriageMechanismStatus =
  | "MECHANISM_REPRODUCED"
  | "MECHANISM_NOT_REPRODUCED"
  | "UNKNOWN";

/**
 * R90 §1: whether recorded per-case EVENTS prove a historical case was hit.
 * A case that merely matches the candidate's aggregate feature is a
 * `CANDIDATE_ONLY`; only raw events (the result actually changed AND the gate
 * fired) may promote it to `CONFIRMED_AFFECTED`. When the events are absent
 * from the stored artifact the honest answer is `UNKNOWN`.
 */
export type TriageCaseAttributionStatus =
  | "CONFIRMED_AFFECTED"
  | "CANDIDATE_ONLY"
  | "UNKNOWN";

/** The plan's fixed agent-limit values, used to detect a counting mismatch. */
export const BENCHMARK_EFFECTIVE_MAX_ITERATIONS = 30;

/** Minimum non-holdout samples a candidate needs before it may advance (plan §7). */
export const MIN_NON_HOLDOUT_SAMPLES = 2;

// ---------------------------------------------------------------------------
// Redaction — nothing sensitive may enter the artifact (plan R85 acceptance)
// ---------------------------------------------------------------------------

const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  // Windows drive path, e.g. C:\Users\x or D:/work
  /\b[A-Za-z]:[\\/][^\s"',;)\]]*/g,
  // UNC path
  /\\\\[^\s"',;)\]]+/g,
  // POSIX home/absolute path
  /(?:^|[\s"'(=])\/(?:home|Users|root|tmp|var|opt|mnt)\/[^\s"',;)\]]*/g,
];

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Redact everything that must never reach a committed artifact: API keys,
 * Authorization headers, credentialed/query-bearing endpoints, absolute paths
 * and nondeterministic ids. Applied BEFORE any hashing, so a fingerprint is a
 * hash of redacted content only (plan R85 §6).
 */
export function redactTriageText(text: string): string {
  let out = text;
  for (const re of ABSOLUTE_PATH_PATTERNS) out = out.replace(re, (m) => (/^[\s"'(=]/.test(m) ? m[0] : "") + "<path>");
  out = out.replace(UUID_PATTERN, "<id>");
  // Reuse the validator's secret patterns, plus the shapes specific to a URL.
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<redacted-key>");
  out = out.replace(/([Bb]earer)\s+[A-Za-z0-9._-]{16,}/g, "$1 <redacted>");
  out = out.replace(/([Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]\s*[:=]\s*)\S{12,}/g, "$1<redacted>");
  out = out.replace(/([Aa]uthorization\s*[:=]\s*)\S{12,}/g, "$1<redacted>");
  // Strip credentials and query strings from any URL, keeping only scheme+host.
  out = out.replace(/https?:\/\/[^\s"',;)\]]+/g, (url) => {
    const schemeEnd = url.indexOf("://") + 3;
    const rest = url.slice(schemeEnd);
    const host = rest.split(/[/?#]/)[0] ?? "";
    const safeHost = host.includes("@") ? host.slice(host.lastIndexOf("@") + 1) : host;
    return `${url.slice(0, schemeEnd)}${safeHost}/<redacted-url>`;
  });
  out = out.replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[A-Za-z0-9._-]{12,}/gi, "$1<redacted>");
  return out;
}

/** True when the text still carries something that must not be committed. */
export function containsSensitiveMaterial(text: string): boolean {
  if (scanCampaignForSecrets(text).length > 0) return true;
  if (ABSOLUTE_PATH_PATTERNS.some((re) => new RegExp(re.source).test(text))) return true;
  if (/https?:\/\/[^\s"',;)\]]*@/.test(text)) return true;
  if (/[?&](?:api[_-]?key|access[_-]?token|token)=[A-Za-z0-9._-]{12,}/i.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Deterministic fingerprint (plan R85 §6)
// ---------------------------------------------------------------------------

/** One recorded tool call, reduced to the dimensions we can actually observe. */
export interface NormalizedToolCall {
  /** Semantic tool name, e.g. `read_file`. */
  name: string;
  /**
   * Canonicalized, REDACTED argument text. Stored per-case reports do not carry
   * tool arguments, so this is `"<unavailable>"` on the real campaign path; the
   * synthetic fixtures exercise the real canonicalization.
   */
  args: string;
  /** Result status: `completed` | `output` | `not_denied` | `failed`. */
  status: string;
}

/**
 * Canonicalize an argument record: drop sensitive keys entirely, sort the rest
 * by key, and stringify deterministically so `{a:1,b:2}` and `{b:2,a:1}` hash
 * alike.
 */
export function normalizeToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "<unavailable>";
  const sensitive = /^(?:api[_-]?key|authorization|token|secret|password|credential|env|headers?)$/i;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        if (sensitive.test(key)) continue;
        out[key] = walk((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    if (typeof value === "string") return redactTriageText(value);
    return value;
  };
  return JSON.stringify(walk(args));
}

/**
 * Recover the observable tool-call sequence from a case's violation strings.
 *
 * The runner records side effects and denials as text, embedding the tool name
 * and the originating `toolCallId` (which ends in the call's index within the
 * turn). That index is the only ordering signal stored, so it is what we use.
 * Returns the calls in execution order.
 */
export function extractToolCalls(violations: readonly string[]): NormalizedToolCall[] {
  const byIndex = new Map<number, NormalizedToolCall>();
  const add = (index: number, name: string, status: string): void => {
    const prior = byIndex.get(index);
    // `output` precedes `completed` for the same call; keep the terminal status.
    if (prior === undefined || prior.status === "output") byIndex.set(index, { name, args: "<unavailable>", status });
  };
  for (const raw of violations) {
    const v = redactTriageText(raw);
    let m = /^side effect: tool\.completed tool=([A-Za-z0-9_.:-]+) toolCallId=.*-(\d+)$/.exec(v);
    if (m !== null) { add(Number(m[2]), m[1]!, "completed"); continue; }
    m = /^side effect: tool\.output tool=([A-Za-z0-9_.:-]+) toolCallId=.*-(\d+)$/.exec(v);
    if (m !== null) { add(Number(m[2]), m[1]!, "output"); continue; }
    m = /^tool ([A-Za-z0-9_.:-]+) was not denied \(toolCallId .*-(\d+)\)$/.exec(v);
    if (m !== null) { add(Number(m[2]), m[1]!, "not_denied"); continue; }
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

/** The violation strings reduced to stable, redacted KINDS (never raw text). */
export function extractViolationKinds(violations: readonly string[]): string[] {
  const kinds = new Set<string>();
  for (const raw of violations) {
    const v = redactTriageText(raw);
    if (/^side effect: tool\.output\b/.test(v)) kinds.add("side_effect_output");
    else if (/^side effect: tool\.completed\b/.test(v)) kinds.add("side_effect_completed");
    else if (/was not denied/.test(v)) kinds.add("not_denied");
    else if (/forbidden command attempted/.test(v)) kinds.add("forbidden_command");
    else if (/forbidden network/.test(v)) kinds.add("forbidden_network");
    else if (/forbidden read/.test(v)) kinds.add("forbidden_read");
    else if (/verification did not pass: command: \S+: \S+: spawn \S+ ENOENT/.test(v)) kinds.add("verifier_command_unavailable");
    else if (/verification did not pass: command:/.test(v)) kinds.add("verifier_command_failed");
    else if (/no verification was recorded/.test(v)) kinds.add("verification_not_recorded");
    else if (/expectedEvents/.test(v)) kinds.add("expected_event_missing");
    else if (/expected .* but turn/.test(v)) kinds.add("expected_status_mismatch");
    else if (/false complete/i.test(v)) kinds.add("false_complete");
    else kinds.add("other");
  }
  return [...kinds].sort();
}

/**
 * A stable signature for "the same failure, semantically". Built ONLY from
 * redacted tool names + result statuses + violation kinds + termination, so two
 * cases that failed the same way share one fingerprint even if their ids, paths
 * or call counts differ (plan R85 §6).
 */
export function failureSignature(input: TriageCaseInput): string {
  const calls = extractToolCalls(input.violations).map((c) => `${c.name}:${c.status}`).join(",");
  return [
    `term=${input.termination}`,
    `verify=${input.verificationPassed === true ? "passed" : "not_passed"}`,
    `tool_failures=${input.toolFailures === 0 ? "none" : "some"}`,
    // R90: the TRAJECTORY is part of the failure shape. Two runs with identical
    // aggregate counters but opposite result-change evidence are different
    // failures and must not share a fingerprint.
    `result_change=${input.resultChangeEvidence ?? "unknown"}`,
    `tool_feedback=${input.toolFailureFeedback ?? "unknown"}`,
    `calls=[${calls}]`,
    `kinds=[${extractViolationKinds(input.violations).join(",")}]`,
  ].join("|");
}

/** SHA-256 of the signature: the stable, comparable failure fingerprint. */
export function failureFingerprint(input: TriageCaseInput): string {
  return sha256Hex(failureSignature(input));
}

/** Stable fingerprint of a single normalized tool call (name + args + status). */
export function toolCallFingerprint(call: NormalizedToolCall): string {
  return sha256Hex(`${call.name}\u0000${call.args}\u0000${call.status}`).slice(0, 32);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Case input / output
// ---------------------------------------------------------------------------

/** The recorded facts about one case that triage is allowed to reason from. */
export interface TriageCaseInput {
  suite: string;
  caseId: string;
  /** Case-level: the harness verified the task as complete. */
  success: boolean;
  /** `completed` | `failed` | `cancelled` | ... as recorded. */
  actualStatus: string | null;
  /** From the versioned case source (`expected.status`). */
  expectedStatus: string | null;
  termination: string;
  modelCalls: number | null;
  toolCalls: number | null;
  toolFailures: number | null;
  verificationPassed: boolean | null;
  verificationFailures: number | null;
  /** `artifact` | `command` | ... — what the case's verifier checks. */
  verificationKinds: readonly string[];
  /** Verifier command names declared by the case source (never their output). */
  verificationCommands: readonly string[];
  retryProvider: number;
  retryTool: number;
  retryVerification: number;
  stallRecovery: number;
  /**
   * R90 §1: what the RAW per-call events say about the repeated call's result.
   * `"changed"` means the same call+args returned a DIFFERENT result (observable
   * progress), `"unchanged"` means a genuinely constant result, and `null` (the
   * real-campaign default) means the stored artifact carries no such event at
   * all. Aggregate counters cannot substitute for this: two runs with identical
   * counters but opposite trajectories must NOT receive one causal conclusion.
   */
  resultChangeEvidence: "changed" | "unchanged" | null;
  /**
   * R90 §3: whether the recorded events prove the model SAW correct, actionable
   * feedback for its tool failures. Only then may a tool failure be attributed
   * to the model's choice rather than to the harness/environment/schema.
   */
  toolFailureFeedback: "tool_error_reported" | null;
  securityKind: string | null;
  securityHardBreach: boolean;
  /** The case's own expectation flags, when recorded. */
  expectedAttack: boolean | null;
  expectedDenial: boolean | null;
  /** Redaction-safe free text the runner recorded (may be a bounding note). */
  reason: string | null;
  violations: readonly string[];
  artifactSha256: string;
}

export interface TriageCaseRow {
  suite: string;
  caseId: string;
  outcome: "passed" | "failed";
  primary: TriagePrimaryClass | null;
  secondary: TriageSecondaryTag[];
  fingerprint: string;
  termination: string;
  verificationPassed: boolean | null;
  modelCalls: number | null;
  toolCalls: number | null;
  toolFailures: number | null;
  stallRecovery: number;
  /** R90: the recorded trajectory fact, or null when no event was stored. */
  resultChangeEvidence: "changed" | "unchanged" | null;
  /** R90: whether recorded feedback proved the model saw correct errors. */
  toolFailureFeedback: "tool_error_reported" | null;
  securityKind: string | null;
  /** Redacted violation KINDS only — never the raw strings. */
  violationKinds: string[];
  /** Ordered, redacted tool-name:status sequence. */
  toolSequence: string[];
  artifactSha256: string;
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/** A verifier command that could not be spawned at all: a proven false negative. */
const SPAWN_FAILURE = /verification did not pass: command: (\S+): \1: spawn \1 ENOENT/;

/** Markers that a tool CONTRACT (not the model) misled the caller. */
const TOOL_PROTOCOL_MARKERS: readonly RegExp[] = [
  /invalid arguments/i,
  /schema (?:validation|rejection|mismatch)/i,
  /unexpected (?:argument|property)/i,
  /tool (?:rejected|refused) the call/i,
  /missing required (?:argument|property)/i,
];

export interface TriageClassification {
  primary: TriagePrimaryClass;
  secondary: TriageSecondaryTag[];
}

/**
 * Assign exactly one primary class plus optional secondary tags to a FAILED
 * case.
 *
 * The rules are ordered by how CONCLUSIVE the evidence is: a recorded provider
 * error or a proven unspawnable verifier outranks a generic budget ceiling, and
 * anything the stored fields genuinely cannot separate falls through to
 * `INSUFFICIENT_EVIDENCE` rather than to the more flattering story.
 *
 * Passing cases are not attributed (`null`): a taxonomy of FAILURE causes has
 * nothing to say about a success, and attributing them would inflate a class
 * with unrelated cases.
 */
export function classifyCase(input: TriageCaseInput): TriageClassification | null {
  if (input.success) return null;

  const violationText = input.violations.map(redactTriageText).join("\n");
  const has = (re: RegExp): boolean => re.test(violationText);
  const secondary: TriageSecondaryTag[] = [];
  const add = (tag: TriageSecondaryTag): void => { if (!secondary.includes(tag)) secondary.push(tag); };

  // --- Evidence that names a cause outright --------------------------------

  // A real provider/transport error (429/5xx/disconnect/invalid response).
  if (input.termination === "model_error" || input.retryProvider > 0) {
    return { primary: "PROVIDER_OR_TRANSPORT", secondary };
  }

  // A security boundary that FAILED to hold. Isolation is harness-owned.
  if (input.securityHardBreach || input.securityKind === "ESCAPE") {
    add("security_escape");
    return { primary: "HARNESS_CONTROL_FLOW", secondary };
  }
  // A policy denial the case did NOT expect blocked work the case required.
  if (input.securityKind === "CONTAINED" && input.expectedDenial === false) {
    add("security_denial_unexpected");
    return { primary: "SECURITY_POLICY_DENIAL", secondary };
  }
  if (input.securityKind === "CONTAINED") add("security_contained");

  // The verifier process could not be started: the task was rejected without
  // ever being checked. This is a verifier/oracle defect, not a model failure.
  if (SPAWN_FAILURE.test(violationText) || has(/spawn \S+ ENOENT/)) {
    add("verifier_command_unavailable");
    return { primary: "VERIFIER_OR_ORACLE", secondary };
  }

  // A tool-contract marker means the TOOL misled the caller: schema, result
  // shape or error feedback was reproducible and wrong.
  if (TOOL_PROTOCOL_MARKERS.some(has)) return { primary: "TOOL_PROTOCOL", secondary };

  // --- Ceilings: we know one was hit, we do NOT know who caused it ---------

  if (input.termination === "time_limit") {
    add("timeout");
    return { primary: "BUDGET_EXHAUSTION_UNATTRIBUTED", secondary };
  }
  if (input.termination === "cancelled") {
    if (input.reason !== null && /timed out|timeout/i.test(input.reason)) {
      add("timeout");
      return { primary: "BUDGET_EXHAUSTION_UNATTRIBUTED", secondary };
    }
    add("cancelled_by_signal");
    return { primary: "HARNESS_CONTROL_FLOW", secondary };
  }
  if (input.termination === "agent_limit") {
    // The benchmark sets only maxToolCalls/maxDurationMs. An iteration-cap
    // termination while model_calls sits BELOW the effective 30 means the
    // model-call / iteration boundary is worth re-checking, so name it.
    if (input.modelCalls !== null && input.modelCalls < BENCHMARK_EFFECTIVE_MAX_ITERATIONS) {
      add("agent_limit_below_declared_max");
    }
    return { primary: "BUDGET_EXHAUSTION_UNATTRIBUTED", secondary };
  }

  // --- The stall gate -----------------------------------------------------
  if (input.termination === "tool_limit") {
    add("stall_gate_termination");
    if (input.stallRecovery > 0) add("stall_recovery_exhausted");
    if (input.toolFailures !== null && input.toolFailures > 0) {
      add("tool_failures_present");
      // R90 §3 (F6): a recorded tool FAILURE is not, by itself, evidence that
      // the MODEL chose wrongly. The error may have originated in the harness,
      // the environment or a schema, and the model may never have received
      // usable feedback. Convicting the model requires the recorded event that
      // shows correct, actionable feedback was actually surfaced.
      if (input.toolFailureFeedback === "tool_error_reported") {
        return { primary: "MODEL_BEHAVIOR", secondary };
      }
      add("tool_failure_provenance_unknown");
      return { primary: "INSUFFICIENT_EVIDENCE", secondary };
    }
    // NOT ONE tool call failed, yet the run was stopped for "repeating work".
    // Two explanations fit the same aggregate counters, and only RAW EVENTS can
    // separate them:
    //   (a) the model repeated an identical call whose result never changed
    //       (a genuine stall -> MODEL_BEHAVIOR), or
    //   (b) the model repeated an identical call whose result DID change
    //       (observable progress -> a false positive of the identical-call gate).
    // R90 §2: identical aggregates with different trajectories must NOT be
    // forced into the same conclusion, so the trajectory is read explicitly.
    if (input.resultChangeEvidence === "changed") {
      add("progress_blind_gate_fired");
      return { primary: "HARNESS_CONTROL_FLOW", secondary };
    }
    if (input.resultChangeEvidence === "unchanged") {
      // The result genuinely never changed: the gate's premise held, and the
      // model kept repeating a no-op. That IS a model-behaviour failure.
      add("verification_not_reached");
      return { primary: "MODEL_BEHAVIOR", secondary };
    }
    // Per-case reports carry no per-call result record, so guessing here would
    // be exactly the fabrication R85 forbids. The mechanism itself is examined
    // separately as a candidate, where it can be proven with a reproducer.
    add("result_change_unknown");
    add("verification_not_reached");
    return { primary: "INSUFFICIENT_EVIDENCE", secondary };
  }

  // --- The verifier ran and rejected --------------------------------------
  if (input.termination === "verification_failed") {
    if (has(/no verification was recorded/)) add("verification_not_reached");
    else add("verifier_command_failed");
    // "the command exited 1" is consistent BOTH with a wrong artifact and with
    // a fragile oracle. The post-run artifact state that would decide it is not
    // stored, so this stays un-attributed rather than being blamed on the model.
    return { primary: "INSUFFICIENT_EVIDENCE", secondary };
  }

  if (has(/expectedEvents/)) add("missing_expected_event");
  if (has(/expected .* but turn/)) add("expected_status_mismatch");
  if (has(/forbidden command attempted/)) add("forbidden_command_attempted");
  if (has(/was not denied/)) add("not_denied");
  return { primary: "INSUFFICIENT_EVIDENCE", secondary };
}

// ---------------------------------------------------------------------------
// The campaign-level triage
// ---------------------------------------------------------------------------

export interface TriageTotals {
  /** Cases the campaign declares across every suite, including holdout. */
  cases: number;
  /** Cases in the suites we attribute per-case. */
  attributed: number;
  passed: number;
  failed: number;
  /** Failed cases that received a primary class. */
  classified: number;
  /** Failed cases whose evidence could not support any attribution. */
  insufficientEvidence: number;
  byPrimaryClass: Record<string, number>;
  byTermination: Record<string, number>;
}

export interface HoldoutAggregate {
  /**
   * AGGREGATE ONLY (plan R85 §3). Derived by subtracting the development
   * suites from the validator's totals, so no holdout per-case file is read.
   */
  cases: number;
  passed: number;
  failed: number;
  byTermination: Record<string, number>;
  modelCalls: number;
  toolCalls: number;
  tokensInput: number;
  tokensOutput: number;
}

export interface TriageFingerprint {
  fingerprint: string;
  signature: string;
  primary: TriagePrimaryClass;
  caseCount: number;
  /** Sorted `suite/caseId` labels, capped so one class cannot bloat the file. */
  sampleCases: string[];
}

export interface TriageCandidate {
  id: string;
  fingerprint: string;
  primary: TriagePrimaryClass;
  status: TriageCandidateStatus;
  /**
   * R90 §1: the DEFECT MECHANISM was reproduced under controlled conditions.
   * This is a property of the code and is proven offline, independently of any
   * historical campaign case.
   */
  mechanismStatus: TriageMechanismStatus;
  /**
   * R90 §1: whether recorded per-case EVENTS prove a historical case was hit.
   * NEVER inferred from `affectedCases` (which counts candidates, not victims).
   */
  caseAttributionStatus: TriageCaseAttributionStatus;
  /** Artifacts that justify `mechanismStatus` (reproducers, source paths). */
  evidenceRefs: string[];
  /**
   * R90 §1: development cases matching the candidate FEATURE. A match is a
   * hypothesis, not a diagnosis — repeated reads of unchanged content satisfy
   * the same aggregate shape.
   */
  candidateCases: string[];
  /**
   * R90 §1: the subset of `candidateCases` whose RAW EVENTS actually prove the
   * defect fired. Empty whenever the stored artifacts lack those events.
   */
  confirmedAffectedCases: string[];
  /** How many development (non-holdout) cases show this exact failure shape. */
  affectedCases: number;
  samples: string[];
  sharedPattern: string;
  /** A case with a superficially similar shape that must NOT be attributed here. */
  counterexample: string;
  minimalRepro: string;
  fixLayer: string;
  /** Explanations the recorded evidence rules out. */
  unavailableAlternatives: string[];
}

export type TriageVerdict = "CONFIRMED_HARNESS_DEFECT" | "NO_CONFIRMED_HARNESS_DEFECT";

export interface TriageResult {
  /**
   * R90: bumped 1 -> 2. The taxonomy no longer equates a tool failure with a
   * model-behaviour error, and each candidate now separates the reproduced
   * MECHANISM from confirmed HISTORICAL case attribution. Consumers must not
   * read a v2 file as v1: the same evidence can legitimately yield different
   * candidate counts.
   */
  schemaVersion: 2;
  kind: "campaign-triage";
  generatedFrom: { campaignRoot: string; casesRoot: string };
  rootDigest: string;
  campaignValid: boolean;
  validationReasonCodes: string[];
  totals: TriageTotals;
  holdout: HoldoutAggregate;
  /** Development-suite cases only. NEVER contains a holdout row. */
  cases: TriageCaseRow[];
  fingerprints: TriageFingerprint[];
  candidates: TriageCandidate[];
  verdict: TriageVerdict;
  /** sha256 over the analysis body (excludes `generatedFrom` and itself). */
  triageDigest: string;
}

export interface TriageOptions extends CampaignValidateOptions {
  /**
   * Suites whose per-case detail must never be emitted or read for attribution.
   * Defaults to `["holdout"]`.
   */
  restrictedSuites?: readonly string[];
}

const DEFAULT_RESTRICTED_SUITES: readonly string[] = ["holdout"];
const SAMPLE_CAP = 8;

interface RawResultRecord {
  success?: unknown;
  actual_status?: unknown;
  termination_reason?: unknown;
  model_calls?: unknown;
  tool_calls?: unknown;
  tool_failures?: unknown;
  verification_passed?: unknown;
  verification_failures?: unknown;
  retry_taxonomy?: Record<string, unknown>;
  security_outcome?: {
    kind?: unknown;
    hardBreach?: unknown;
    expectation?: { expectedAttack?: unknown; expectedDenial?: unknown };
  };
  reason?: unknown;
  violations?: unknown;
  /**
   * R90: optional RAW per-call evidence. Absent from every stored R83 report
   * (and from the fixture), which is exactly why historical attribution is
   * reported as UNKNOWN rather than inferred from aggregate counters.
   */
  result_change_evidence?: unknown;
  tool_failure_feedback?: unknown;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function retryCount(retry: Record<string, unknown> | undefined, key: string): number {
  const v = retry?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Read what the versioned case source DECLARES: the verification check kinds,
 * the verifier command NAMES (never their output) and the expected status.
 * Called for development suites only — a restricted suite is skipped before
 * this point, so no holdout case source is ever opened.
 */
async function loadCaseDeclarations(
  casesRoot: string,
  suite: string,
  caseId: string,
): Promise<{ kinds: string[]; commands: string[]; expectedStatus: string | null }> {
  try {
    const raw = await readFile(join(casesRoot, suite, caseId, "case.json"), "utf8");
    const doc = JSON.parse(raw) as { verification?: unknown; expected?: unknown };
    const checks = Array.isArray(doc.verification) ? doc.verification : [];
    const kinds = new Set<string>();
    const commands = new Set<string>();
    for (const c of checks) {
      if (c === null || typeof c !== "object") continue;
      const kind = (c as Record<string, unknown>).kind;
      if (typeof kind === "string") kinds.add(kind);
      const command = (c as Record<string, unknown>).command;
      if (typeof command === "string" && command !== "") commands.add(command);
    }
    const expected = doc.expected !== null && typeof doc.expected === "object"
      ? (doc.expected as Record<string, unknown>).status
      : undefined;
    return {
      kinds: [...kinds].sort(),
      commands: [...commands].sort(),
      expectedStatus: typeof expected === "string" ? expected : null,
    };
  } catch {
    return { kinds: [], commands: [], expectedStatus: null };
  }
}

/**
 * Run the full triage. Never throws for a bad campaign: it reports
 * `campaignValid: false` with the validator's reason codes so the caller can
 * fail closed without a stack trace.
 */
export async function triageCampaign(options: TriageOptions): Promise<TriageResult> {
  const root = options.root;
  const casesRoot = options.casesRoot ?? "benchmarks";
  const restricted = new Set(options.restrictedSuites ?? DEFAULT_RESTRICTED_SUITES);
  const validation = await validateCampaign(options);

  // Group the validator's totals by suite so the holdout block can be derived
  // by subtraction instead of by reading holdout files.
  const cases: TriageCaseRow[] = [];
  const attributedTerminations: Record<string, number> = {};
  let attributedModelCalls = 0;
  let attributedToolCalls = 0;
  let attributedTokensIn = 0;
  let attributedTokensOut = 0;

  for (const record of validation.cases) {
    if (restricted.has(record.suite)) continue;
    const reportPath = join(root, "results", record.suite, record.caseId, campaignReportFileName(record.suite));
    let doc: { results?: unknown };
    try {
      doc = JSON.parse(await readFile(reportPath, "utf8")) as { results?: unknown };
    } catch {
      // The validator already reported the unreadable artifact; do not invent a row.
      continue;
    }
    const first = Array.isArray(doc.results) ? doc.results[0] : undefined;
    if (first === null || typeof first !== "object") continue;
    const r = first as RawResultRecord;
    const declared = await loadCaseDeclarations(casesRoot, record.suite, record.caseId);
    const violations = Array.isArray(r.violations)
      ? r.violations.filter((v): v is string => typeof v === "string").map(redactTriageText)
      : [];
    const input: TriageCaseInput = {
      suite: record.suite,
      caseId: record.caseId,
      success: r.success === true,
      actualStatus: typeof r.actual_status === "string" ? r.actual_status : null,
      expectedStatus: declared.expectedStatus,
      termination: typeof r.termination_reason === "string" ? r.termination_reason : "not_recorded",
      modelCalls: num(r.model_calls),
      toolCalls: num(r.tool_calls),
      toolFailures: num(r.tool_failures),
      verificationPassed: typeof r.verification_passed === "boolean" ? r.verification_passed : null,
      verificationFailures: num(r.verification_failures),
      verificationKinds: declared.kinds,
      verificationCommands: declared.commands,
      retryProvider: retryCount(r.retry_taxonomy, "provider"),
      retryTool: retryCount(r.retry_taxonomy, "tool"),
      retryVerification: retryCount(r.retry_taxonomy, "verification"),
      stallRecovery: retryCount(r.retry_taxonomy, "stallRecovery"),
      securityKind: typeof r.security_outcome?.kind === "string" ? r.security_outcome.kind : null,
      securityHardBreach: r.security_outcome?.hardBreach === true,
      expectedAttack: typeof r.security_outcome?.expectation?.expectedAttack === "boolean"
        ? r.security_outcome.expectation.expectedAttack : null,
      expectedDenial: typeof r.security_outcome?.expectation?.expectedDenial === "boolean"
        ? r.security_outcome.expectation.expectedDenial : null,
      reason: typeof r.reason === "string" && r.reason !== "" ? redactTriageText(r.reason) : null,
      violations,
      resultChangeEvidence:
        r.result_change_evidence === "changed" || r.result_change_evidence === "unchanged"
          ? r.result_change_evidence : null,
      toolFailureFeedback:
        r.tool_failure_feedback === "tool_error_reported" ? "tool_error_reported" : null,
      artifactSha256: record.artifactSha256,
    };
    const classification = classifyCase(input);
    const calls = extractToolCalls(violations);
    cases.push({
      suite: input.suite,
      caseId: input.caseId,
      outcome: input.success ? "passed" : "failed",
      primary: classification?.primary ?? null,
      secondary: classification?.secondary ?? [],
      fingerprint: failureFingerprint(input),
      termination: input.termination,
      verificationPassed: input.verificationPassed,
      modelCalls: input.modelCalls,
      toolCalls: input.toolCalls,
      toolFailures: input.toolFailures,
      stallRecovery: input.stallRecovery,
      resultChangeEvidence: input.resultChangeEvidence,
      toolFailureFeedback: input.toolFailureFeedback,
      securityKind: input.securityKind,
      violationKinds: extractViolationKinds(violations),
      toolSequence: calls.map((c) => `${c.name}:${c.status}`),
      artifactSha256: record.artifactSha256,
    });

    attributedTerminations[input.termination] = (attributedTerminations[input.termination] ?? 0) + 1;
    attributedModelCalls += input.modelCalls ?? 0;
    attributedToolCalls += input.toolCalls ?? 0;
    attributedTokensIn += record.tokensInput ?? 0;
    attributedTokensOut += record.tokensOutput ?? 0;
  }

  cases.sort((a, b) => (a.suite === b.suite ? a.caseId.localeCompare(b.caseId) : a.suite.localeCompare(b.suite)));

  const failedRows = cases.filter((c) => c.outcome === "failed");
  const byPrimaryClass: Record<string, number> = {};
  for (const cls of TRIAGE_PRIMARY_CLASSES) byPrimaryClass[cls] = 0;
  for (const row of failedRows) if (row.primary !== null) byPrimaryClass[row.primary] = (byPrimaryClass[row.primary] ?? 0) + 1;

  const summary = validation.summary;
  const holdoutTerminations: Record<string, number> = {};
  for (const [reason, count] of Object.entries(summary.terminationReasons)) {
    const dev = attributedTerminations[reason] ?? 0;
    if (count - dev > 0) holdoutTerminations[reason] = count - dev;
  }
  const holdoutCases = summary.storedCases - cases.length;

  const totals: TriageTotals = {
    cases: summary.storedCases,
    attributed: cases.length,
    passed: cases.filter((c) => c.outcome === "passed").length,
    failed: failedRows.length,
    classified: failedRows.filter((c) => c.primary !== null).length,
    insufficientEvidence: byPrimaryClass.INSUFFICIENT_EVIDENCE ?? 0,
    byPrimaryClass: sortedRecord(byPrimaryClass),
    byTermination: sortedRecord(attributedTerminations),
  };

  const holdout: HoldoutAggregate = {
    cases: holdoutCases,
    passed: summary.passed - totals.passed,
    failed: summary.failed - totals.failed,
    byTermination: sortedRecord(holdoutTerminations),
    modelCalls: summary.modelCalls - attributedModelCalls,
    toolCalls: summary.toolCalls - attributedToolCalls,
    tokensInput: summary.tokensInput - attributedTokensIn,
    tokensOutput: summary.tokensOutput - attributedTokensOut,
  };

  const fingerprints = buildFingerprints(failedRows);
  const candidates = buildCandidates(failedRows);
  const verdict: TriageVerdict = candidates.some((c) => c.status === "CONFIRMED_HARNESS_DEFECT")
    ? "CONFIRMED_HARNESS_DEFECT"
    : "NO_CONFIRMED_HARNESS_DEFECT";

  const body = {
    schemaVersion: 2 as const,
    kind: "campaign-triage" as const,
    rootDigest: validation.rootDigest,
    campaignValid: validation.ok,
    validationReasonCodes: validation.reasonCodes,
    totals,
    holdout,
    cases,
    fingerprints,
    candidates,
    verdict,
  };
  return {
    ...body,
    generatedFrom: {
      campaignRoot: safePathLabel(root),
      casesRoot: safePathLabel(casesRoot),
    },
    triageDigest: triageDigestOf(body),
  };
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
}

function buildFingerprints(rows: readonly TriageCaseRow[]): TriageFingerprint[] {
  const groups = new Map<string, TriageCaseRow[]>();
  for (const row of rows) {
    const list = groups.get(row.fingerprint);
    if (list === undefined) groups.set(row.fingerprint, [row]);
    else list.push(row);
  }
  const out: TriageFingerprint[] = [];
  for (const [fingerprint, group] of groups) {
    const first = group[0]!;
    out.push({
      fingerprint,
      signature: signatureFromRow(first),
      primary: first.primary ?? "INSUFFICIENT_EVIDENCE",
      caseCount: group.length,
      sampleCases: group.map((r) => `${r.suite}/${r.caseId}`).sort().slice(0, SAMPLE_CAP),
    });
  }
  return out.sort((a, b) => (b.caseCount - a.caseCount) || a.fingerprint.localeCompare(b.fingerprint));
}

/** Rebuild the human-readable signature from a row (rows store only the hash). */
function signatureFromRow(row: TriageCaseRow): string {
  return [
    `term=${row.termination}`,
    `verify=${row.verificationPassed === true ? "passed" : "not_passed"}`,
    `tool_failures=${row.toolFailures === 0 ? "none" : "some"}`,
    `result_change=${row.resultChangeEvidence ?? "unknown"}`,
    `tool_feedback=${row.toolFailureFeedback ?? "unknown"}`,
    `calls=[${row.toolSequence.join(",")}]`,
    `kinds=[${row.violationKinds.join(",")}]`,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Candidate selection — the plan R85 §7 evidence bar
// ---------------------------------------------------------------------------

/**
 * Candidate evidence packs (plan R85 §7).
 *
 * Detection is MECHANISM-based, deliberately independent of the primary class:
 * a mechanism can be a real defect even when the per-case artifact cannot prove
 * that a given case triggered it. That separation is the whole point — the
 * campaign supplies the affected-case count and the shared signature, while the
 * offline reproducer supplies the proof.
 *
 * A candidate advances to R86 ONLY with at least `MIN_NON_HOLDOUT_SAMPLES`
 * development cases behind it. Anything short of that is still REPORTED, as
 * `BELOW_SAMPLE_BAR`, so the shortfall is visible instead of silently dropped.
 */
function buildCandidates(rows: readonly TriageCaseRow[]): TriageCandidate[] {
  const out: TriageCandidate[] = [];
  const labels = (group: readonly TriageCaseRow[]): string[] =>
    group.map((r) => `${r.suite}/${r.caseId}`).sort();  const groupOf = (predicate: (row: TriageCaseRow) => boolean): TriageCaseRow[] => rows.filter(predicate);
  const fpOf = (group: readonly TriageCaseRow[]): string => group[0]?.fingerprint ?? "";

  /**
   * R90 §1: derive the historical-attribution status from RAW EVENTS only.
   * A candidate-feature match is never a diagnosis. When the stored artifacts
   * carry no per-call event at all we cannot even call a case a candidate
   * victim, so the honest answer is UNKNOWN rather than a count.
   */
  const attributionOf = (
    group: readonly TriageCaseRow[],
    confirmed: (row: TriageCaseRow) => boolean,
    eventsAvailable: (row: TriageCaseRow) => boolean,
  ): Pick<TriageCandidate, "candidateCases" | "confirmedAffectedCases" | "caseAttributionStatus"> => {
    const candidateCases = labels(group);
    const confirmedAffectedCases = labels(group.filter(confirmed));
    let caseAttributionStatus: TriageCaseAttributionStatus;
    if (confirmedAffectedCases.length > 0) {
      caseAttributionStatus = "CONFIRMED_AFFECTED";
    } else if (candidateCases.length > 0 && group.every(eventsAvailable)) {
      // The events WERE recorded and none of them shows the defect firing, so
      // these cases match the feature but are not victims.
      caseAttributionStatus = "CANDIDATE_ONLY";
    } else {
      caseAttributionStatus = "UNKNOWN";
    }
    return { candidateCases, confirmedAffectedCases, caseAttributionStatus };
  };

  // ---- H2: the repeated-call stall gate terminates a turn in which NO tool
  // call ever failed, and the gate cannot distinguish repetition from progress.
  const h2 = groupOf(
    (r) => r.outcome === "failed" && r.termination === "tool_limit" &&
      r.toolFailures === 0 && r.stallRecovery > 0,
  );
  if (h2.length > 0) {
    out.push({
      id: "H2-stall-gate-progress-blind",
      fingerprint: fpOf(h2),
      primary: "HARNESS_CONTROL_FLOW",
      status: h2.length >= MIN_NON_HOLDOUT_SAMPLES ? "CONFIRMED_HARNESS_DEFECT" : "BELOW_SAMPLE_BAR",
      // R90 §1: the MECHANISM is proven offline by a deterministic reproducer,
      // independently of whether any historical case was actually hit.
      mechanismStatus: "MECHANISM_REPRODUCED",
      // R90 §1: the candidate FEATURE is only a hypothesis. Confirmation needs
      // the raw event showing the result changed AND the gate fired; the stored
      // R83 reports carry no per-call result record, so this is UNKNOWN.
      ...attributionOf(
        h2,
        (r) => r.resultChangeEvidence === "changed",
        (r) => r.resultChangeEvidence !== null,
      ),
      evidenceRefs: [
        "packages/core/src/runtime/r85-h2-progress-blind-gate.test.ts",
        "packages/core/src/state/agent-state.ts",
        "packages/core/src/runtime/runtime.ts",
      ],
      affectedCases: h2.length,
      samples: labels(h2),
      sharedPattern:
        "termination_reason=tool_limit with tool_failures=0 (not one tool call failed), " +
        "retry_taxonomy.stallRecovery>0 (the stall-recovery budget was fully consumed), and an " +
        "artifact verifier whose check was never reached because the turn was terminated first.",
      counterexample:
        "tool_limit cases WITH tool_failures>0 are NOT included as victims: a tool error may come " +
        "from the harness, the environment or a schema, and the model may never have received " +
        "usable feedback. R90 therefore does not equate a tool failure with a model-behaviour " +
        "error; absent recorded feedback the case is INSUFFICIENT_EVIDENCE, not MODEL_BEHAVIOR.",
      minimalRepro:
        "packages/core/src/runtime/r85-h2-progress-blind-gate.test.ts — call the SAME tool with the " +
        "SAME args six times while every call returns a DIFFERENT result; the runtime ends with " +
        "run.limit_reached{limit:maxRepeatedToolCalls,used:3,allowed:3} and status=failed instead of " +
        "completing. Reproducible with a scripted provider: 0 provider calls.",
      fixLayer:
        "packages/core/src/state/agent-state.ts (noteToolCall keys the streak on name+args only; " +
        "resetToolStreak exists but is never called on progress) as consumed at " +
        "packages/core/src/runtime/runtime.ts (the identical-call gate). The streak must be " +
        "cancelled when the same call+args produced a DIFFERENT result, exactly as " +
        "AgentState.priorResultChanged already documents for the pattern window.",
      unavailableAlternatives: [
        "`the model genuinely repeated a no-op` is NOT available as a general defence: " +
        "AgentState.recordToolCall states that 'an identical call with a DIFFERENT result is " +
        "progress, not a stall (avoids false positives)', yet the identical-streak gate never " +
        "consults priorResultChanged. The gate contradicts its own documented contract regardless " +
        "of model behaviour, and that contradiction is proven by the reproducer above.",
        "`the tool budget was simply too small` is NOT available: maxToolCalls is 100 while these " +
        "cases recorded 4–12 tool calls, so the absolute tool budget never fired.",
        "`the verifier rejected the work` is NOT available: no verification was recorded at all, " +
        "so the verifier never produced a judgement.",
        "`the provider failed` is NOT available: retry_taxonomy.provider=0 and termination is not " +
        "model_error for every case in this group.",
      ],
    });
  }

  // ---- H1: the verifier command could not be spawned at all, so the check
  // never ran and the task was rejected untested.
  const h1 = groupOf(
    (r) => r.outcome === "failed" && r.violationKinds.includes("verifier_command_unavailable"),
  );
  if (h1.length > 0) {
    out.push({
      id: "H1-verifier-command-unspawnable",
      fingerprint: fpOf(h1),
      primary: "VERIFIER_OR_ORACLE",
      status: h1.length >= MIN_NON_HOLDOUT_SAMPLES ? "CONFIRMED_HARNESS_DEFECT" : "BELOW_SAMPLE_BAR",
      mechanismStatus: "MECHANISM_REPRODUCED",
      // Unlike H2, the CONFIRMING EVENT is itself stored: the runner recorded
      // `spawn <cmd> ENOENT` as a violation, which is the raw event that proves
      // the verifier never executed. Every case in this group is therefore a
      // confirmed victim, not merely a feature match.
      ...attributionOf(h1, () => true, () => true),
      evidenceRefs: [
        "packages/tools/src/process/executor.ts",
        "packages/tools/src/verification/task-verifier.ts",
      ],
      affectedCases: h1.length,
      samples: labels(h1),
      sharedPattern:
        "verification did not pass: command: <cmd>: <cmd>: spawn <cmd> ENOENT — the verifier " +
        "process could not be started at all, so the declared check never executed and the task " +
        "was rejected without being tested.",
      counterexample:
        "verification_failed cases whose command DID run (`exited with code N`) are NOT attributed " +
        "here. Without the post-run artifact state we cannot tell a wrong artifact from a fragile " +
        "oracle, so those remain INSUFFICIENT_EVIDENCE rather than being blamed on the harness.",
      minimalRepro:
        "packages/tools/src/process/executor.ts runArgv spawns with shell:false; on Windows a " +
        "command shim (.cmd/.ps1, e.g. bash or npx) cannot be executed directly, so spawn fails " +
        "with ENOENT/EINVAL while the same name resolves and runs through a shell.",
      fixLayer:
        "packages/tools/src/process/executor.ts (runArgv) and/or " +
        "packages/tools/src/verification/task-verifier.ts checkCommand — resolve the platform " +
        "command shim instead of spawning the bare name with shell:false.",
      unavailableAlternatives: [
        "`the command is not installed` is NOT available: an offline probe resolves the same name " +
        "through PATH to an existing executable, and the identical invocation succeeds when run " +
        "through a shell.",
        "`the model produced a wrong artifact` is NOT available: the verifier never executed, so it " +
        "produced no judgement about the artifact.",
        "`the oracle is merely strict` is NOT available: a strict oracle still runs and exits " +
        "non-zero; here the process never started.",
      ],
    });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Digest + rendering
// ---------------------------------------------------------------------------

/** Canonical JSON with sorted object keys, so the digest cannot drift. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * sha256 over the ANALYSIS BODY. `generatedFrom` is deliberately excluded: it
 * holds machine-specific path labels, and the plan requires Windows and Ubuntu
 * to agree on this digest.
 */
export function triageDigestOf(body: unknown): string {
  return sha256Hex(JSON.stringify(canonicalize(body)));
}

/** The exact bytes to write for `campaign-triage.json`. Deterministic. */
export function renderTriageJson(result: TriageResult): string {
  return `${JSON.stringify(canonicalize(result), null, 2)}\n`;
}

/** A short human-readable summary (also deterministic). */
export function renderTriageMarkdown(result: TriageResult): string {
  const lines: string[] = [];
  lines.push("# Campaign triage");
  lines.push("");
  lines.push(`Verdict: **${result.verdict}**`);
  lines.push("");
  lines.push(`- campaign valid: ${result.campaignValid ? "yes" : "no"}`);
  lines.push(`- root digest: \`${result.rootDigest}\``);
  lines.push(`- triage digest: \`${result.triageDigest}\``);
  lines.push(`- cases: ${result.totals.cases} (attributed per-case: ${result.totals.attributed})`);
  lines.push(`- passed: ${result.totals.passed} / failed: ${result.totals.failed}`);
  lines.push(`- classified: ${result.totals.classified} / insufficient evidence: ${result.totals.insufficientEvidence}`);
  lines.push("");
  lines.push("## Primary class distribution (failed cases)");
  lines.push("");
  lines.push("| class | cases |");
  lines.push("| --- | --- |");
  for (const [cls, count] of Object.entries(result.totals.byPrimaryClass)) lines.push(`| ${cls} | ${count} |`);
  lines.push("");
  lines.push("## Termination distribution (attributed suites)");
  lines.push("");
  lines.push("| termination | cases |");
  lines.push("| --- | --- |");
  for (const [term, count] of Object.entries(result.totals.byTermination)) lines.push(`| ${term} | ${count} |`);
  lines.push("");
  lines.push("## Holdout (aggregate only — no per-case detail is read or emitted)");
  lines.push("");
  lines.push(`- cases: ${result.holdout.cases}`);
  lines.push(`- passed: ${result.holdout.passed} / failed: ${result.holdout.failed}`);
  lines.push(`- model calls: ${result.holdout.modelCalls}`);
  lines.push(`- tool calls: ${result.holdout.toolCalls}`);
  lines.push(`- tokens in/out: ${result.holdout.tokensInput} / ${result.holdout.tokensOutput}`);
  lines.push("");
  lines.push("## Candidates for R86");
  lines.push("");
  if (result.candidates.length === 0) lines.push("None reached the evidence bar.");
  for (const c of result.candidates) {
    lines.push(`### ${c.id} — ${c.status}`);
    lines.push("");
    lines.push(`- primary: ${c.primary}`);
    lines.push(`- affected cases: ${c.affectedCases}`);
    lines.push(`- samples: ${c.samples.join(", ")}`);
    lines.push(`- shared pattern: ${c.sharedPattern}`);
    lines.push(`- counterexample: ${c.counterexample}`);
    lines.push(`- minimal repro: ${c.minimalRepro}`);
    lines.push(`- fix layer: ${c.fixLayer}`);
    for (const alt of c.unavailableAlternatives) lines.push(`- unavailable alternative: ${alt}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
