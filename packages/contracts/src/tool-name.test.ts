import { describe, expect, it } from "vitest";
import { TOOL_NAME_PATTERN, assertValidToolName, isValidToolName, toolNameViolation } from "./tool.js";

/**
 * P2-43: the provider function-name grammar.
 *
 * Regression guard for the second, independent source of the upstream
 * `11133 model_param_invalid` rejection: a DOTTED tool name. The registered
 * name is sent verbatim as the OpenAI `function.name`, so
 * `mcp_data_source.read` was rejected on the very first request of the turn
 * (HTTP 500 wrapping an upstream 400), while the identical request with
 * `mcp_data_source_read` returned HTTP 200. Nothing in the harness validated
 * the name, so the failure surfaced only as `model_error` with `model_calls: 0`.
 */
describe("P2-43: provider function-name grammar", () => {
  it("accepts every production tool name", () => {
    for (const name of [
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "grep_search",
      "repo_tree",
      "symbol_search",
      "repo_map",
      "discover_commands",
      "env_snapshot",
      "exec",
      "update_plan",
      "tool_lookup",
      "delegate_explore",
      "delegate_batch",
      "mcp_data_source_read",
    ]) {
      expect(isValidToolName(name), name).toBe(true);
      expect(toolNameViolation(name), name).toBeUndefined();
    }
  });

  it("rejects a dotted name — the reproduced defect", () => {
    expect(isValidToolName("mcp_data_source.read")).toBe(false);
    expect(toolNameViolation("mcp_data_source.read")).toContain('"."');
    expect(() => assertValidToolName("mcp_data_source.read")).toThrow(/not a valid provider function name/);
  });

  it("rejects the other illegal classes with a specific reason", () => {
    expect(toolNameViolation("")).toContain("empty");
    expect(toolNameViolation("a".repeat(65))).toContain("65 characters");
    expect(toolNameViolation("read file")).toContain("illegal character");
    expect(toolNameViolation("read:file")).toContain("illegal character");
    expect(toolNameViolation("read/file")).toContain("illegal character");
    // 64 is the inclusive limit.
    expect(toolNameViolation("a".repeat(64))).toBeUndefined();
  });

  it("names the tool and the grammar in the thrown message", () => {
    expect(() => assertValidToolName("remote.echo", "mcp tool")).toThrow(/mcp tool name "remote\.echo"/);
    expect(() => assertValidToolName("remote.echo")).toThrow(new RegExp(TOOL_NAME_PATTERN.source.replace(/[[\]\\^$*+?.()|{}]/g, "\\$&")));
  });
});
