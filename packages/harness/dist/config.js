export const DEFAULT_FEATURE_FLAGS = {
    context: true,
    checkpoint: true,
    artifacts: true,
    memory: false,
    learning: false,
    skills: true,
    delegation: false,
    mcp: false,
    plugins: false,
    observability: true,
};
export const DEFAULT_CONTEXT_BUDGET = {
    maxTokens: 32_000,
    reserved: { system: 1_500, task: 2_000, output: 2_000 },
    dynamic: 0,
};
//# sourceMappingURL=config.js.map