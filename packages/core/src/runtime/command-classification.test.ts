import { describe, expect, it } from "vitest";
import { classifyCommand } from "./command-classification.js";

describe("P0-13 command classification", () => {
  it("classifies vitest as test", () => {
    expect(classifyCommand("pnpm exec vitest run").kind).toBe("test");
  });
  it("classifies tsc as typecheck", () => {
    expect(classifyCommand("pnpm typecheck").kind).toBe("typecheck");
  });
  it("classifies build commands", () => {
    expect(classifyCommand("pnpm build").kind).toBe("build");
  });
  it("classifies lint commands", () => {
    expect(classifyCommand("eslint .").kind).toBe("lint");
  });
  it("classifies format commands", () => {
    expect(classifyCommand("prettier --write .").kind).toBe("format");
  });
  it("classifies install commands", () => {
    expect(classifyCommand("pnpm install").kind).toBe("package_install");
  });
  it("classifies git commands", () => {
    expect(classifyCommand("git status").kind).toBe("git");
  });
  it("falls back to general for unknown commands", () => {
    expect(classifyCommand("echo hello").kind).toBe("general");
  });
  it("medium-confidence test detection", () => {
    expect(classifyCommand("run-tests.sh").kind).toBe("test");
  });
});