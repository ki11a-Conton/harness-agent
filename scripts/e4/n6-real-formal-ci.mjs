#!/usr/bin/env node
/** N6: measured commands, real pinned builds, fixture + formal evidence, and
 * readiness bound to one driver SHA/run/attempt/platform. Never pushes or pays.
 * Full raw bundles survive a failure; paid/promotion remain NOT_RUN. */
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyEvidenceBundle as verifyFormal, R5_ARM_ROOT } from "./r5-real-formal.mjs";
import { READINESS_EVIDENCE_SCHEMA } from "./readiness-evidence-verify.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const write = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** A schema adapter, never a verdict adapter: copy all original bytes, retain
 * the formal bundle, then let the existing A6/readiness verifier recompute it. */
export async function writeReadinessInputs({ formalRoot, outDir, identity, commandExits, fixture }) {
  const verdict = verifyFormal(formalRoot);
  if (!verdict.ok) throw new Error(`N6_FORMAL_GATE_FAILED: ${verdict.failures.map((f) => f.code).join(",")}`);
  const source = read(join(formalRoot, "identity.json"));
  if (source.fixture !== false) throw new Error("N6_SYNTHETIC_FORMAL_BUNDLE");
  if (source.driverHead !== identity.sha || source.treeClean !== true) throw new Error("N6_DRIVER_IDENTITY_MISMATCH");
  const schedule = read(join(formalRoot, "schedule.json"));
  const root = join(outDir, "readiness-bundle");
  await rm(root, { recursive: true, force: true });
  await cp(formalRoot, root, { recursive: true });
  write(join(root, "identity.json"), {
    schemaVersion: READINESS_EVIDENCE_SCHEMA,
    driverSha: source.driverHead, runId: identity.runId, attempt: identity.attempt,
    platform: identity.platform, arms: source.pair,
    closuresDistinguishable: source.closuresDistinguishable,
  });
  const arms = schedule.records.map((r) => {
    const dir = join(root, "evidence", r.armRunId);
    const security = read(join(dir, "security.json"));
    const manifest = read(join(dir, "manifest.json"));
    const activation = join(dir, "activation.json");
    return {
      armRunId: r.armRunId, armId: r.armId, caseId: r.caseId,
      repetition: r.repetition, orderIndex: r.orderIndex,
      preregistrationDigest: r.preregistrationDigest, planDigest: r.planDigest,
      evidence: {
        executorId: manifest.executorId,
        traceDigest: r.traceDigest, verifiedCompletion: r.verifiedCompletion,
        securityViolations: security.violations,
        activationEvidenceDigest: existsSync(activation) ? digest(activation) : null,
      },
    };
  });
  write(join(root, "schedule.json"), { schemaVersion: READINESS_EVIDENCE_SCHEMA, arms });
  const report = read(join(formalRoot, "report.json"));
  const formal = report.formalSmall.evidence;
  const aggregate = read(join(root, "aggregate.json"));
  const e2e = {
    ciRunSha: identity.sha, runId: identity.runId, attempt: identity.attempt,
    platform: identity.platform, os: process.platform,
    // Fixture protocol and real formal acceptance have independent inputs.
    ok: fixture.ok === true && verdict.ok && Object.values(commandExits).every((c) => c === 0),
    commandExits, commandScope: "pnpm typecheck; pnpm test (including opt-in N2 release CLI); pnpm build",
    readiness: { productionOfflineReadiness: { executionKind: "REAL_DUAL_PINNED_BUILD" } },
    dualBuild: {
      baselineArm: source.pair.baseline, candidateArm: source.pair.candidate,
      verifier: { ran: formal.evidenceVerified > 0, casesTotal: schedule.records.length, casesVerified: formal.evidenceVerified },
    },
    positiveExecution: fixture.positiveExecution,
    positiveForward: {
      physicalStubRequests: formal.physicalProviderCalls,
      ledgerCommitted: read(join(root, "cost-journal.json")).entries.length,
      journalChargedTokens: formal.journalRecomputed.total,
      aggregateTokensTotal: aggregate.cost.totalTokens,
      aggregateTokensDelta: aggregate.cost.deltaTokens,
      aggregateTokensBaseline: formal.journalRecomputed.baseline,
      aggregateTokensCandidate: formal.journalRecomputed.candidate,
      independentTokens: { delta: formal.journalRecomputed.delta },
      costMatchesJournal: formal.costMatches,
    },
    fixtureEvidence: "fixture-report.json", formalEvidence: "formal",
    evidenceRoot: "readiness-bundle",
    paidExperimentRun: "NOT_RUN", championPromotion: "NOT_RUN",
  };
  write(join(outDir, "e2e.json"), e2e);
  return { root, e2e };
}

function parseArgs(argv) {
  const result = {};
  const known = new Set(["platform", "run-id", "attempt", "out"]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2), value = argv[i + 1];
    if (!argv[i].startsWith("--") || !known.has(key) || !value || value.startsWith("--") || key in result) throw new Error("N6_CLI_USAGE");
    result[key] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args["run-id"] ?? process.env.GITHUB_RUN_ID;
  const attempt = Number(args.attempt ?? process.env.GITHUB_RUN_ATTEMPT);
  const platform = args.platform;
  if (!runId || !Number.isSafeInteger(attempt) || attempt < 1 || !["ubuntu", "windows"].includes(platform)) throw new Error("N6_RUN_IDENTITY_REQUIRED");
  if ((platform === "ubuntu" && process.platform !== "linux") || (platform === "windows" && process.platform !== "win32")) throw new Error("N6_PLATFORM_MISMATCH");
  if (process.env.OPENAI_API_KEY?.trim() || process.env.RUN_PAID_BENCHMARKS?.trim()) throw new Error("N6_PAID_ENVIRONMENT_REFUSED");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim()) throw new Error("N6_CLEAN_TREE_REQUIRED");
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) throw new Error("N6_CHECKOUT_SHA_MISMATCH");
  const outDir = resolve(ROOT, args.out ?? ".ci/n6-real-formal");
  const outRel = relative(join(ROOT, ".ci"), outDir);
  if (!outRel || outRel.startsWith("..") || resolve(outDir) === ROOT) throw new Error("N6_OUTPUT_MUST_BE_UNDER_CI");
  await rm(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const commands = [];
  function run(label, command, argv, env = process.env) {
    const r = spawnSync(command, argv, { cwd: ROOT, env, encoding: "utf8", timeout: 2_700_000, maxBuffer: 128 * 1024 * 1024, shell: process.platform === "win32" && command === "pnpm" });
    const code = r.status ?? 1;
    writeFileSync(join(outDir, `${label}.log`), `${r.stdout ?? ""}\n${r.stderr ?? ""}\n${r.error?.message ?? ""}`);
    commands.push({ label, command, argv, exitCode: code });
    write(join(outDir, "commands.json"), commands);
    process.stdout.write(`${label}: exit ${code}\n`);
    if (code !== 0) throw new Error(`N6_COMMAND_FAILED: ${label} (see ${outDir}/${label}.log)`);
    return code;
  }
  // Fail an incomplete pinned build before spending minutes on full suites.
  run("pair", process.execPath, ["scripts/e4/r5-real-formal.mjs", "--setup-pair", "scripts/e4/r5-formal-pair.json"]);
  run("arms", process.execPath, ["scripts/e4/r97-observe-arms.mjs", "--pair", "r5", "--root", R5_ARM_ROOT]);
  const commandExits = {
    typecheck: run("typecheck", "pnpm", ["typecheck"]),
    test: run("test", "pnpm", ["test"], { ...process.env, N2_RUN_RELEASE_E2E: "1" }),
    build: run("build", "pnpm", ["build"]),
  };
  run("fixture", process.execPath, ["scripts/e4/prereg-production-e2e.mjs", "--out", join(outDir, "fixture-report.json"), "--platform", platform, "--run-id", runId, "--attempt", String(attempt)]);
  await cp(join(ROOT, ".ci", "prereg-production-e2e", "pos-exec-runs", "evidence"), join(outDir, "fixture-bundle"), { recursive: true });
  run("formal", process.execPath, ["scripts/e4/r5-real-formal.mjs", "--identity", "--formal", "--content", "--content-matrix", "--negative", "--evidence-dir", join(outDir, "formal"), "--out", join(outDir, "formal-report.json")]);
  const { root } = await writeReadinessInputs({ formalRoot: join(outDir, "formal"), outDir, identity: { sha, runId, attempt, platform }, commandExits, fixture: read(join(outDir, "fixture-report.json")) });
  run("readiness", process.execPath, ["scripts/e4/ci-readiness.mjs", "--e2e", join(outDir, "e2e.json"), "--out", join(outDir, "ci-readiness.json"), "--evidence-root", relative(ROOT, root).replaceAll("\\", "/"), "--expect-sha", sha, "--run-id", runId, "--attempt", String(attempt), "--platform", platform, "--require", "fixtureProtocolReady,realBuildOfflineReady,budgetEvidenceReady", "--strict"]);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => { process.stderr.write(`${err.message}\n`); process.exitCode = 1; });
}
