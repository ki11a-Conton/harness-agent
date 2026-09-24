let calls = 0;
export function compute(key) { calls += 1; return key + calls; }
export function get(key) { return compute(key); }
export function callCount() { return calls; }
