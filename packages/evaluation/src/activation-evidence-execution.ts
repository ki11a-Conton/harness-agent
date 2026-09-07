/**
 * E4-04 — Activation evidence V2 from the REAL execution signals.
 *
 * The legacy `activationEvidenceFor` (activation-evidence.ts) is a
 * candidate-NAME switch that returns hard-coded "digests" like "no-memory" —
 * strings that prove nothing about what the model actually saw. This module is
 * the promotion-grade replacement: it records an `ActivationEventV2` AT the
 * fact site (the observer that already sees the real runtime events), carrying
 * a digest recomputed from the actual payload and the case/arm/attempt/
 * repetition lineage, then validates + aggregates it. A candidate that only
 * flips a flag but changes no real request surface produces NO events and is
 * therefore `eligibleButNotActivated` — never "activated".
 *
 * Wiring contract (E4-04 #1/#3):
 *   - every observed signal becomes one recorded event with a real digest;
 *   - `validateActivationV2` fails closed on empty digests (SELF_REPORTED),
 *     cross-candidate/arm events, and lineage mismatches;
 *   - `aggregateActivationV2` counts activation only for ELIGIBLE cases, so
 *     coverage is derived from completed case evidence, not a Map size.
 */

import { createHash } from "node:crypto";
import {
  createActivationRecorderV2,
  validateActivationV2,
  aggregateActivationV2,
  ACTIVATION_EVIDENCE_V2_SCHEMA_VERSION,
  type ActivationEventV2,
  type ActivationMechanism,
  type ActivationEvidenceType,
  type ActivationValidationResultV2,
  type ActivationAggregationV2,
} from "./activation-evidence-v2.js";

/** The activation signals the benchmark observer actually sees. */
export type ObservedActivationSignalType =
  | "tool_lookup_called"
  | "recovery_decision"
  | "memory_retrieved"
  | "budget_guidance_injected";

export interface ObservedActivationSignal {
  type: ObservedActivationSignalType;
  payload?: Record<string, unknown>;
}

export interface ActivationEvidenceExecutionInput {
  candidateId: string;
  caseId: string;
  armId: string;
  attempt: number;
  repetition: number;
  /** Signals gathered by the real observer during the case. */
  signals: readonly ObservedActivationSignal[];
  /** Whether this case is ELIGIBLE for the candidate's mechanism (from the
   *  case contract + wiring), not from the candidate name. */
  eligible: boolean;
}

export interface ActivationEvidenceExecutionResult {
  events: ActivationEventV2[];
  validation: ActivationValidationResultV2;
  aggregation: ActivationAggregationV2;
}

/** Signal → (mechanism, evidenceType). Mirrors the real runtime surfaces. */
const SIGNAL_MAP: Record<
  ObservedActivationSignalType,
  { mechanism: ActivationMechanism; evidenceType: ActivationEvidenceType }
> = {
  tool_lookup_called: { mechanism: "tool-schema", evidenceType: "tool-schema-advertised" },
  recovery_decision: { mechanism: "recovery", evidenceType: "recovery-decided" },
  memory_retrieved: { mechanism: "memory", evidenceType: "memory-block-injected" },
  budget_guidance_injected: { mechanism: "prompt-guidance", evidenceType: "prompt-guidance-injected" },
};

/** sha256 over the JSON of the actual payload — a real function of what the
 *  model saw, never a hard-coded string. */
function payloadDigest(payload: Record<string, unknown> | undefined): string {
  return createHash("sha256").update(JSON.stringify(payload ?? {}), "utf8").digest("hex");
}

/** Best-effort entry count from a payload (count / retrieved / blocks), else 1
 *  when the event fired (a fired retrieval/injection implies ≥1 entry). */
function entryCountOf(payload: Record<string, unknown> | undefined): number {
  if (!payload) return 1;
  for (const key of ["count", "retrieved", "blocks", "entries", "results"]) {
    const v = payload[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.length;
  }
  return 1;
}

/**
 * Record the observed signals as V2 activation events, validate, and aggregate.
 * Returns the full evidence triple so the caller can attach it to the outcome
 * and the promotion gate can fail closed on `validation.issues` /
 * `aggregation.invalid`.
 */
export function buildActivationEvidenceFromSignalsV2(
  input: ActivationEvidenceExecutionInput,
): ActivationEvidenceExecutionResult {
  const recorder = createActivationRecorderV2();
  let seq = 0;

  for (const signal of input.signals) {
    const mapped = SIGNAL_MAP[signal.type];
    if (mapped === undefined) continue; // unknown signal — never fabricate an event
    const event: ActivationEventV2 = {
      eventId: `${input.caseId}:${input.armId}:r${input.repetition}:${signal.type}:${seq}`,
      schemaVersion: ACTIVATION_EVIDENCE_V2_SCHEMA_VERSION,
      candidateId: input.candidateId,
      mechanism: mapped.mechanism,
      evidenceType: mapped.evidenceType,
      lineage: {
        caseId: input.caseId,
        armId: input.armId,
        attempt: input.attempt,
        repetition: input.repetition,
      },
      payload: {
        digest: payloadDigest(signal.payload),
        ...(mapped.mechanism === "memory" ? { entryCount: entryCountOf(signal.payload) } : {}),
      },
    };
    recorder.record(event);
    seq += 1;
  }

  const events = recorder.events();
  const validation = validateActivationV2(events, {
    expectedCandidateId: input.candidateId,
    expectedArmId: input.armId,
  });
  const aggregation = aggregateActivationV2(
    events,
    { eligible: new Map([[input.caseId, input.eligible]]) },
    validation,
  );

  return { events, validation, aggregation };
}
