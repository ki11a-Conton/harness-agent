// Measure completed file reads against evidenced command lifetimes. Model
// request scheduling is deliberately not an input to this pure observer.
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const validPid = value => Number.isSafeInteger(value) && value > 0;
const nonempty = value => typeof value === "string" && value.length > 0;
const keyOf = event => nonempty(event?.sessionId) && nonempty(event?.turnId)
  && nonempty(event?.payload?.toolCallId)
  ? JSON.stringify([event.sessionId, event.turnId, event.payload.toolCallId]) : undefined;

/**
 * starts/exits are the existing fixture journals: starts have {pid,at}, exits
 * have {code,at} (and may have pid). An unkeyed exit is attributable only in a
 * serial journal: start_i <= exit_i < start_(i+1). Missing/ambiguous evidence
 * cannot be replaced by an infinite end time or an exit from a later attempt.
 */
function commandIntervals(starts, exits) {
  if (!Array.isArray(starts) || !Array.isArray(exits) || exits.length > starts.length
    || starts.some(s => !validPid(s?.pid) || !validTime(s?.at))
    || exits.some(e => !validTime(e?.at) || !Number.isSafeInteger(e?.code) || e.code < 0
      || (e.pid !== undefined && !validPid(e.pid)))) return [];
  const orderedStarts = [...starts].sort((a, b) => a.at - b.at);
  const orderedExits = [...exits].sort((a, b) => a.at - b.at);
  // Equal start instants or overlapping unkeyed journals are not an identified
  // owner interval. Reject rather than guessing which process ended.
  if (orderedStarts.some((s, i) => i > 0 && s.at <= orderedStarts[i - 1].at)) return [];
  const intervals = [];
  for (let i = 0; i < orderedExits.length; i++) {
    const start = orderedStarts[i], exit = orderedExits[i], next = orderedStarts[i + 1];
    if (exit.at < start.at || (next && exit.at >= next.at)
      || (exit.pid !== undefined && exit.pid !== start.pid)) return [];
    intervals.push({ pid: start.pid, startedAt: start.at, exitedAt: exit.at, exitCode: exit.code });
  }
  return intervals;
}

/** Return the actual success-evidence timestamps, not a subsequent model call.
 * Exact path identity is intentional: a different read cannot prove overlap.
 * A metadata-only Core tool.completed span lacks status/evidence and is ignored.
 */
function successfulReads(events, sourcePath) {
  if (!Array.isArray(events) || !nonempty(sourcePath)) return [];
  const started = new Map(), invalidCalls = new Set();
  for (const event of events) {
    const key = keyOf(event);
    if (key === undefined) continue;
    if (event.type === "tool.started") {
      if (started.has(key)) invalidCalls.add(key);
      else started.set(key, event);
    }
    if (event.type === "tool.failed"
      || (event.type === "tool.completed" && event.payload.status !== undefined
        && (event.payload.status !== "success" || event.payload.tool !== "read_file"))) invalidCalls.add(key);
  }
  const reads = [];
  for (const event of events) {
    const key = keyOf(event), start = started.get(key);
    if (!start || invalidCalls.has(key) || event.type !== "tool.completed"
      || start.payload.tool !== "read_file" || event.payload.tool !== "read_file"
      || event.payload.status !== "success" || !validTime(start.timestamp)
      || !validTime(event.timestamp) || event.timestamp < start.timestamp
      || !Array.isArray(event.payload.evidence)) continue;
    // Sequence is present in the production journal. If a caller supplies it,
    // an inverted/invalid causal ordering must not manufacture a valid read.
    if ((start.sequence !== undefined || event.sequence !== undefined)
      && (!Number.isSafeInteger(start.sequence) || !Number.isSafeInteger(event.sequence)
        || start.sequence >= event.sequence)) continue;
    for (const evidence of event.payload.evidence) {
      if (evidence?.type === "file" && evidence.source === sourcePath && validTime(evidence.timestamp)
        && start.timestamp <= evidence.timestamp && evidence.timestamp <= event.timestamp) {
        reads.push({ toolCallId: event.payload.toolCallId, sessionId: event.sessionId,
          turnId: event.turnId, at: evidence.timestamp });
      }
    }
  }
  return reads;
}

/**
 * Positive overlap needs one completed, correctly correlated source-file read
 * strictly inside one known command interval. The proof material is returned
 * for receipts; missing/failed reads or unknown exits always leave it false.
 */
export function observeReadOverlap({ events, starts, exits, sourcePath } = {}) {
  const reads = successfulReads(events, sourcePath);
  const intervals = commandIntervals(starts, exits);
  return {
    overlapObserved: reads.some(read => intervals.some(interval =>
      interval.startedAt < read.at && read.at < interval.exitedAt)),
    reads,
    commandIntervals: intervals,
  };
}
