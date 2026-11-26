import type { ToolCapability, ToolDefinition, ToolSemantics, ToolSpec } from "@ar/contracts";
import { DEFAULT_TOOL_SEMANTICS, AgentError, errorInfo, toToolCapability, toToolSemantics, toolNameViolation } from "@ar/contracts";
import { z } from "zod";

/** Provider and deferred lookup must advertise the same input contract. */
export function toolInputJsonSchema(schema: ToolDefinition["inputSchema"]): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
    override({ zodSchema, jsonSchema }) {
      // Stripping object schemas accept extra keys but never pass them to tools.
      if (zodSchema instanceof z.ZodObject && zodSchema.def.catchall === undefined) {
        jsonSchema.additionalProperties = false;
      }
      // JSON keys are already strings. Keep constrained record keys intact.
      const keys = jsonSchema.propertyNames;
      if (keys && typeof keys === "object" && keys.type === "string" && Object.keys(keys).length === 1) {
        delete jsonSchema.propertyNames;
      }
      // Discriminated branches are disjoint, so the existing provider anyOf is exact.
      if (zodSchema instanceof z.ZodDiscriminatedUnion && jsonSchema.oneOf) {
        jsonSchema.anyOf = jsonSchema.oneOf;
        delete jsonSchema.oneOf;
      }
    },
  });
}

/** Capability projection of a tool for LEGACY retry/concurrency callers.
 *  P18-1: derived through the single semantics chain (metadata → semantics →
 *  capability), so the two views can never drift and metadata is never a
 *  second decision source. Unknown tools are conservatively "unknown"/serial. */
export function capabilityOf(tool: ToolDefinition | undefined): ToolCapability {
  return toToolCapability(semanticsOf(tool));
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
    // P2-43: fail closed on a name the provider cannot accept. The registered
    // name is the wire `function.name`, so an illegal name (e.g. a dotted MCP
    // name) is rejected by a strict upstream with an opaque HTTP 400
    // `11133 model_param_invalid` on the FIRST request — far from its cause.
    // Refusing it here names the tool and the grammar at composition time.
    const nameViolation = toolNameViolation(tool.name);
    if (nameViolation !== undefined) {
      throw new AgentError(
        errorInfo(
          "TOOL_SCHEMA_ERROR",
          `tool name "${tool.name}" is not a valid provider function name: ${nameViolation}`,
          { evidence: JSON.stringify({ tool: tool.name, pattern: "^[a-zA-Z0-9_-]{1,64}$" }) },
        ),
      );
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
      inputSchema: toolInputJsonSchema(t.inputSchema),
    }));
  }
}