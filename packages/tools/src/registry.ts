import type { ToolCapability, ToolDefinition, ToolSemantics, ToolSpec } from "@ar/contracts";
import { DEFAULT_TOOL_CAPABILITY, DEFAULT_TOOL_SEMANTICS, AgentError, errorInfo, toToolSemantics } from "@ar/contracts";
import { zodToJsonSchema } from "zod-to-json-schema";

/** Capability projection of a tool for the runtime's retry gating and
 *  concurrency planning; unknown tools are conservatively "unknown"/serial. */
export function capabilityOf(tool: ToolDefinition | undefined): ToolCapability {
  if (tool === undefined) return DEFAULT_TOOL_CAPABILITY;
  return {
    retry: tool.metadata.retry ?? DEFAULT_TOOL_CAPABILITY.retry,
    concurrencySafe: tool.metadata.concurrencySafe ?? DEFAULT_TOOL_CAPABILITY.concurrencySafe,
  };
}

/** P1-11: full execution semantics of a tool; unknown tools get the
 *  conservative default. Registry tools carry metadata/risk, so semantics
 *  derive deterministically — the runtime never matches on tool names. */
export function semanticsOf(tool: ToolDefinition | undefined): ToolSemantics {
  if (tool === undefined) return DEFAULT_TOOL_SEMANTICS;
  return toToolSemantics(tool.metadata, tool.risk);
}

/**
 * ToolRegistry per AGENT_ARCHITECTURE_PLAN §102 (TOOL-001).
 * Registry only stores and describes tools — execution happens exclusively
 * through the ToolOrchestrator (INV-002). No execute() surface here.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (!tool.name || tool.name.length === 0) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", "tool must have a name"));
    }
    if (this.tools.has(tool.name)) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", `tool already registered: ${tool.name}`));
    }
    if (tool.metadata.name !== tool.name) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `metadata.name (${tool.metadata.name}) must equal name (${tool.name})`),
      );
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Serializable specs for model providers (JSON Schema input). */
  specs(): ToolSpec[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema) as Record<string, unknown>,
    }));
  }
}