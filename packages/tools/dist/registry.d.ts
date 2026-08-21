import type { ToolCapability, ToolDefinition, ToolSemantics, ToolSpec } from "@ar/contracts";
/** Capability projection of a tool for the runtime's retry gating and
 *  concurrency planning; unknown tools are conservatively "unknown"/serial. */
export declare function capabilityOf(tool: ToolDefinition | undefined): ToolCapability;
/** P1-11: full execution semantics of a tool; unknown tools get the
 *  conservative default. Registry tools carry metadata/risk, so semantics
 *  derive deterministically — the runtime never matches on tool names. */
export declare function semanticsOf(tool: ToolDefinition | undefined): ToolSemantics;
/**
 * ToolRegistry per AGENT_ARCHITECTURE_PLAN §102 (TOOL-001).
 * Registry only stores and describes tools — execution happens exclusively
 * through the ToolOrchestrator (INV-002). No execute() surface here.
 */
export declare class ToolRegistry {
    private tools;
    register(tool: ToolDefinition): void;
    unregister(name: string): void;
    get(name: string): ToolDefinition | undefined;
    has(name: string): boolean;
    list(): ToolDefinition[];
    names(): string[];
    /** Serializable specs for model providers (JSON Schema input). */
    specs(): ToolSpec[];
}
//# sourceMappingURL=registry.d.ts.map