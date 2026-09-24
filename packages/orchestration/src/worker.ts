/**
 * P33-10 — Worker drives the App Server, not Core.
 *
 * The worker is a thin adapter: given a workspace and a prompt, it starts a
 * harness thread through the SDK (`HarnessClient`), consumes turn events, and
 * can be interrupted (reconcile invalidation, cancellation) via abort signal.
 *
 * This validates the App Server boundary (P29) under a real higher-level
 * consumer: orchestration depends on @ar/sdk, never on @ar/core internals.
 */
import type { HarnessClient, RunResult } from "@ar/sdk";

export interface WorkerRequest {
  readonly itemId: string;
  readonly prompt: string;
  readonly workspaceDir: string;
  readonly agentName: string;
}

export interface WorkerResult {
  readonly status: "completed" | "failed" | "interrupted";
  readonly turnId?: string;
  readonly error?: { code?: string; message: string; retryable?: boolean };
  /** Reduced final response text, when the agent produced one. */
  readonly output?: string;
}

/**
 * Runs ONE work item. `client` is supplied per-worker; a no-op no-op client
 * can be injected in tests. The implementation is deliberately minimal —
 * correctness of retry/reconcile lives in the orchestrator, not here.
 */
export async function runWorker(
  client: Pick<HarnessClient, "startThread">,
  req: WorkerRequest,
  signal?: AbortSignal,
): Promise<WorkerResult> {
  const thread = await client.startThread({
    agentName: req.agentName,
    cwd: req.workspaceDir,
  });
  let result: RunResult;
  try {
    const { done } = await thread.runStreamed(req.prompt, { signal });
    result = await done;
  } catch (error) {
    return {
      status: "failed",
      error: {
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
  return {
    status: result.status === "interrupted" ? "interrupted" : result.status === "failed" ? "failed" : "completed",
    turnId: result.turnId,
    output: result.finalResponse,
    error: result.error,
  };
}