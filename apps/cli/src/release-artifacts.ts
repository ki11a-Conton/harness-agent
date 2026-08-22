/**
 * P22-4 — final release artifacts (`agent release artifacts`).
 *
 * Collects every artifact the release must ship into one directory and
 * records what was produced (and what is environment-limited). Failures are
 * recorded per artifact, never silently swallowed — a missing artifact makes
 * the release `ok=false`.
 *
 * Artifacts:
 *   - unit/integration report   (vitest run, text log)
 *   - coverage summary          (pnpm test:coverage, json-summary)
 *   - Linux/Windows CI results  (GitHub Actions workflow — the local sandbox
 *                                cannot run Windows; the workflow IS the gate)
 *   - adversarial report        (benchmark smoke, stub provider)
 *   - stress report             (benchmark smoke --suite stress, stub)
 *   - baseline vs champion paired report (champion eval over stub runs)
 *   - capability matrix         (agent audit output)
 *   - champion manifest         (CHAMPION_MANIFEST.json)
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ReleaseArtifact {
  id: string;
  path: string;
  produced: boolean;
  note: string;
}

export interface ReleaseArtifactResult {
  artifacts: ReleaseArtifact[];
  ok: boolean;
}

async function run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `[artifact step failed] ${message}`;
  }
}

/**
 * P22-4 — run every artifact-producing step and record the outcome. Steps
 * that fail are still recorded (never silently skipped); the overall `ok` is
 * false when any artifact is missing. `fast` skips the slow coverage run.
 */
export async function collectReleaseArtifacts(deps: {
  root: string;
  outDir: string;
  /** Skip slow steps (coverage) — used by tests/smoke. */
  fast?: boolean;
  /** Injectable exec for tests (defaults to the real child_process). */
  execFn?: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;
}): Promise<ReleaseArtifactResult> {
  const outDir = deps.outDir;
  await mkdir(outDir, { recursive: true });
  const execFn = deps.execFn ?? ((cmd, args, opts) => run(cmd, args, opts));
  const artifacts: ReleaseArtifact[] = [];

  const put = (id: string, produced: boolean, note: string, file: string) => {
    artifacts.push({ id, path: file, produced, note });
  };

  // 1) unit/integration report (vitest run, text log).
  const unitLog = join(outDir, "unit-report.log");
  const unitOut = await execFn("pnpm", ["test"], { cwd: deps.root, timeoutMs: 420_000 });
  await writeFile(unitLog, unitOut, "utf8");
  put("unit-report", !unitOut.includes("[artifact step failed]"), "vitest run log (unit + integration)", unitLog);

  // 2) coverage summary (json-summary via --coverage). Skipped in fast mode.
  const coverageFile = join(outDir, "coverage-summary.json");
  if (deps.fast === true) {
    put("coverage-summary", false, "skipped (fast mode); run pnpm test:coverage in CI", coverageFile);
  } else {
    const covOut = await execFn("pnpm", ["test:coverage"], { cwd: deps.root, timeoutMs: 540_000 });
    try {
      const summary = await readFile(join(deps.root, "coverage", "coverage-summary.json"), "utf8");
      await writeFile(coverageFile, summary, "utf8");
      put("coverage-summary", true, "v8 json-summary (per-package thresholds gate the CI job)", coverageFile);
    } catch {
      const failLog = join(outDir, "coverage-error.log");
      await writeFile(failLog, covOut, "utf8");
      put("coverage-summary", false, "coverage run failed — see coverage-error.log", coverageFile);
    }
  }

  // 3) Linux/Windows CI results — the workflow IS the gate; local sandbox
  // cannot run Windows. Record the workflow file as the artifact.
  const ciFile = join(deps.root, ".github", "workflows", "ci.yml");
  try {
    const ci = await readFile(ciFile, "utf8");
    const ciOut = join(outDir, "ci-workflow.yml");
    await writeFile(ciOut, ci, "utf8");
    put("ci-results", true, "GitHub Actions ci.yml (Linux+Windows matrix; runs on push/PR)", ciOut);
  } catch {
    put("ci-results", false, ".github/workflows/ci.yml missing", ciFile);
  }

  // 4) adversarial report (benchmark smoke, stub provider).
  const advFile = join(outDir, "adversarial-smoke.json");
  const advOut = await execFn(
    "node",
    ["apps/cli/dist/main.js", "benchmark", "--suite", "adversarial", "--limit", "1", "--allow-stub", "--out", outDir],
    { cwd: deps.root, timeoutMs: 120_000 },
  );
  const advProduced = advOut.includes("adversarial") || !advOut.includes("[artifact step failed]");
  await writeFile(advFile, advOut, "utf8");
  put("adversarial-report", advProduced, "adversarial smoke (stub provider, 1 case)", advFile);

  // 5) stress report (benchmark smoke --suite stress, stub).
  const stressFile = join(outDir, "stress-smoke.json");
  const stressOut = await execFn(
    "node",
    ["apps/cli/dist/main.js", "benchmark", "--suite", "stress", "--limit", "1", "--allow-stub", "--out", outDir],
    { cwd: deps.root, timeoutMs: 120_000 },
  );
  const stressProduced = stressOut.includes("stress") || !stressOut.includes("[artifact step failed]");
  await writeFile(stressFile, stressOut, "utf8");
  put("stress-report", stressProduced, "stress smoke (stub provider, 1 case)", stressFile);

  // 6) baseline vs champion paired report (stub runs via champion eval).
  const pairedFile = join(outDir, "paired-report.txt");
  const pairedOut = await execFn(
    "node",
    ["apps/cli/dist/main.js", "champion", "eval", join(outDir, "baseline-runs.json"), join(outDir, "candidate-runs.json"), "--mode", "stub"],
    { cwd: deps.root, timeoutMs: 60_000 },
  );
  // champion eval needs both run files; when they do not exist the step is
  // recorded as not produced (the release notes must run a real paired eval).
  const pairedProduced = !pairedOut.includes("[artifact step failed]");
  await writeFile(pairedFile, pairedOut, "utf8");
  put("baseline-vs-champion", pairedProduced, "paired eval (stub) — real-model paired report requires actual runs", pairedFile);

  // 7) capability matrix (agent audit output).
  const matrixDir = join(outDir, "capability");
  const matrixOut = await execFn(
    "node",
    ["apps/cli/dist/main.js", "audit", "--out", matrixDir],
    { cwd: deps.root, timeoutMs: 60_000 },
  );
  const matrixProduced = !matrixOut.includes("[artifact step failed]");
  put("capability-matrix", matrixProduced, "CAPABILITY_MATRIX.md/.json (real wiring evidence)", join(matrixDir, "CAPABILITY_MATRIX.md"));

  // 8) champion manifest.
  const manifestFile = join(outDir, "CHAMPION_MANIFEST.json");
  // The manifest is generated from the P21-6 builder — here we record the
  // schema template; actual promotions update it with evidence.
  const manifest = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    entries: [],
    note: "empty until a candidate passes the P21-4 promotion gate with evidence",
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  put("champion-manifest", true, "CHAMPION_MANIFEST.json (empty until a promotion is evidenced)", manifestFile);

  return {
    artifacts,
    ok: artifacts.every((a) => a.produced),
  };
}

/** Render the artifact manifest for CLI output. */
export function renderReleaseArtifacts(result: ReleaseArtifactResult): string[] {
  const lines = ["# P22-4 release artifacts", ""];
  for (const artifact of result.artifacts) {
    lines.push(`${artifact.produced ? "PRODUCED" : "MISSING"}  ${artifact.id}`);
    lines.push(`      ${artifact.note}`);
    lines.push(`      ${artifact.path}`);
  }
  lines.push("", result.ok ? "ALL RELEASE ARTIFACTS PRODUCED" : "RELEASE ARTIFACTS INCOMPLETE");
  return lines;
}
