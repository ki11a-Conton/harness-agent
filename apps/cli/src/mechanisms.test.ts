import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseYaml,
  validateMechanismManifest,
  validateMechanismsDir,
} from "./mechanisms.js";

const VALID = `# mechanism manifest (P2-8)
id: mcp-tool-consolidation
source_agent: codex
source_report: reports/codex/2026-01.md
category: tool_use
problem: many small tools flood the tool list
preconditions: tool list length > 20
expected_benefit: lower context use, fewer selection errors
risks: merged tools hide details
implementation_scope: tools package
evaluation_cases:
- single-tool merge
- cross-domain merge
status: candidate
`;

describe("P2-8 mechanism registry tooling", () => {
  it("parses the minimal YAML subset with lists and comments", () => {
    const record = parseYaml(VALID);

    expect(record.id).toBe("mcp-tool-consolidation");
    expect(record.source_agent).toBe("codex");
    expect(record.status).toBe("candidate");
    expect(record.evaluation_cases).toEqual(["single-tool merge", "cross-domain merge"]);
  });

  it("accepts a complete, valid manifest", () => {
    expect(validateMechanismManifest(parseYaml(VALID))).toEqual([]);
  });

  it("flags missing required fields and bad enums", () => {
    const errors = validateMechanismManifest(
      parseYaml("id: x\nstatus: shipped-forever\n"),
    );

    expect(errors).toContain("missing required field: source_agent");
    expect(errors).toContain("missing required field: problem");
    expect(errors.some((e) => e.startsWith("status must be one of"))).toBe(true);
  });

  it("rejects unsupported yaml lines", () => {
    expect(() => parseYaml("- orphan item\n")).toThrow(/list item without a key/);
    expect(() => parseYaml("a: b\n- orphan item\n")).toThrow(/list item under non-list key/);
    expect(() => parseYaml("weird line without colon")).toThrow(/unsupported line/);
  });

  it("validates a directory: id uniqueness across manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mechanisms-"));
    try {
      await writeFile(join(dir, "a.yaml"), VALID);
      await writeFile(
        join(dir, "b.yaml"),
        VALID.replace("mcp-tool-consolidation", "second-mechanism"),
      );
      await writeFile(join(dir, "_template.yaml"), "id: example-mechanism\n");

      const { manifests, issues } = await validateMechanismsDir(dir);
      expect(manifests).toHaveLength(2);
      expect(issues).toEqual([]);
      expect(manifests.some((m) => m.id === "mcp-tool-consolidation")).toBe(true);
      expect(manifests.some((m) => m.id === "second-mechanism")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports duplicate ids across manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mechanisms-dup-"));
    try {
      await writeFile(join(dir, "a.yaml"), VALID);
      await writeFile(join(dir, "b.yaml"), VALID);

      const { issues } = await validateMechanismsDir(dir);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.errors[0]).toContain("duplicate id");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});