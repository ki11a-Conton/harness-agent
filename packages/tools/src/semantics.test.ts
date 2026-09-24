import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_SEMANTICS, mayHaveSideEffect, toToolSemantics, type ToolDefinition, type ToolMetadata, type ToolRisk } from "@ar/contracts";
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

  it("Q-2: semantics derive from metadata+risk, never from the tool NAME", () => {
    // A tool with a deliberately NONSTANDARD name that carries side-effect
    // metadata must still be classified by metadata — proof that the runtime
    // derives semantics through the registry/ToolSemantics, not via
    // `tool === "write_file"`-style name heuristics.
    const weirdName: ToolDefinition = {
      name: "custom_sync!!$$",
      description: "a nonstandard tool",
      inputSchema: { type: "object" } as never,
      metadata: {
        name: "custom_sync!!$$",
        version: "1.0.0",
        sideEffect: true,
        filesystem: true,
        process: false,
        network: false,
        interactive: false,
        retry: "none",
        concurrencySafe: false,
      },
      risk: "elevated",
      async execute() {
        return { status: "success" };
      },
    };
    const s = semanticsOf(weirdName);
    expect(s.sideEffectScope).toBe("filesystem");
    expect(s.requiresApproval).toBe(true); // risk-derived, independent of name

    // A process-scoped tool with a name that mentions "read" is STILL a
    // process tool: scope comes from metadata.process, never the string.
    const misleadingName: ToolDefinition = {
      name: "read_runner",
      description: "actually spawns a process",
      inputSchema: { type: "object" } as never,
      metadata: {
        name: "read_runner",
        version: "1.0.0",
        sideEffect: true,
        filesystem: false,
        process: true,
        network: false,
        interactive: false,
        retry: "unknown",
        concurrencySafe: false,
      },
      risk: "elevated",
      async execute() {
        return { status: "success" };
      },
    };
    expect(semanticsOf(misleadingName).sideEffectScope).toBe("process");

    // Read-only tool with a strange name is still read-only: readonlyness is
    // derived from the absence of sideEffect, not from the string "read".
    const oddRead: ToolDefinition = {
      name: "x_read_special",
      description: "read-only by metadata",
      inputSchema: { type: "object" } as never,
      metadata: {
        name: "x_read_special",
        version: "1.0.0",
        sideEffect: false,
        filesystem: true,
        process: false,
        network: false,
        interactive: false,
        retry: "safe",
        concurrencySafe: true,
      },
      risk: "readonly",
      async execute() {
        return { status: "success" };
      },
    };
    const r = semanticsOf(oddRead);
    expect(r.sideEffectScope).toBe("none");

    // Unknown/custom tool without rich metadata is treated conservatively
    // rather than being guessed from its name.
    const unknown: ToolDefinition = {
      name: "mystery_tool",
      description: "no rich metadata",
      inputSchema: { type: "object" } as never,
      metadata: {
        name: "mystery_tool",
        version: "1.0.0",
        sideEffect: false,
        filesystem: false,
        process: false,
        network: false,
        interactive: false,
      },
      risk: "side_effect",
      async execute() {
        return { status: "success" };
      },
    };
    // Not guessed as a writer from its name: no sideEffect metadata → "none".
    expect(semanticsOf(unknown).sideEffectScope).toBe("none");
    expect(semanticsOf(unknown).readOnly).toBe(true);
  });

  it("P0-8: unknown tools fail closed via DEFAULT_TOOL_SEMANTICS", () => {
    // The runtime resolves tools that are NOT in the registry/map to
    // DEFAULT_TOOL_SEMANTICS. P0-8 made that default conservative:
    // sideEffectScope "unknown" (treated as may-have-side-effect), no
    // auto-retry, no parallel, approval required by default.
    expect(DEFAULT_TOOL_SEMANTICS.sideEffectScope).toBe("unknown");
    expect(DEFAULT_TOOL_SEMANTICS.retrySafety).toBe("unknown");
    expect(DEFAULT_TOOL_SEMANTICS.concurrencySafety).toBe(false);
    expect(DEFAULT_TOOL_SEMANTICS.requiresApproval).toBe(true);
    expect(DEFAULT_TOOL_SEMANTICS.outputSensitivity).toBe("high");
    expect(semanticsOf(undefined)).toBe(DEFAULT_TOOL_SEMANTICS);

    // mayHaveSideEffect is the single fail-closed gate: only "none" is safe.
    expect(mayHaveSideEffect({ ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "none" })).toBe(false);
    expect(mayHaveSideEffect({ ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "filesystem" })).toBe(true);
    expect(mayHaveSideEffect({ ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "process" })).toBe(true);
    expect(mayHaveSideEffect({ ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "network" })).toBe(true);
    expect(mayHaveSideEffect({ ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "global" })).toBe(true);
    // "unknown" is NOT "none": the runtime cannot prove a tool is side-effect-free.
    expect(mayHaveSideEffect(DEFAULT_TOOL_SEMANTICS)).toBe(true);

    // The builtin known tools still derive their explicit scopes and are
    // reachable through the registry (no regression to the known set).
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    expect(semanticsOf(registry.get("write_file")).sideEffectScope).toBe("filesystem");
    expect(semanticsOf(registry.get("no_such_tool")).sideEffectScope).toBe("unknown");
  });
});