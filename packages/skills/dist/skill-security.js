/** Error code for a skill security denial (§965). */
export function skillDenialCode(detection) {
    return detection === "injection" ? "SKILL_DENIED" : "SECRET_REDACTED";
}
/** Security event emitted for a skill denial (§964). */
export function skillDenialEventType(detection) {
    return detection === "injection" ? "security.skill_denied" : "security.secret_redacted";
}
/** Normalized event payload for a skill denial (mirrors denialPayload shape). */
export function skillDenialPayload(denial) {
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
//# sourceMappingURL=skill-security.js.map