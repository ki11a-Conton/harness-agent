import { describe, expect, it } from "vitest";
import { buildCodingSystemPrompt, type CodingPromptRole } from "./coding-prompt.js";

describe("coding-v1 capability-aware policy", () => {
  it("stable prefix ignores tool order, duplicates and unknown capabilities", () => {
    const build = (toolNames: string[]) => buildCodingSystemPrompt({ role: "primary", toolNames });
    expect(build(["exec", "read_file", "exec", "imaginary_vendor_tool"]))
      .toBe(build(["read_file", "exec"]));
    expect(build(["read_file"])).not.toContain("imaginary_vendor_tool");
  });
  it("does not give a readonly worker mutation or execution instructions even if passed effect tools", () => {
    const prompt = buildCodingSystemPrompt({ role: "readonly-worker", toolNames: ["read_file", "write_file", "edit_file", "exec", "update_plan"] });
    expect(prompt).toContain("Your assignment is investigation only");
    expect(prompt).toContain("- read_file:");
    expect(prompt).not.toMatch(/^- (write_file|edit_file|exec|update_plan):/m);
    expect(prompt).not.toContain("expectedSha256");
    expect(prompt).not.toContain("Run relevant tests");
  });
  it("only recommends version checks when both reading and mutation are supported", () => {
    const build = (toolNames: string[]) => buildCodingSystemPrompt({ role: "primary", toolNames });
    expect(build(["read_file", "edit_file"])).toContain("expectedSha256");
    expect(build(["edit_file"])).not.toContain("expectedSha256");
    expect(build(["read_file"])).not.toContain("expectedSha256");
    expect(build([])).not.toContain("Available native capabilities");
    expect(build(["read_file", "edit_file", "write_file"]).match(/Before changing an existing file/g)).toHaveLength(1);
  });
  it("exec guidance requires real exit codes; unavailable execution is reported as a limitation", () => {
    expect(buildCodingSystemPrompt({ role: "primary", toolNames: ["exec"] })).toContain("Inspect exit codes and diagnostics");
    const noExec = buildCodingSystemPrompt({ role: "primary", toolNames: ["read_file"] });
    expect(noExec).toContain("executing checks is required but unavailable");
    expect(noExec).not.toContain("Run relevant tests");
  });
  it("delegated write policy confines integration to the parent", () => {
    expect(buildCodingSystemPrompt({ role: "write-worker", toolNames: ["read_file", "edit_file", "exec"] }))
      .toContain("without claiming a merge into the parent's workspace");
  });
  it("rejects an invalid role instead of falling back to write instructions", () => {
    expect(() => buildCodingSystemPrompt({ role: "unknown" as CodingPromptRole, toolNames: [] })).toThrow("unsupported coding prompt role");
  });
});
