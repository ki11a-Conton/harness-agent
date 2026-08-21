import { randomUUID } from "node:crypto";
const PREFIXES = {
    session: "session_",
    turn: "turn_",
    message: "message_",
    toolcall: "toolcall_",
    approval: "approval_",
    event: "event_",
    run: "run_",
    checkpoint: "checkpoint_",
    memory: "memory_",
    skill: "skill_",
    agent: "agent_",
    job: "job_",
    process: "proc_",
    trace: "trace_",
    prompt: "prompt_",
    artifact: "artifact_",
    ask: "ask_",
    modelcall: "modelcall_",
};
/** Production ID source: random UUID (unique, non-deterministic). */
let idSource = randomUUID;
/** Override the global ID source; pass null to restore the default randomUUID.
 *  Q-8: tests install a deterministic generator for reproducible event/model
 *  snapshots, then MUST restore it (the returned disposer does that). */
export function installIdSource(source) {
    idSource = source ?? randomUUID;
}
/**
 * Install a deterministic, counter-based ID source for reproducible snapshots.
 * Returns a disposer that restores the previously active source.
 *
 * The counter resets on every install, so the same call sequence always yields
 * the same IDs (fully replayable). Suffixes are globally-unique per call, so
 * no cross-type collisions occur even though the value space is small.
 */
export function installDeterministicIds() {
    const previous = idSource;
    let counter = 0;
    idSource = () => `d${(++counter).toString().padStart(8, "0")}`;
    return () => {
        idSource = previous;
    };
}
function make(prefix) {
    return `${PREFIXES[prefix] ?? `${prefix}_`}${idSource()}`;
}
export function newSessionId() {
    return make("session");
}
export function newTurnId() {
    return make("turn");
}
export function newMessageId() {
    return make("message");
}
export function newToolCallId() {
    return make("toolcall");
}
export function newApprovalId() {
    return make("approval");
}
export function newEventId() {
    return make("event");
}
export function newRunId() {
    return make("run");
}
export function newCheckpointId() {
    return make("checkpoint");
}
export function newMemoryId() {
    return make("memory");
}
export function newSkillId() {
    return make("skill");
}
export function newAgentId() {
    return make("agent");
}
export function newJobId() {
    return make("job");
}
export function newProcessId() {
    return make("process");
}
export function newTraceId() {
    return make("trace");
}
export function newPromptId() {
    return make("prompt");
}
export function newArtifactId() {
    return make("artifact");
}
export function newAskId() {
    return make("ask");
}
export function newModelCallId() {
    return make("modelcall");
}
export function isId(prefix, value) {
    return value.startsWith(`${prefix}_`);
}
//# sourceMappingURL=ids.js.map