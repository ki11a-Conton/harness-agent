/**
 * R0/S1 (F1) — the VERSIONED worker/arm ABI, declared ONCE.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Two modules need the same capability string and must never drift:
 *
 *   - `apps/cli/src/benchmark-command.ts` EXPORTS the list as `R97_ARM_ABI`, so
 *     the arm's own build declares what it can honour;
 *   - `apps/cli/src/prereg-arm-executor.ts` CONSUMES it, so the driver can refuse
 *     an arm that cannot honour the campaign's durable tool budget BEFORE the
 *     first model request.
 *
 * Importing one from the other would close a cycle (`benchmark-command` → `main`
 * → `prereg-command` → `prereg-production-runner` → `prereg-arm-executor`), so the
 * constant lives here and both sides import it.
 *
 * WHAT `tool-budget-rpc-v1` MEANS
 * -------------------------------
 * The arm build's `runOneCase` accepts `opts.toolBudget` — the structural
 * `ToolDispatchBudget` `packages/tools` declares — and binds it into the
 * `ToolOrchestrator` it constructs for the case. A build WITHOUT this string is
 * an OLD-ABI arm: the formal pre-registered path must REFUSE it rather than run
 * it with the campaign's tool cap silently unenforced.
 */

/** The capability the formal pre-registered path cannot run without. */
export const R97_ARM_ABI_TOOL_BUDGET = "tool-budget-rpc-v1";

/** The capability that says this build resolves model calls through the stdio
 *  proxy rather than owning a transport. */
export const R97_ARM_ABI_MODEL_PROXY = "model-proxy-rpc-v1";

/** The full capability list a budget-aware arm build declares, versioned. */
export const R97_ARM_ABI: readonly string[] = [R97_ARM_ABI_MODEL_PROXY, R97_ARM_ABI_TOOL_BUDGET];
