/**
 * @ar/orchestration — Symphony-style external work orchestration (P33).
 *
 * Above the Harness, NOT inside AgentRuntime. Orchestrates external work items
 * (from a tracker) into per-item worker threads driven through the App Server
 * (via @ar/sdk), with an authoritative scheduler state machine, reconcile-
 * before-dispatch ticks, per-item workspace isolation and WORKFLOW.md-driven
 * prompt templates.
 *
 * Dependency direction (plan.md P33-1):
 *   orchestration → SDK / App Server client
 *   (never orchestration → AgentRuntime internals, never core → orchestration)
 */
export * from "./work-item.js";
export * from "./tracker.js";
export * from "./workflow-loader.js";
export * from "./reconciler.js";
export * from "./scheduler.js";
export * from "./retry-policy.js";
export * from "./workspace-manager.js";
export * from "./worker.js";