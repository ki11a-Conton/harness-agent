import { describe, expect, it } from "vitest";
import type { Skill } from "@ar/contracts";
import { checkSkillRequiredTools, requiredToolsDenial } from "./skill-capability.js";

/** P14-4 — skill boundary: declared requiredTools must be within the host's
 *  conferred tool policy (monotonic downward, one semantic with the runtime's
 *  isToolAllowedByPolicy gate). */

function skill(requiredTools?: string[]): Pick<Skill, "manifest" | "path"> {
  return {
    path: "/skills/mine/SKILL.md",
    manifest: {
      name: "mine",
      description: "test skill",
      version: "0.0.1",
      ...(requiredTools !== undefined ? { requiredTools } : {}),
    },
  };
}

describe("checkSkillRequiredTools — P14-4 skill boundary", () => {
  it("a skill without requiredTools is always allowed", () => {
    expect(checkSkillRequiredTools(skill(undefined), { allow: ["read"] })).toEqual({
      allowed: true,
      missing: [],
    });
  });

  it("requiredTools within the allow-list narrows fine", () => {
    const verdict = checkSkillRequiredTools(skill(["read", "write"]), {
      allow: ["read", "write", "exec"],
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it("requiredTools outside the allow-list is a widening rejection (fail-closed)", () => {
    const verdict = checkSkillRequiredTools(skill(["read", "exec"]), {
      allow: ["read"],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.missing).toEqual(["exec"]);
  });

  it("a deny-list entry rejects a required tool even when allow is unrestricted", () => {
    const verdict = checkSkillRequiredTools(skill(["read"]), { deny: ["read"] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.missing).toEqual(["read"]);
  });

  it("an undefined policy behaves like an allow-everything policy (matches runtime gate)", () => {
    expect(checkSkillRequiredTools(skill(["anything"]), undefined).allowed).toBe(true);
  });

  it("an explicit empty allow-list rejects everything declared", () => {
    const verdict = checkSkillRequiredTools(skill(["read"]), { allow: [] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.missing).toEqual(["read"]);
  });
});

describe("requiredToolsDenial — P14-4 typed denial record", () => {
  it("maps to the shared skill-security shape (SKILL_DENIED surface)", () => {
    const verdict = checkSkillRequiredTools(skill(["evil_tool"]), { allow: ["read"] });
    const denial = requiredToolsDenial(skill(["evil_tool"]), verdict);
    expect(denial.detection).toBe("required-tools");
    expect(denial.path).toBe("/skills/mine/SKILL.md");
    expect(denial.source).toBe("skill-capability");
    expect(denial.reasons[0]).toContain("evil_tool");
  });
});
