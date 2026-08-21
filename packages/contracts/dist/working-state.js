/** P0-12: apply a single mutation to a WorkingState (mutates in place). */
export function applyWorkingStateMutation(state, mutation) {
    switch (mutation.op) {
        case "set_constraints":
            state.constraints = mutation.constraints;
            return `constraints: ${mutation.constraints.join(", ")}`;
        case "set_plan":
            state.plan = mutation.steps;
            return `plan: ${mutation.steps.join(", ")}`;
        case "mark_completed": {
            state.completed.push(mutation.step);
            const idx = state.pending.indexOf(mutation.step);
            if (idx !== -1)
                state.pending.splice(idx, 1);
            return `completed: ${mutation.step}`;
        }
        case "set_pending":
            state.pending = mutation.steps;
            return `pending: ${mutation.steps.join(", ")}`;
        case "add_decision":
            state.decisions.push(mutation.decision);
            return `decision: ${mutation.decision}`;
        case "add_fact":
            state.importantFacts.push(mutation.fact);
            return `fact: ${mutation.fact}`;
        case "add_open_question":
            state.openQuestions.push(mutation.question);
            return `question: ${mutation.question}`;
        case "resolve_open_question": {
            const idx = state.openQuestions.indexOf(mutation.question);
            if (idx !== -1)
                state.openQuestions.splice(idx, 1);
            return `resolved: ${mutation.question}`;
        }
    }
}
/** Empty working state with the goal pre-filled. */
export function newWorkingState(goal) {
    return {
        goal,
        constraints: [],
        plan: [],
        decisions: [],
        completed: [],
        pending: [],
        filesChanged: [],
        commandsRun: [],
        testsRun: [],
        failures: [],
        importantFacts: [],
        openQuestions: [],
        toolRefs: [],
        artifactRefs: [],
        memoryRefs: [],
        childAgentRefs: [],
    };
}
//# sourceMappingURL=working-state.js.map