import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_SEMANTICS, toToolSemantics, type ToolMetadata, type ToolRisk } from "@ar/contracts";
import { ToolRegistry, semanticsOf } from "./registry.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { editFileTool } from "./tools/edit-file.js";
import { searchFilesTool } from "./tools/search-files.js";
import { execTool } from "./tools/exec.js";

describe("P1-11: tool execution semantics registry", () => {
  it("derives semantics for real tools from their metadata + risk", () => {
    const expectSemantics = (meta: ToolMetadata, risk: ToolRisk) => {
      const s = toToolSemantics(meta, risk);
      expect(s.readOnly).toBe(!meta.sideEffect);
      expect(s.idempotent).toBe(meta.retry === "safe");
      expect(s.retrySafety).toBe(meta.retry);
      expect(s.concurrencySafety).toBe(meta.concurrencySafe);
      expect(s.cancellable).toBe(true);
      expect(s.requiresApproval).toBe(risk === "elevated" || risk === "critical");
      expect(s.networkBehavior).toBe(meta.network ? "outbound" : "none");
      expect(s.outputSensitivity).toBe("medium");
      return s;
    };

    // read-only tools: no side-effect scope at all
    const read = expectSemantics(readFileTool.metadata, readFileTool.risk);
    expect(read.sideEffectScope).toBe("none");

    // filesystem writers
    const write = expectSemantics(writeFileTool.metadata, writeFileTool.risk);
    expect(write.sideEffectScope).toBe("filesystem");
    expect(write.idempotent).toBe(false);
    expect(write.retrySafety).toBe("none");
    const edit = expectSemantics(editFileTool.metadata, editFileTool.risk);
    expect(edit.sideEffectScope).toBe("filesystem");

    // process runner: elevated risk → approval-gated
    const exec = expectSemantics(execTool.metadata, execTool.risk);
    expect(exec.sideEffectScope).toBe("process");
    expect(exec.requiresApproval).toBe(true);
    expect(exec.retrySafety).toBe("unknown");

    // search: read-only + safe retry + concurrent
    const search = expectSemantics(searchFilesTool.metadata, searchFilesTool.risk);
    expect(search.sideEffectScope).toBe("none");
    expect(search.concurrencySafety).toBe(true);
  });

  it("semanticsOf resolves each builtin tool and falls back to DEFAULT for unknowns", () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.register(writeFileTool);
    registry.register(editFileTool);
    registry.register(searchFilesTool);
    registry.register(execTool);

    expect(semanticsOf(registry.get("write_file")).sideEffectScope).toBe("filesystem");
    expect(semanticsOf(registry.get("edit_file")).sideEffectScope).toBe("filesystem");
    expect(semanticsOf(registry.get("exec")).sideEffectScope).toBe("process");
    expect(semanticsOf(registry.get("read_file")).sideEffectScope).toBe("none");
    expect(semanticsOf(registry.get("search_files")).sideEffectScope).toBe("none");
    expect(semanticsOf(registry.get("no_such_tool"))).toBe(DEFAULT_TOOL_SEMANTICS);
    expect(semanticsOf(undefined)).toBe(DEFAULT_TOOL_SEMANTICS);
  });
});