import type { ErrorCode, EventType } from "@ar/contracts";

/**
 * P0-7: uniform skill security-deny record. Every skill rejection (loader
 * discovery or store save/update) for injection or secret content resolves to
 * one normalized record carrying detection / reasons / source / code. The
 * error code and the security event type agree, so a denial surfaced by the
 * skill layer is observable on the event stream with a structured code —
 * never stderr-only and never a bare generic SECURITY_DENIED.
 *
 * §958-978: structured reason / security event / error code / target / source.
 */
export interface SkillSecurityDenial {
  detection: "injection" | "secret";
  reasons: string[];
  content: string;
  /** Denied subject — a skill path (loader) or id (store). */
  path: string;
  /** Which subsystem surfaced the denial ("skill-loader" | "skill-store"). */
  source: string;
}

/** Error code for a skill security denial (§965). */
export function skillDenialCode(detection: SkillSecurityDenial["detection"]): ErrorCode {
  return detection === "injection" ? "SKILL_DENIED" : "SECRET_REDACTED";
}

/** Security event emitted for a skill denial (§964). */
export function skillDenialEventType(detection: SkillSecurityDenial["detection"]): EventType {
  return detection === "injection" ? "security.skill_denied" : "security.secret_redacted";
}

/** Normalized event payload for a skill denial (mirrors denialPayload shape). */
export function skillDenialPayload(denial: SkillSecurityDenial): Record<string, unknown> {
  return {
    reason: denial.detection === "injection"
      ? `injection detected (${denial.reasons.join(", ")})`
      : `secret detected (${denial.reasons.join(", ")})`,
    code: skillDenialCode(denial.detection),
    source: denial.source,
    target: denial.path,
    details: denial.reasons,
  };
}