import { describe, expect, it } from "vitest";
import { skillDenialCode, skillDenialEventType, skillDenialPayload } from "./skill-security.js";

describe("skill security denial normalization (P0-7)", () => {
  it("maps detection to the agreed error code and security event type", () => {
    expect(skillDenialCode("injection")).toBe("SKILL_DENIED");
    expect(skillDenialCode("secret")).toBe("SECRET_REDACTED");
    expect(skillDenialEventType("injection")).toBe("security.skill_denied");
    expect(skillDenialEventType("secret")).toBe("security.secret_redacted");
  });

  it("builds a uniform payload with reason/code/source/target/details", () => {
    const p = skillDenialPayload({
      detection: "injection",
      reasons: ["authority claim", "ignore prior"],
      content: "override",
      path: "/skills/evil/SKILL.md",
      source: "skill-loader",
    });
    expect(p).toEqual({
      reason: "injection detected (authority claim, ignore prior)",
      code: "SKILL_DENIED",
      source: "skill-loader",
      target: "/skills/evil/SKILL.md",
      details: ["authority claim", "ignore prior"],
    });
  });
});