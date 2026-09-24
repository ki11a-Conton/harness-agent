import type { ToolDefinition, ToolSpec } from "@ar/contracts";

/**
 * P23-1 — the NARROW catalog surface the step snapshot builder needs.
 *
 * `packages/core` must not depend on `@ar/tools` (dependency direction:
 * harness → core/contracts/tools/agents, core never imports tools). A real
 * `ToolRegistry` structurally satisfies this interface; the snapshot builder
 * reads it ONCE at freeze time and never touches it mid-step.
 */
export interface StepToolCatalog {
  get(name: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
  specs(): readonly ToolSpec[];
}
