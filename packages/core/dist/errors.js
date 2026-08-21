import { AgentError } from "@ar/contracts";
export { AgentError };
export function toAgentError(err) {
    if (err instanceof AgentError)
        return err;
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
//# sourceMappingURL=errors.js.map