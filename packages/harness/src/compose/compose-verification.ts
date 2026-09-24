/**
 * P22-1 — composition helper: VERIFICATION.
 *
 * Extracted from createHarness.ts verbatim (composition refactor only).
 * When the host supplies a task, the harness wires a TaskVerifier (P8-2:
 * every step emits verification.step_started/step_completed) and a plan
 * builder that derives specs from the change set + discovered commands when
 * the task declares none. Explicit task.verification always wins.
 */
import type { AgentEvent, TaskSpec, VerificationSpec, Verifier } from "@ar/contracts";
import { TaskVerifier } from "@ar/tools";
import { createVerificationPlanner } from "../verification-planner.js";
import type { CommandDiscoveryService } from "../command-discovery-service.js";
import type { HarnessConfig } from "../config.js";

export interface ComposedVerification {
  verificationPlanner:
    | ((input: { task: TaskSpec; changedPaths: string[]; cwd: string }) => VerificationSpec[] | Promise<VerificationSpec[]>)
    | undefined;
  verifier: Verifier | undefined;
}

/**
 * P22-1 — compose the verification planner + verifier. The planner is the
 * host's (when configured) or the derived change-set planner; the verifier is
 * the host's (when configured) or a TaskVerifier wired to emit step events.
 */
export function composeVerification(
  config: HarnessConfig,
  commandDiscovery: CommandDiscoveryService,
  appendHarnessEvent: (
    sessionId: string,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    extra?: { turnId?: string; timestamp?: number },
  ) => Promise<void>,
): ComposedVerification {
  const verificationPlanner =
    config.verification?.planner ??
    createVerificationPlanner({
      commands: () => commandDiscovery.maybeDiscover(config.cwd),
    });
  const verifier =
    config.verification?.verifier ??
    (config.task !== undefined
      ? new TaskVerifier({
          onStep: (event) => {
            if (event.sessionId === undefined) return;
            void appendHarnessEvent(
              event.sessionId,
              (event.phase === "started" ? "verification.step_started" : "verification.step_completed") as AgentEvent["type"],
              {
                ref: event.ref,
                kind: event.kind,
                ...(event.description !== undefined ? { description: event.description } : {}),
                ...(event.passed !== undefined ? { passed: event.passed } : {}),
                ...(event.detail !== undefined ? { detail: event.detail } : {}),
              },
            ).catch((err) =>
              process.stderr.write(`[degraded] verification-steps.append: ${err instanceof Error ? err.message : String(err)}\n`),
            );
          },
        })
      : undefined);
  return { verificationPlanner, verifier };
}
