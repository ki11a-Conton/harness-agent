import assert from "node:assert/strict";

// One explicit contract for the browser report and both installed wrappers.
// Adding a check must update this list; unrelated PASS rows cannot substitute.
export const MANAGED_BROWSER_CHECKS = Object.freeze([
  "actual-workspace-owner",
  "actual-permission-confirmation",
  "actual-started-command",
  "actual-http-poll-output-and-exit",
  "actual-original-verifier-passed",
  "actual-ui-command-status-projection-and-verifier",
  "actual-stop-button-cancels-owner",
  "cancel-ack-no-late-file",
  "each-logical-command-started-once",
  "no-browser-errors",
]);

export function verifyManagedBrowserChecks(report) {
  assert.equal(report.status, "PASS");
  assert.equal(report.complete, true);
  assert.equal(report.paidModelCalls, 0);
  assert.deepEqual(report.errors, []);
  assert(Array.isArray(report.checks));
  assert.deepEqual(report.checks.map(check => check.name).sort(), [...MANAGED_BROWSER_CHECKS].sort());
  assert(report.checks.every(check => check.status === "PASS"));
  return report.checks.length;
}
