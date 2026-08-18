import { AgentError } from "@ar/contracts";
export { AgentError };
export type { AgentErrorInfo } from "@ar/contracts";

export function toAgentError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  if (err instanceof Error) {
    return new AgentError({
      code: "INTERNAL_ERROR",
      message: err.message,
      retryable: false,
      safeToRetry: false,
      cause: err,
    });
  }
  return new AgentError({
    code: "INTERNAL_ERROR",
    message: String(err),
    retryable: false,
    safeToRetry: false,
    cause: err,
  });
}