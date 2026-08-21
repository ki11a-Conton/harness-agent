import { buildVerificationPlan, planToVerificationSpecs } from "@ar/tools";
export function createVerificationPlanner(deps = {}) {
    return async ({ changedPaths, cwd }) => {
        const hints = typeof deps.commands === "function" ? await deps.commands() : deps.commands;
        const plan = buildVerificationPlan({
            root: cwd,
            filesChanged: changedPaths,
            ...(hints !== undefined ? { commands: hints.commands } : {}),
        });
        return planToVerificationSpecs(plan);
    };
}
//# sourceMappingURL=verification-planner.js.map