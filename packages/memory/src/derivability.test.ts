import { describe, expect, it } from "vitest";
import { assessDerivability, isMemoryWorthy } from "./derivability.js";

describe("P17-1 derivability rule", () => {
  it("repo/git/config facts are DERIVABLE (not stored long-term)", () => {
    const cases = [
      "The workspace contains src/ and packages/ directories",
      "The lockfile is at package-lock.json",
      "AGENTS.md says run pnpm build",
      "npm is the package manager configured in package.json",
      "The dependency react is at version 18.2.0 in package.json",
    ];
    for (const content of cases) {
      const verdict = assessDerivability(content);
      expect(verdict.verdict, content).toBe("derivable");
      expect(isMemoryWorthy(verdict)).toBe(false);
    }
  });

  it("preferences/decisions/lessons/environment are NON-DERIVABLE (memory-worthy)", () => {
    const cases = [
      "The user prefers pnpm over npm for this project",
      "We decided to avoid YAML in favor of JSON configs",
      "Lesson: don't retry against an unrecoverable environment",
      "The CI sandbox blocks network access to api.example.com",
      "Constraint: the build must not require sudo",
      "Failed because the compiler version was too old for this code",
    ];
    for (const content of cases) {
      const verdict = assessDerivability(content);
      expect(verdict.verdict, content).toBe("non-derivable");
      expect(isMemoryWorthy(verdict)).toBe(true);
    }
  });

  it("preference phrasing beats a repo-fact (preference wins)", () => {
    // Contains both "npm" (repo fact) and "prefers" (preference) — must be
    // classified as the user preference, never as derivable.
    const verdict = assessDerivability("The user prefers npm over pnpm");
    expect(verdict.verdict).toBe("non-derivable");
  });

  it("defaults conservatively to non-derivable on no signal", () => {
    const verdict = assessDerivability("Something worth remembering happened");
    expect(verdict.verdict).toBe("non-derivable");
  });
});
