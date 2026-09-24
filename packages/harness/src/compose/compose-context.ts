/**
 * P22-1 — composition helper: CONTEXT / KNOWLEDGE.
 *
 * Extracted from createHarness.ts verbatim (composition refactor only).
 * Owns the context pipeline (+ telemetry routing), the context budget
 * resolution, skill discovery, and the P7-6 lazy command discovery service.
 */
import type { AgentEvent, ContextBudget } from "@ar/contracts";
import { ContextPipeline } from "@ar/context";
import { budgetForCapabilities, resolveCapabilities } from "@ar/model";
import { FileSkillLoader } from "@ar/skills";
import type { SkillDiscovery, SkillSecurityDenialRecord } from "@ar/core";
import { CommandDiscoveryService } from "../command-discovery-service.js";
import { DEFAULT_CONTEXT_BUDGET, type HarnessConfig, type HarnessFeatureFlags } from "../config.js";

export interface ComposedContext {
  pipeline: ContextPipeline;
  budget: ContextBudget;
  budgetFallback: boolean;
  skillLoader: FileSkillLoader;
  /** P2-8: skill discovery wrapper that also surfaces security denials. */
  discoverSkills: () => Promise<SkillDiscovery>;
  commandDiscovery: CommandDiscoveryService;
  /** Mutable security-denial ledger (also appended by the skill body gate). */
  pendingSkillSecurity: { value: SkillSecurityDenialRecord[] };
}

/** P22-1 — compose the context pipeline, budget, skill discovery and command
 *  discovery. Extracted verbatim; the telemetry routing and skill-security
 *  stderr reporting are unchanged. */
export async function composeContext(
  config: HarnessConfig,
  features: HarnessFeatureFlags,
  cwd: string,
  dataDir: string | undefined,
  appendHarnessEvent: (
    sessionId: string,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    extra?: { turnId?: string; timestamp?: number },
  ) => Promise<void>,
): Promise<ComposedContext> {
  // P6-3: context selection telemetry — the pipeline reports facts, the
  // harness routes them into the event stream (never content, only
  // source/priority/tokens/reason).
  const pipeline = new ContextPipeline({
    onTelemetry: (event) => {
      // candidate facts without a quarantine reason are noise — skip.
      if (event.sessionId === undefined || (event.phase === "candidate" && event.reason !== "quarantine-envelope")) {
        return;
      }
      const type =
        event.phase === "compacted"
          ? "context.compacted"
          : event.phase === "selected"
            ? "context.selected"
            : event.phase === "dropped"
              ? "context.dropped"
              : "context.candidate";
      void appendHarnessEvent(
        event.sessionId,
        type as AgentEvent["type"],
        {
          source: event.source,
          ...(event.id !== undefined ? { id: event.id } : {}),
          ...(event.priority !== undefined ? { priority: event.priority } : {}),
          ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      ).catch((err) =>
        process.stderr.write(`[degraded] context-telemetry.append: ${err instanceof Error ? err.message : String(err)}\n`),
      );
    },
  });
  const { budget, budgetFallback } = await resolveContextBudget(config);

  // --- skills (P2-8) --------------------------------------------------------
  const pendingSkillSecurity: { value: SkillSecurityDenialRecord[] } = { value: [] };
  const skillLoader = new FileSkillLoader({
    onSecurityDenied: (event) => {
      pendingSkillSecurity.value.push({
        detection: event.detection,
        reasons: event.reasons,
        path: event.path,
        source: event.source,
      });
      process.stderr.write(
        `[skill denied] detection=${event.detection} target=${event.path} reasons=${event.reasons.join(",")}\n`,
      );
    },
  });
  const skillRoots = (process.env.AR_SKILL_ROOTS ?? "")
    .split(";")
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
  const discoverSkills: () => Promise<SkillDiscovery> = async () => {
    pendingSkillSecurity.value = [];
    const found = await skillLoader.discover({ roots: skillRoots, maxSkills: 100 });
    const security = pendingSkillSecurity.value;
    return { skills: found, security };
  };

  // P7-6: lazy command discovery for code-changing turns (persisted hints).
  const commandDiscovery =
    dataDir !== undefined ? new CommandDiscoveryService({ dataDir }) : new CommandDiscoveryService();
  if (dataDir !== undefined) {
    await commandDiscovery.loadPersisted().catch((err) =>
      process.stderr.write(`[degraded] command-discovery.loadPersisted: ${err instanceof Error ? err.message : String(err)}\n`),
    );
  }

  return {
    pipeline,
    budget,
    budgetFallback,
    skillLoader,
    discoverSkills,
    commandDiscovery,
    pendingSkillSecurity,
  };
}

/** P22-1 — resolve the context budget from config (explicit) or model
 *  capabilities (fallback with a conservative default when unknown). */
export async function resolveContextBudget(config: HarnessConfig): Promise<{
  budget: ContextBudget;
  budgetFallback: boolean;
}> {
  if (config.contextBudget !== undefined) return { budget: config.contextBudget, budgetFallback: false };
  let info;
  try {
    const infos = await config.modelProvider.listModels();
    info = infos.find((m) => m.id === config.model.modelId);
  } catch {
    info = undefined; // provider listModels failure → conservative fallback
  }
  const caps = resolveCapabilities(config.model, info, undefined);
  const windowTokens = budgetForCapabilities(caps);
  if (windowTokens === undefined) {
    process.stderr.write(
      `[harness] context budget: model capabilities unknown for ${config.model.providerId}/${config.model.modelId} — using conservative fallback ${DEFAULT_CONTEXT_BUDGET.maxTokens}\n`,
    );
    return { budget: DEFAULT_CONTEXT_BUDGET, budgetFallback: true };
  }
  return {
    budget: {
      maxTokens: windowTokens,
      reserved: { system: 1_500, task: 2_000, output: 2_000 },
      dynamic: 0,
    },
    budgetFallback: false,
  };
}
