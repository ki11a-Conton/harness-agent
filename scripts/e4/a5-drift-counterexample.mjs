// E4-R105 (A5 / F5) — THE DRIFT COUNTEREXAMPLE, MEASURED RATHER THAN DESCRIBED.
//
// Plan §A5 交付: "交付一张小型 verdict 优先级表和漂移反例." This script produces the
// counterexample by DRIVING the real worker against a protocol-fixture arm, so the
// record it prints is a measurement of the shipped code rather than a restatement
// of the fix's own comments.
//
// WHAT IT BUILDS. A synthetic arm whose `apps/cli/dist/benchmark-command.js`:
//
//   1. prints a DRY-RUN plan that names the APPROVED model (so the pre-dispatch
//      identity check passes and the refusal cannot be blamed on the plan);
//   2. hands the core runtime's `createClient` an UNAPPROVED model ref;
//   3. writes a report claiming `verification_passed: true`.
//
// That is exactly the fixture plan §A5 怎么做 1 prescribes: "批准 approved-model；
// dry-run 声明正确模型；实际 createClient 使用 unapproved-model；最终写一个
// verification_passed=true 的合成报告."
//
// The synthetic PASS it produces is a PROTOCOL FIXTURE and must never be counted
// into a real benchmark result.
//
// Usage: node scripts/e4/a5-drift-counterexample.mjs

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CASE_ID = "r98-tool-write-request";
const APPROVED_MODEL = "approved-model";
const RUNTIME_MODEL = "unapproved-model";

const worker = await import(pathToFileURL(join(HERE, "r97-arm-worker.mjs")).href);

/**
 * A SELF-CONTAINED stand-in for the arm's `packages/model/dist/index.js`.
 *
 * A COPY of the real built model package would need the workspace's `@ar/*` links,
 * and linking them would make this script depend on the machine's install layout
 * rather than on the worker's contract. The object shape is the only thing this
 * fixture needs, and the arm's own CLI never parses its events (it drains the
 * stream), so a minimal shape is an honest stand-in here.
 */
const SYNTHETIC_MODEL = `export class ScriptedModelProvider {
  constructor(scripts) {
    this.scripts = scripts;
    this.calls = [];
    this.index = 0;
    this.id = "scripted";
  }
  async listModels() {
    return [{ id: "scripted-model", name: "Scripted" }];
  }
  createClient() {
    const p = this;
    return {
      generate: async function* () {
        const i = p.index;
        p.index += 1;
        p.calls.push(i);
        const script = p.scripts[i];
        if (script) yield* script;
      },
    };
  }
  static text(text) {
    return [
      { type: "started", timestamp: 0 },
      { type: "text_delta", text, timestamp: 0 },
      { type: "completed", result: { finishReason: "stop", text }, timestamp: 0 },
    ];
  }
  static toolCall(name, args = {}) {
    const id = "tc-" + Math.random().toString(16).slice(2);
    return [
      { type: "started", timestamp: 0 },
      { type: "tool_call_delta", toolCall: { id, name, args }, timestamp: 0 },
      { type: "completed", result: { finishReason: "tool_calls", toolCalls: [{ id, name, args }] }, timestamp: 0 },
    ];
  }
}
`;

const CLI_SOURCE = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ScriptedModelProvider } from "../../../packages/model/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const DISPATCH_LOG = join(here, "dispatch.log");
const CLIENT_LOG = join(here, "clients.json");

const DECLARED_MODEL = ${JSON.stringify(APPROVED_MODEL)};
const RUNTIME_MODEL = ${JSON.stringify(RUNTIME_MODEL)};
const CASE_ID = ${JSON.stringify(CASE_ID)};

export { ScriptedModelProvider };

function argOf(argv, flag) {
  const i = Array.isArray(argv) ? argv.indexOf(flag) : -1;
  return i >= 0 ? argv[i + 1] : null;
}

export async function runBenchmarkCommand(argv, providerOverride) {
  if (Array.isArray(argv) && argv.includes("--dry-run")) {
    // The dry run binds the APPROVED model, so the pre-dispatch check passes and
    // the drift can only be caught at the createClient boundary.
    return {
      exitCode: 0,
      lines: [JSON.stringify({ planDigest: null, providerId: "openai", modelId: DECLARED_MODEL, endpointIdentity: null })],
    };
  }
  appendFileSync(DISPATCH_LOG, "dispatch\\n");
  writeFileSync(CLIENT_LOG, JSON.stringify([{ providerId: "openai", modelId: RUNTIME_MODEL }]));
  try {
    const client = providerOverride.createClient({ providerId: "openai", modelId: RUNTIME_MODEL }, {});
    const controller = new AbortController();
    for await (const _ev of client.generate({ messages: [{ role: "user", content: "a5" }] }, controller.signal)) {
      // Drain the scripted stream.
    }
  } catch (err) {
    appendFileSync(DISPATCH_LOG, "refused: " + (err && err.message ? err.message : String(err)) + "\\n");
  }
  // THE SYNTHETIC PASS: a report that claims success. Before the fix this row
  // overwrote the identity refusal and the unit was scored as a completed pass.
  const out = argOf(argv, "--out");
  const suite = argOf(argv, "--suite") || "regression";
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, suite === "regression" ? "baseline.json" : suite + ".json"),
    JSON.stringify({
      results: [{
        task_id: CASE_ID,
        suite,
        success: true,
        actual_status: "completed",
        verification_passed: true,
        verification_failures: [],
        model_calls: 1,
        tool_calls: 0,
        termination_reason: "stop",
        failure_category: null,
      }],
    }, null, 2),
  );
  return { exitCode: 0, lines: ["synthetic identity fixture: done"] };
}
`;

const claims = await mkdtemp(join(tmpdir(), "a5-drift-claims-"));
process.env.R97_CAMPAIGN_CLAIMS_DIR = claims;
const armDir = await mkdtemp(join(tmpdir(), "a5-drift-arm-"));
const root = await mkdtemp(join(tmpdir(), "a5-drift-run-"));

try {
  // A real, COMPLETE build: the derived closure is copied, because
  // `armBuildIdentity` hashes the closure and a partial tree is "not established".
  for (const rel of worker.armBuildClosurePaths(REPO)) {
    const dest = join(armDir, ...rel.split("/"));
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(REPO, ...rel.split("/")), dest);
  }
  await writeFile(join(armDir, "packages", "model", "dist", "index.js"), SYNTHETIC_MODEL, "utf8");
  await writeFile(join(armDir, "apps", "cli", "dist", "benchmark-command.js"), CLI_SOURCE, "utf8");
  await mkdir(join(armDir, "benchmarks", "r98-fixtures"), { recursive: true });
  await cp(join(REPO, "benchmarks", "r98-fixtures", CASE_ID), join(armDir, "benchmarks", "r98-fixtures", CASE_ID), {
    recursive: true,
  });
  const git = (args) => execFileSync("git", args, { cwd: armDir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["-c", "user.email=a5@example.invalid", "-c", "user.name=a5", "commit", "-q", "--allow-empty", "-m", "fixture arm"]);

  const build = worker.armBuildIdentity(armDir);
  const record = await worker.runArmUnit({
    checkoutDir: armDir,
    repoRoot: REPO,
    caseId: CASE_ID,
    suite: "regression",
    arm: "baseline",
    repetition: 1,
    planDigest: "5".repeat(64),
    approvedSourceSha: build.sourceSha,
    providerId: "openai",
    modelId: APPROVED_MODEL,
    endpointBaseUrl: null,
    executionStateDir: join(root, "state"),
    ledgerDir: join(root, "ledger"),
    outDir: join(root, "out"),
    timeoutMs: 120_000,
  });

  const clients = await readFile(join(armDir, "apps", "cli", "dist", "clients.json"), "utf8").then(
    (t) => JSON.parse(t),
    () => null,
  );
  const dispatchLog = await readFile(join(armDir, "apps", "cli", "dist", "dispatch.log"), "utf8").catch(
    () => "(the fixture's real path was never entered)\n",
  );

  console.log("=== VERDICT PRIORITY TABLE (most blocking first) ===");
  console.log(worker.R97_VERDICT_PRIORITY.map((c, i) => `  ${i + 1}. ${c}`).join("\n"));
  console.log("");
  if (record.executionIdentity === null) {
    console.log("THE UNIT NEVER REACHED THE EXECUTOR — refusing to describe a measurement");
    console.log("that was not taken:");
    console.log(JSON.stringify(record, null, 2));
    process.exitCode = 1;
  } else {
    console.log("=== DRIFT COUNTEREXAMPLE (measured, protocol fixture) ===");
    console.log(`  approved model          : ${APPROVED_MODEL}`);
    console.log(`  dry-run declared model  : ${record.executionIdentity.declaredModelId}`);
    console.log(`  createClient model refs : ${JSON.stringify(clients)}`);
    console.log(`  runtime model ref       : ${record.executionIdentity.runtimeModelId}`);
    console.log(`  drift                   : ${JSON.stringify(record.executionIdentity.drift)}`);
    console.log(`  synthetic report claim  : verification_passed=${record.report?.verification_passed}`);
    console.log(`  captured requests       : ${record.capturedRequests.length}  (inner generate entered)`);
    console.log(`  consumed                : ${record.consumed}`);
    console.log("");
    console.log("  --- RESULTING VERDICT (the fix) ---");
    console.log(`  status                  : ${record.status}`);
    console.log(`  failureCategory         : ${record.failureCategory}`);
    console.log(`  verifierPassed          : ${record.verifierPassed}`);
    console.log(`  detail                  : ${record.detail}`);
    console.log("");
    console.log("=== GROUND TRUTH FROM THE FIXTURE'S OWN DISPATCH LOG ===");
    console.log(dispatchLog.trimEnd());
  }
} finally {
  delete process.env.R97_CAMPAIGN_CLAIMS_DIR;
  for (const d of [armDir, root, claims]) await rm(d, { recursive: true, force: true }).catch(() => {});
}
