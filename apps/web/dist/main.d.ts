/**
 * Web console entry: compose the production harness (@ar/harness, interactive
 * profile — 11 tools, §24 permission profile, JSONL stores under
 * HARNESS_DATA_DIR, OpenAI-compatible provider or stub), then assemble the
 * gateway + HTTP server on top of the same runtime.
 *
 * The gateway needs an RpcMethodRegistry (not the transport client returned
 * by the CLI), so a fresh registry is bound to the harness runtime; the
 * harness's agent id is used for new sessions.
 */
export declare function main(): Promise<number>;
//# sourceMappingURL=main.d.ts.map