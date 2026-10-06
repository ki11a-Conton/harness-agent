/** Read-only witnesses from actual ModelRequests. Never inject reference answers. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digest, filesIn, REPO } from "./execution-common.mjs";

function visibleStrings(value) {
  if (typeof value === "string") {
    try { return [value, ...visibleStrings(JSON.parse(value))]; } catch { return [value]; }
  }
  if (Array.isArray(value)) return value.flatMap(visibleStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(visibleStrings);
  return [];
}
export function sourceVisibilityWitnesses(requests, inputs, condition, mutationIndexes = [], readIndexes = {}) {
  const observations = [];
  const history = new Map(inputs.map(input => [input.path, false]));
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex++) {
    const request = requests[requestIndex];
    // Only model-visible system/message content; tool schemas and discarded
    // fixture/reference bytes are never counted as visible evidence.
    const text = [request.system ?? "", ...request.messages.flatMap(m => visibleStrings(m.content))].join("\n");
    for (const input of inputs) {
      const visible = input.lines.length > 0 && input.lines.every(line => text.includes(line));
      const readBefore = (readIndexes[input.path] ?? []).some(i => i < requestIndex);
      if (mutationIndexes.includes(requestIndex) && !visible && (history.get(input.path) || readBefore)) {
        observations.push({ path: input.path, requestIndex, lineDigest: digest(input.lines),
          kind: history.get(input.path) ? "SEEN_THEN_ABSENT" : "READ_LINES_ABSENT_AT_EDIT" });
      }
      if (visible) history.set(input.path, true);
    }
  }
  return { observed: observations.length > 0, editMomentsObserved: mutationIndexes.length, observations,
    note: "Literal visibility at a request leading to an observed write/edit dispatch. Not a semantic sufficiency oracle. Missing dispatch evidence (including bounded-away events) means NOT_OBSERVED." };
}
export function conditionProbe(experiment, records, pairs = []) {
  const entries = [];
  for (const c of experiment.manifest.cases) {
    if (!["compact-drop", "preview", "rehydrate", "partial"].includes(c.condition)) continue;
    const fixture = join(REPO, experiment.prereg.dataset.caseRoot, c.caseId, "fixture");
    const targets = new Set(Object.keys(c.referenceFix ?? {}));
    const inputs = filesIn(fixture).filter(f => !targets.has(f.path) && !f.path.endsWith(".js")).map(f => ({ path: f.path,
      // These corpora use repeated comment padding; probe actual data lines.
      lines: readFileSync(join(fixture, f.path), "utf8").split(/\r?\n/).map(line => line.trim())
        .filter(line => line.length > 0 && line.length <= 300 && !/^([#;]|\/\/|\/\*|\*)/.test(line)) }));
    for (let repetition = 0; repetition < experiment.prereg.schedule.repetitions; repetition++) for (const arm of ["baseline", "candidate"]) {
      const selected = records.filter(r => r.scope?.caseId === c.caseId && r.scope?.repetition === repetition && r.scope?.arm === arm);
      const outcome = pairs.find(p => p.caseId === c.caseId && p.repetition === repetition)?.[arm]?.outcome;
      const started = new Set((outcome?.events ?? []).filter(e => e.type === "tool.started").map(e => e.payload?.toolCallId));
      const mutationIndexes = selected.flatMap((r, i) => (r.toolCalls ?? []).some(call =>
        ["write_file", "edit_file"].includes(call.name) && targets.has(call.args?.path) && started.has(call.id)) ? [i] : []);
      const readIndexes = Object.fromEntries(inputs.map(input => [input.path, selected.flatMap((r, i) => (r.toolCalls ?? []).some(call =>
        call.name === "read_file" && call.args?.path === input.path && started.has(call.id)) ? [i] : [])]));
      entries.push({ caseId: c.caseId, repetition, arm, condition: c.condition,
        ...sourceVisibilityWitnesses(selected.map(r => r.request), inputs, c.condition, mutationIndexes, readIndexes) });
    }
  }
  return { schemaVersion: "n7-condition-probe-v1", evidenceKind: "OBSERVED_MODEL_REQUESTS", entries };
}
