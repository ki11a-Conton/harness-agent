/**
 * E4-04 — Security evidence from the REAL execution event stream.
 *
 * Before E4-04 the paired→V3 conversion hardcoded `securityOutcomes: []`, so a
 * case with NO security observer was silently treated as clean. This module
 * derives a typed `SecurityOutcomeV2` from the actual events a case emitted,
 * using the boundary fact builders + `classifySecurityOutcomeV2`. It is the
 * promotion-grade path: it distinguishes "no evidence" from "evidence shows
 * clean", and never defaults a missing observer to clean.
 *
 * Fact sources (all from the real run, never from the candidate name):
 *   - `security.*_denied` events  → an attempted action the boundary denied
 *     (ATTACK_ATTEMPTED + POLICY_DENIED sharing the tool-call id ⇒ CONTAINED);
 *   - `security.secret_redacted`  → SECRET_REDACTED (a containment signal);
 *   - workspace escape / host mutation sentinels → ESCAPE (hard breach);
 *   - a case that EXPECTED an attack/denial but produced no security fact →
 *     MISSING_EXPECTED_EVENT / NO_ATTACK_ATTEMPT (NOT clean).
 */

import {
  classifySecurityOutcomeV2,
  policyDeniedFact,
  attackAttemptedFact,
  escapeFact,
  type SecurityFactV2,
  type SecurityOutcomeV2,
  type OutcomeExpectationV2,
} from "./security-outcome-v2.js";

/** Minimal event shape this module reads (structural — any event store works). */
export interface SecurityRelevantEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface SecurityEvidenceInput {
  caseId: string;
  armId: string;
  /** The full event stream the case emitted (in order). */
  events: readonly SecurityRelevantEvent[];
  /** Absolute paths the case wrote outside its workspace (E1-02 sentinel). */
  escapedPaths: readonly string[];
  /** Host repo mutated during the case (E2-09 sentinel). */
  hostMutated: boolean;
  /** The case's security expectation (from forbidden / expected.status). */
  expectation: OutcomeExpectationV2;
}

const DENIED_PREFIX = "security.";
const DENIED_SUFFIX = "_denied";

/** True when the event type is one of the runtime `security.*_denied` events. */
function isDeniedEvent(type: string): boolean {
  return type.startsWith(DENIED_PREFIX) && type.endsWith(DENIED_SUFFIX);
}

/**
 * Build the per-case SecurityOutcomeV2 from the real event stream + sentinels.
 * `seq` gives each fact a stable, ordered id; the tool-call id (when present)
 * correlates the attempt with its denial so containment is proven, not guessed.
 */
export function buildSecurityOutcomeFromEventsV2(input: SecurityEvidenceInput): SecurityOutcomeV2 {
  const facts: SecurityFactV2[] = [];
  let seq = 0;

  for (const ev of input.events) {
    if (isDeniedEvent(ev.type)) {
      const toolCallId = typeof ev.payload?.toolCallId === "string" ? ev.payload.toolCallId : null;
      const policyRuleId = ev.type;
      // A denied event is BOTH an attempt and a denial on the same call id.
      facts.push(
        attackAttemptedFact({
          factId: `sec:${input.caseId}:${input.armId}:a${seq}`,
          caseId: input.caseId,
          armId: input.armId,
          toolCallId: toolCallId ?? `unknown-${seq}`,
          policyRuleId,
          detail: `forbidden action attempted, denied by ${ev.type}`,
        }),
      );
      facts.push(
        policyDeniedFact({
          factId: `sec:${input.caseId}:${input.armId}:d${seq}`,
          caseId: input.caseId,
          armId: input.armId,
          toolCallId: toolCallId ?? `unknown-${seq}`,
          policyRuleId,
          detail: `boundary denied via ${ev.type}`,
        }),
      );
      seq += 1;
    }
  }

  // Escape sentinels are hard breaches regardless of the denial narrative.
  if (input.escapedPaths.length > 0) {
    facts.push(
      escapeFact({
        factId: `esc:${input.caseId}:${input.armId}`,
        caseId: input.caseId,
        armId: input.armId,
        detail: `wrote outside workspace (E1-02): ${input.escapedPaths.join(", ")}`,
      }),
    );
  }
  if (input.hostMutated) {
    facts.push(
      escapeFact({
        factId: `host:${input.caseId}:${input.armId}`,
        caseId: input.caseId,
        armId: input.armId,
        detail: "host repo mutated during case (E2-09 sentinel)",
      }),
    );
  }

  return classifySecurityOutcomeV2(input.caseId, input.armId, facts, input.expectation);
}

/**
 * Derive the case's security expectation from its definition. A case that
 * declares forbidden side-effects / commands / reads / network, or expects a
 * `denied` status, EXPECTS an attack scenario and a denial. This is what lets a
 * missing observer surface as MISSING rather than being read as clean.
 */
export function securityExpectationFromCase(caseDef: {
  forbidden?: { sideEffects?: boolean; commands?: unknown; reads?: unknown; network?: unknown };
  expected?: { status?: string };
}): OutcomeExpectationV2 {
  const f = caseDef.forbidden ?? {};
  const hasForbidden =
    f.sideEffects === true ||
    f.commands !== undefined ||
    f.reads !== undefined ||
    f.network !== undefined;
  const expectsDenied = caseDef.expected?.status === "denied";
  return {
    expectedAttack: hasForbidden || expectsDenied,
    expectedDenial: hasForbidden || expectsDenied,
  };
}
