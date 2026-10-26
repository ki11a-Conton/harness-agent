import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyManagedBrowserChecks } from "./managed-checks.mjs";

// Names from the actual successful native-browser receipt, independently of
// the validator's list. Keep the new production status RPC assertion required.
const receipt = () => ({ status: "PASS", complete: true, paidModelCalls: 0, errors: [], checks: [
  "actual-workspace-owner", "actual-permission-confirmation", "actual-started-command",
  "actual-http-poll-output-and-exit", "actual-original-verifier-passed",
  "actual-ui-command-status-projection-and-verifier", "actual-stop-button-cancels-owner",
  "cancel-ack-no-late-file", "each-logical-command-started-once", "no-browser-errors",
].map(name => ({ name, status: "PASS" })) });

test("accepts all ten actual managed-browser checks in any order", () => {
  const report = receipt(); assert.equal(verifyManagedBrowserChecks(report), 10);
  report.checks.reverse(); assert.equal(verifyManagedBrowserChecks(report), 10);
});
test("rejects the old nine-check report missing status RPC evidence", () => {
  const report = receipt(); report.checks.splice(5, 1);
  assert.throws(() => verifyManagedBrowserChecks(report));
});
test("rejects equal counts with an unrelated or duplicate PASS substituted", () => {
  for (const name of ["unrelated-pass", "actual-workspace-owner"]) {
    const report = receipt(); report.checks[5].name = name;
    assert.throws(() => verifyManagedBrowserChecks(report));
  }
});
test("rejects failed checks even when the overall report claims PASS", () => {
  const report = receipt(); report.checks[5].status = "FAIL";
  assert.throws(() => verifyManagedBrowserChecks(report));
});
for (const [field, value] of [["status", "FAIL"], ["complete", false], ["paidModelCalls", 1], ["errors", ["page failed"]]]) {
  test(`rejects invalid ${field} receipts`, () => {
    const report = receipt(); report[field] = value;
    assert.throws(() => verifyManagedBrowserChecks(report));
  });
}
