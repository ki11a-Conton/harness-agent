import assert from "node:assert/strict";
import { test } from "node:test";
import { observeReadOverlap } from "./observe-read-overlap.mjs";

const sourcePath = "/fixture/source.cjs";
function fixture(at = 150) {
  return {
    sourcePath, starts: [{ pid: 1234, at: 100 }], exits: [{ code: 0, at: 200 }],
    events: [
      { type: "tool.started", sessionId: "session_1", turnId: "turn_1", sequence: 10, timestamp: at - 5,
        payload: { tool: "read_file", toolCallId: "call_1" } },
      { type: "tool.completed", sessionId: "session_1", turnId: "turn_1", sequence: 11, timestamp: at + 5,
        payload: { tool: "read_file", toolCallId: "call_1", status: "success", evidence: [
          { type: "file", source: sourcePath, timestamp: at },
        ] } },
      // Runtime adds another span event after the orchestrator's actual result.
      { type: "tool.completed", sessionId: "session_1", turnId: "turn_1", sequence: 12, timestamp: at + 6,
        payload: { tool: "read_file", toolCallId: "call_1", durationMs: 11 } },
    ],
  };
}
const observed = input => observeReadOverlap(input).overlapObserved;
const completion = input => input.events[1];
const evidence = input => completion(input).payload.evidence[0];

test("uses the successful source read even when the next model request comes after command exit", () => {
  // Timestamps from paired-overlap-causal.json's actual clean-ee58f170 Harness:
  // actual read 3807 < exit 3818 < next model 3823. Scheduling isn't the action.
  const value = fixture(1793030083807);
  value.starts[0].at = 1793030083758; value.exits[0].at = 1793030083818;
  value.timeline = [{ stage: "observe", at: 1793030083823 }];
  assert.equal(value.starts[0].at < value.timeline[0].at && value.timeline[0].at < value.exits[0].at, false);
  const proof = observeReadOverlap(value);
  assert.equal(proof.overlapObserved, true);
  assert.deepEqual(proof.reads.map(read => read.at), [1793030083807]);
});
test("rejects the actual after-completion read even when an unrelated model timestamp looks live", () => {
  const value = fixture(1793030083839);
  value.starts[0].at = 1793030083758; value.exits[0].at = 1793030083818;
  value.timeline = [{ stage: "observe", at: 1793030083807 }];
  assert.equal(observed(value), false);
});
test("a source read before the command starts is not overlap", () => assert.equal(observed(fixture(90)), false));
test("the command boundaries themselves are not positive overlap", () => {
  assert.equal(observed(fixture(100)), false); assert.equal(observed(fixture(200)), false);
});
test("a known nonzero exit still proves that a command was running during an earlier read", () => {
  const value = fixture(); value.exits[0].code = 1;
  assert.equal(observed(value), true);
});
test("serial repair attempts pair with their own exits, without borrowing a later attempt", () => {
  const value = fixture(350);
  value.starts.push({ pid: 5678, at: 300 }); value.exits.push({ code: 0, at: 400 });
  assert.equal(observed(value), true);
  value.exits = [{ code: 0, at: 400 }];
  assert.equal(observed(value), false);
});
test("unknown command exit cannot be treated as infinity", () => {
  const value = fixture(); value.exits = [];
  assert.equal(observed(value), false);
});
test("unknown later exit does not invalidate an already evidenced earlier serial interval", () => {
  const value = fixture(); value.starts.push({ pid: 5678, at: 300 });
  assert.equal(observed(value), true);
  evidence(value).timestamp = 350; value.events[0].timestamp = 345; completion(value).timestamp = 355;
  assert.equal(observed(value), false);
});
test("conflicting or overlapping owner intervals do not guess which process exited", () => {
  for (const mutate of [
    value => value.starts.push({ pid: 5678, at: 120 }),
    // An unkeyed exit at the next start instant could belong to that new
    // attempt; it cannot supply the earlier missing exit.
    value => value.starts.push({ pid: 5678, at: 200 }),
    value => { value.exits[0].pid = 5678; },
    value => value.exits.push({ code: 0, at: 180 }),
    value => value.starts.push({ pid: 5678, at: 100 }),
  ]) { const value = fixture(); mutate(value); assert.equal(observed(value), false); }
});

for (const [label, mutate] of [
  ["no events", value => { value.events = []; }],
  ["missing started event", value => { value.events.shift(); }],
  ["only started event", value => { value.events.splice(1); }],
  ["missing file evidence", value => { completion(value).payload.evidence = []; }],
  ["wrong evidence path", value => { evidence(value).source = "/fixture/other.cjs"; }],
  ["wrong evidence kind", value => { evidence(value).type = "command"; }],
  ["failed read", value => { completion(value).payload.status = "failed"; }],
  ["cancelled read", value => { completion(value).payload.status = "cancelled"; }],
  ["status-free span with evidence", value => { delete completion(value).payload.status; }],
  ["wrong completed tool", value => { completion(value).payload.tool = "exec_poll"; }],
  ["wrong started tool", value => { value.events[0].payload.tool = "exec_poll"; }],
  ["wrong call id", value => { completion(value).payload.toolCallId = "call_other"; }],
  ["wrong session", value => { completion(value).sessionId = "session_other"; }],
  ["wrong turn", value => { completion(value).turnId = "turn_other"; }],
  ["missing call id", value => { delete completion(value).payload.toolCallId; }],
  ["missing session identity", value => { delete completion(value).sessionId; }],
  ["read before tool start", value => { evidence(value).timestamp = 140; }],
  ["read after completed envelope", value => { evidence(value).timestamp = 160; }],
  ["completed before started", value => { completion(value).timestamp = 140; }],
  ["inverted event sequence", value => { completion(value).sequence = 9; }],
  ["duplicate started event", value => { value.events.push(structuredClone(value.events[0])); }],
  ["conflicting failure for same call", value => { value.events.push({ ...structuredClone(completion(value)), type: "tool.failed" }); }],
]) test(`does not pass on ${label}`, () => {
  const value = fixture(); mutate(value); assert.equal(observed(value), false);
});

test("an unrelated failed call does not erase the success proof for the actual read", () => {
  const value = fixture();
  const failure = structuredClone(completion(value)); failure.type = "tool.failed"; failure.payload.toolCallId = "unrelated";
  value.events.push(failure); assert.equal(observed(value), true);
});
for (const invalid of [undefined, null, NaN, Infinity, -1, 1.5, "150", Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid times cannot produce overlap: ${String(invalid)}`, () => {
    for (const mutate of [
      value => { evidence(value).timestamp = invalid; },
      value => { value.events[0].timestamp = invalid; },
      value => { completion(value).timestamp = invalid; },
      value => { value.starts[0].at = invalid; },
      value => { value.exits[0].at = invalid; },
    ]) { const value = fixture(); mutate(value); assert.equal(observed(value), false); }
  });
}
test("invalid or missing process/exit evidence cannot produce overlap", () => {
  for (const mutate of [
    value => { value.starts = []; }, value => { delete value.starts[0].pid; },
    value => { value.starts[0].pid = -1; }, value => { delete value.exits[0].code; },
    value => { value.exits[0].code = null; }, value => { value.exits[0].at = 90; },
  ]) { const value = fixture(); mutate(value); assert.equal(observed(value), false); }
});
test("missing observer inputs fail closed without touching external state", () => {
  assert.deepEqual(observeReadOverlap(), { overlapObserved: false, reads: [], commandIntervals: [] });
  assert.equal(observed({ events: null, starts: null, exits: null, sourcePath: null }), false);
});
test("observer preserves all caller-owned evidence", () => {
  const value = fixture(), original = structuredClone(value);
  assert.equal(observed(value), true); assert.deepEqual(value, original);
});
