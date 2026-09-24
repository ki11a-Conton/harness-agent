/**
 * E4-R101-A (T6) — the offline closed loop must be ONE command that runs on
 * Windows and on Ubuntu, with no bash, no WSL and no Docker.
 *
 * WHY THIS FILE EXISTS (plan §T6 怎么做 1, 2, 3; 怎么验收 1, 2)
 * -----------------------------------------------------------
 *   "将现有专用 job 改为跨平台矩阵，路径使用 runner.temp/Node 临时目录。Windows
 *    本机运行说明用 PowerShell/Node，不要求 bash、WSL 或 Docker."
 *   "setup 命令必须是仓库中真实存在的脚本。明确 setup-only/observe/run 的行为；
 *    构建失败是失败，缺 arm 不是 skip."
 *   "从干净 checkout 的命令能复现，用户无需手写临时脚本，也无需本机 Linux."
 *
 * The CI job this replaces was a 200-line bash script — `git worktree`, `${!var}`
 * indirection, `set -euo pipefail`, `grep -cF`. None of it runs on a Windows
 * runner, so half the plan's matrix was unreachable and an operator on Windows
 * could not reproduce the job without translating it by hand.
 *
 * These tests pin the properties that make the replacement reproducible:
 *
 *   - the arm directories reach the test child through its ENVIRONMENT, not
 *     through `$GITHUB_ENV` (a shell mechanism whose syntax differs per shell);
 *   - no phase shells out, so nothing depends on bash being installed;
 *   - a missing or unbuildable arm is a SETUP FAILURE, never a skip;
 *   - the suite list is the ONE place the files are named, and it must cover every
 *     file that declares a test the acceptance matrix names — otherwise a row
 *     would be unsatisfiable for a reason no one could see from the workflow;
 *   - the identity record states the offline scope in FIELDS, so "CI all-green"
 *     cannot be read as "the paid experiment ran".
 */

import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const CLOSED_LOOP = pathToFileURL(join(REPO, "scripts", "e4", "r97-closed-loop.mjs")).href;

interface PhaseResult {
  phase: string;
  ok: boolean;
  code: number;
  output?: string;
  [k: string]: unknown;
}

const mod = (await import(CLOSED_LOOP)) as {  CLOSED_LOOP_VERSION: string;
  EXIT_OK: number;
  EXIT_FAILED: number;
  EXIT_CONFIG: number;
  SUITE_FILES: string[];
  SUITE_MIN_TESTS: number;
  parseArgs: (argv: string[]) => Record<string, unknown>;
  main: (argv: string[]) => Promise<number>;
  phaseIdentity: (opts: Record<string, unknown>, phases: PhaseResult[]) => Promise<{ identityPath: string }>;
};

/**
 * Remove `/* … *​/` blocks and `//` line comments, so a source scan can forbid a
 * MECHANISM without also forbidding the prose that explains why it is avoided.
 *
 * Deliberately simple: this is a test helper for scanning one known file, not a
 * JavaScript parser. It can be fooled by a `//` inside a string literal, which is
 * acceptable because the assertions it feeds are about the ABSENCE of a token.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("E4-R101-A (T6) L1: one command, cross-platform, no shell", () => {
  it("carries a version so a run can be tied to the recipe that produced it", () => {
    expect(mod.CLOSED_LOOP_VERSION).toMatch(/^e4-r101-closed-loop-v\d+$/);
  });

  it("NEVER shells out — no `shell: true`, and no bash-only mechanism", async () => {
    // The measured reason this file exists: the job it replaces was bash, so it
    // could not run on a Windows runner at all. `shell: true` would reintroduce
    // exactly that platform dependency, and the CI environment FILE is a shell
    // mechanism whose writer differs per shell (`>> "$GITHUB_ENV"` in bash vs
    // `Add-Content` in PowerShell) — passing the arms on the child's own `env`
    // avoids it entirely.
    //
    // Comments are stripped before checking: prose that EXPLAINS the mechanism is
    // not a dependency on it, and forbidding the word in a comment would make this
    // test fire on the very explanation that keeps the choice from being undone.
    const src = stripComments(await readFile(join(REPO, "scripts", "e4", "r97-closed-loop.mjs"), "utf8"));
    expect(src, "shell: true would make the runner platform-dependent").not.toContain("shell: true");
    expect(src, "the CI env file is a shell mechanism; set the child env instead").not.toContain("GITHUB_ENV");
    // `bash`/`sh -c` as a SPAWNED program is the other way platform-dependence
    // creeps back in.
    expect(src).not.toMatch(/execFileSync\(\s*["'](?:bash|sh)["']/);
    expect(src).not.toMatch(/spawnSync?\(\s*["'](?:bash|sh)["']/);
  });

  it("defaults the arm root to a NODE temp directory, not a hard-coded drive path", async () => {
    // Plan 怎么做 1: "路径使用 runner.temp/Node 临时目录". A `D:/` default would be
    // Windows-only; a `runner.temp` default would be CI-only. `tmpdir()` is both.
    const src = await readFile(join(REPO, "scripts", "e4", "r97-closed-loop.mjs"), "utf8");
    expect(src).toContain("tmpdir()");
    expect(src, "a hard-coded drive path would not exist on a Linux runner").not.toMatch(/["']D:\//);
  });

  it("passes the arm directories to the test child through its ENVIRONMENT", async () => {
    const src = await readFile(join(REPO, "scripts", "e4", "r97-closed-loop.mjs"), "utf8");
    // The D6 test reads exactly these two names; the runner must set them.
    expect(src).toContain("R97_ARM_BASELINE_DIR");
    expect(src).toContain("R97_ARM_CANDIDATE_DIR");
  });

  it("spawns vitest's real .mjs entry, never a .cmd/.bat shim", async () => {
    // MEASURED: spawning `pnpm.cmd` with `shell: false` fails with `EINVAL` on
    // Node 24 (the CVE-2024-27980 fix refuses to spawn a `.cmd`/`.bat` without a
    // shell), and `shell: true` would reintroduce the platform dependency this
    // runner removes. `node_modules/vitest/vitest.mjs` is what the `bin` field
    // points at, so spawning it with `process.execPath` is identical on both
    // platforms and needs no shim.
    const src = stripComments(await readFile(join(REPO, "scripts", "e4", "r97-closed-loop.mjs"), "utf8"));
    expect(src, "the .cmd shim cannot be spawned without a shell on Node 24").not.toContain("pnpm.cmd");
    expect(src, "vitest's real entry is vitest.mjs").toContain('"vitest.mjs"');
    // The entry must be spawned with the SAME node that is running the runner.
    expect(src).toContain("execFileSync(process.execPath, [entry");
  });
});

describe("E4-R101-A (T6) L2: the suite list covers every file the matrix names", () => {
  it("names only files that EXIST", async () => {
    const missing = mod.SUITE_FILES.filter((f) => !existsSync(join(REPO, f)));
    expect(missing, "the suite list names files that do not exist").toEqual([]);
  });

  it("names each file at most once", () => {
    expect(new Set(mod.SUITE_FILES).size).toBe(mod.SUITE_FILES.length);
  });

  it("every suite file that opens a campaign ISOLATES the machine-global claim anchor", async () => {
    // MEASURED DEFECT, found by running this round's closed loop (A7).
    //
    // The cross-directory claim anchor lives OUTSIDE any campaign directory
    // (`os.tmpdir()/e4-r97-campaign-claims`) and is keyed by `campaignId`. A2 made a
    // spent approval's claim durable: once a directory has ESTABLISHED a budget, that
    // directory's later disappearance is a LOSS (`CAMPAIGN_STATE_LOST`), not a stale
    // claim to ignore. That is the behaviour A2/F2 asks for.
    //
    // The consequence for FIXTURES is that any file which opens a campaign with a
    // FIXED `planDigest` now shares one machine-global namespace across every test in
    // it — and across every earlier run on the machine. `r97-execution-state-
    // ownership.test.ts` used one fixed digest, so its second campaign-establishing
    // test was refused with the first test's deleted temp directory as the "lost"
    // root. The refusal was correct; the fixture leaked.
    //
    // Five files already redirected the anchor; that file did not, which is exactly
    // the kind of omission a per-file audit misses. This test is the audit: a suite
    // file that opens a campaign must either redirect the anchor or not open one.
    //
    // The check is on the MECHANISM — an ASSIGNMENT to `process.env` — not on a
    // mention of the name and not on the exported constant's identifier. MEASURED:
    // an earlier version of this guard looked only for `R97_CAMPAIGN_CLAIMS_DIR_ENV`
    // and so reported `r97-arm-worker-contract.test.ts` and
    // `r97-campaign-validator-cli.test.ts` as offenders even though both assign
    // `process.env["R97_CAMPAIGN_CLAIMS_DIR"]` — the same variable, spelled
    // literally. They were isolating correctly; the guard was wrong. Requiring an
    // actual assignment keeps the audit honest in the other direction too: a file
    // that merely mentions the name in a comment is still an offender.
    const srcDir = join(REPO, "packages", "evaluation", "src");
    const offenders: string[] = [];
    const ISOLATES =
      /process\.env\s*\[\s*(?:"R97_CAMPAIGN_CLAIMS_DIR"|'R97_CAMPAIGN_CLAIMS_DIR'|R97_CAMPAIGN_CLAIMS_DIR_ENV)\s*\]\s*=/;
    for (const f of mod.SUITE_FILES) {
      if (!f.startsWith("packages/evaluation/src/")) continue;
      const src = await readFile(join(REPO, f), "utf8");
      const opensCampaign =
        /openR97BudgetLedger\s*\(|openR97Campaign\s*\(|\bopenCampaign\s*\(/.test(src);
      if (!opensCampaign) continue;
      // Redirecting the anchor is the fix; a file that only READS a ledger it was
      // handed still opens one, so the check is on the env var, not on intent.
      if (!ISOLATES.test(src)) offenders.push(f);
    }
    expect(
      offenders,
      "these suite files open a campaign against the machine-global claim anchor without isolating it — " +
        "a durable claim from another test or an earlier run will refuse an unrelated fresh directory",
    ).toEqual([]);
  });

  it("covers every file that declares a test the acceptance matrix requires", async () => {
    // This is the load-bearing cross-check. The matrix gate FAILS a row whose test
    // is absent from the report, so a matrix-named test living in a file this list
    // omits would make that row unsatisfiable — a failure whose cause is invisible
    // from the workflow. Catching it here names the file.
    const matrix = (await import(pathToFileURL(join(REPO, "scripts", "e4", "r97-acceptance-matrix.mjs")).href)) as {
      ACCEPTANCE_MATRIX: Array<{ id: string; tests: string[] }>;
    };
    const allNames = matrix.ACCEPTANCE_MATRIX.flatMap((r) => r.tests);

    const srcDir = join(REPO, "packages", "evaluation", "src");
    const candidates = (await readdir(srcDir)).filter((f) => f.startsWith("r9") && f.endsWith(".test.ts"));
    const declares = new Map<string, string>();
    for (const f of candidates) {
      const src = await readFile(join(srcDir, f), "utf8");
      for (const m of src.matchAll(/\bit\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        const title = (m[1] ?? "").replace(/\\(.)/g, "$1");
        if (title !== "" && !declares.has(title)) declares.set(title, `packages/evaluation/src/${f}`);
      }
    }

    const uncovered: string[] = [];
    for (const name of allNames) {
      const file = [...declares.entries()].find(([title]) => name.endsWith(` ${title}`))?.[1];
      // A name whose declaring file cannot be found is the MATRIX's problem and its
      // own suite reports it; here only a KNOWN file that is not run is an error.
      if (file !== undefined && !mod.SUITE_FILES.includes(file)) uncovered.push(`${name} -> ${file}`);
    }
    expect(uncovered, "the closed loop does not run the file declaring these matrix tests").toEqual([]);
  });

  it("requires a test total no larger than what the suite really reports", () => {
    // A floor set above the real count would fail every run; the point of the floor
    // is to catch a silently-dropped file, so it must be reachable. MEASURED: the
    // listed files report 409 passing tests on the tree this floor was set for.
    expect(mod.SUITE_MIN_TESTS).toBeGreaterThan(300);
    expect(mod.SUITE_MIN_TESTS).toBeLessThanOrEqual(409);
  });

  it("still RUNS the files `pnpm test` excludes, so the dedicated job is what covers them", async () => {
    // Plan §A7 怎么验收 3: "typecheck 与全套测试通过；driver 专用测试没有因 package.json
    // 排除而漏跑." `pnpm test` deliberately excludes the heavy end-to-end files —
    // `r97-driver-closed-loop.test.ts` among them, because it drives real arm builds.
    // That exclusion is legitimate ONLY while some other gate really runs them, and
    // this job is that gate. If a future edit dropped the file from SUITE_FILES, the
    // exclusion would silently become "never run anywhere" — a suite that cannot
    // fail is not a suite.
    //
    // Two kinds of exclusion are distinguished, because they need different cover:
    //   * a GLOB CLASS (`**/*.perf.test.ts`, `**/*.soak.test.ts`) is covered by its
    //     own named script (`test:perf`, `test:soak`), so it is checked against the
    //     scripts table rather than against SUITE_FILES;
    //   * an EXACT FILE is a single test file nobody else would run, so it must be
    //     in the closed-loop suite.
    const pkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const testScript = pkg.scripts["test"] ?? "";
    const excluded = [...testScript.matchAll(/--exclude\s+'([^']+)'/g)].map((m) => m[1] ?? "");
    expect(excluded.length, "the test script must exclude something for this check to mean anything").toBeGreaterThan(0);

    // The patterns are BASENAME globs (`**/r97-driver-closed-loop.test.ts`), so the
    // leading `**/` is stripped before deciding whether a pattern is an exact file
    // (a basename with no wildcard) or a glob CLASS.
    const patterns = excluded.map((e) => e.replace(/^\*\*\//, ""));
    const exactBasenames = patterns.filter((e) => !e.includes("*") && e.endsWith(".test.ts"));
    const suiteBasenames = mod.SUITE_FILES.map((f) => f.split("/").pop() ?? f);
    // The one that matters for this round: the driver's end-to-end file.
    expect(exactBasenames, "this check is stale — the driver test is no longer excluded").toContain(
      "r97-driver-closed-loop.test.ts",
    );
    expect(
      suiteBasenames,
      "the driver test is excluded from `pnpm test` and must be run by the closed-loop suite",
    ).toContain("r97-driver-closed-loop.test.ts");

    // EVERY exact-file exclusion must still be run by SOMETHING. Two legitimate
    // covers exist and the check accepts either:
    //   * the closed-loop suite (this job), which is what covers the driver test;
    //   * a script that names the file (e.g. `e3:repro-current-defects`,
    //     `test:forensics`), which is how the two forensics files stay reachable.
    // What is NOT allowed is an exact file that nothing runs — that is the state in
    // which an exclusion turns a suite into a suite that cannot fail.
    for (const b of exactBasenames) {
      const inSuite = suiteBasenames.includes(b);
      const inSomeScript = Object.entries(pkg.scripts).some(
        ([name, body]) => name !== "test" && name !== "test:coverage" && body.includes(b),
      );
      expect(
        inSuite || inSomeScript,
        `${b} is excluded from \`pnpm test\` and neither the closed-loop suite nor any other script runs it — it runs NOWHERE`,
      ).toBe(true);
    }

    // Every glob CLASS must be named by some OTHER script, or the exclusion removes
    // it from the only run that had it.
    for (const pattern of patterns.filter((e) => e.includes("*"))) {
      const kind = (pattern.split("/").pop() ?? pattern).replace(/^\*/, "").replace(/^\./, "");
      const covered = Object.entries(pkg.scripts).some(
        ([name, body]) => name !== "test" && name !== "test:coverage" && body.includes(kind),
      );
      expect(covered, `${pattern} is excluded from \`pnpm test\` and no other script runs it`).toBe(true);
    }
  });
});

describe("E4-R101-A (T6) L3: phase selection is explicit, and setup-only is a real mode", () => {
  it("`--all` selects every phase", () => {
    const p = mod.parseArgs(["--all"]);
    for (const phase of ["setup", "acceptance", "suite", "matrix", "identity"]) {
      expect(p[phase], `--all did not enable ${phase}`).toBe(true);
    }
  });

  it("`--setup-only` prepares the arms and stops — the mode plan 怎么做 2 asks for", () => {
    const p = mod.parseArgs(["--setup-only"]);
    expect(p["setup"]).toBe(true);
    expect(p["setupOnly"]).toBe(true);
    // Preparing the arms must not silently run the campaign: "setup-only" that also
    // ran the experiment would be a different mode wearing the name.
    expect(p["acceptance"]).toBe(false);
    expect(p["suite"]).toBe(false);
  });

  it("a flag with no value is refused rather than read as the next flag", () => {
    expect(() => mod.parseArgs(["--out", "--suite"])).toThrow(/--out requires a value/);
  });

  it("refuses to run when NO phase was requested", async () => {
    // Silently doing nothing would look like success to a caller that mistyped.
    await expect(mod.main([])).resolves.toBe(mod.EXIT_CONFIG);
  });
});

describe("E4-R101-A (T6) L4: a missing arm is a SETUP FAILURE, never a skip", () => {
  it("refuses with a CONFIG error when the arms were never prepared", async () => {
    // Finding F7 was a silent skip: the D6 test passed by not running. The runner
    // must not be able to produce that state — asking for the suite with no built
    // arm is an error, and the message names the setup phase.
    const code = await mod.main(["--suite", "--arms-root", join(REPO, ".ci", "definitely-not-prepared")]);
    expect(code).toBe(mod.EXIT_CONFIG);
  });

  it("says which arm is missing and that setup is the remedy", async () => {
    // The exit code alone does not tell an operator what to do. The runner writes
    // the diagnosis to stderr; this asserts the CONTRACT (a config failure naming
    // the arm and the setup command) by checking the source, because capturing the
    // child's stderr here would test the harness rather than the runner.
    const src = await readFile(join(REPO, "scripts", "e4", "r97-closed-loop.mjs"), "utf8");
    expect(src).toMatch(/has no built CLI at/);
    expect(src).toMatch(/a missing arm is a setup failure, never a skip/);
  });
});

describe("E4-R101-A (T6) L5: the identity record states the OFFLINE scope in fields", () => {
  it("records that no paid execution happened and that nothing is promotable", async () => {
    const outDir = join(REPO, ".ci", "probe-closed-loop-identity");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    const written = await mod.phaseIdentity(
      { outDir, baseline: "a".repeat(40), candidate: "b".repeat(40) },
      [
        { phase: "setup", ok: true, code: 0, baselineDir: "/tmp/arms/baseline", candidateDir: "/tmp/arms/candidate" },
        {
          phase: "acceptance",
          ok: true,
          code: 0,
          campaign: {
            executionMode: "arm-worker",
            verifiedPasses: 6,
            measuredUnits: 16,
            logicalCalls: 42,
            strongPasses: 0,
            weakPasses: 6,
          },
        },
        { phase: "suite", ok: true, code: 0, totalTests: 500, passedTests: 500 },
        {
          phase: "matrix",
          ok: true,
          code: 0,
          rowsSatisfied: 9,
          rowsTotal: 9,
          planRowsSatisfied: 9,
          planRowsTotal: 9,
          planRowsUncovered: [],
        },
      ],
    );
    const identity = JSON.parse(await readFile(written.identityPath, "utf8"));
    // The scope must be FIELDS, not prose a reader has to interpret.
    expect(identity.paidTwoVersionExperimentRan).toBe(false);
    expect(identity.providerCalls).toBe(0);
    expect(identity.paidAuthorizationPresentInWorkflow).toBe(false);
    expect(identity.experimentKind).toBe("offline_closed_loop");
    expect(identity.promotable).toBe(false);
    expect(String(identity.modelCapabilityClaim)).toMatch(/no model-quality result/i);
    // The honest pass split travels with the record.
    expect(identity.strongPasses).toBe(0);
    expect(identity.weakPasses).toBe(6);
    // The closing plan's own M1–M9 coverage travels with the record too, so "the
    // plan's behavior matrix is covered" is checkable from the artifact rather than
    // from a claim about the run.
    expect(identity.planRowsSatisfied).toBe(9);
    expect(identity.planRowsTotal).toBe(9);
    expect(identity.planRowsUncovered).toEqual([]);
    // The platform is recorded, because the matrix runs on two and a Windows pass
    // is not equivalent evidence for a POSIX signal test.
    expect(typeof identity.platform).toBe("string");
    expect(identity.platform.length).toBeGreaterThan(0);
  });

  it("does NOT report the plan's matrix as covered when a phase never ran", async () => {
    // A missing phase must leave the coverage fields NULL rather than defaulting to
    // "all covered": a run that never reached the matrix phase has no evidence about
    // the plan's table, and reporting 9/9 for it would be an invented fact.
    const outDir = join(REPO, ".ci", "probe-closed-loop-identity");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    const written = await mod.phaseIdentity(
      { outDir, baseline: "a".repeat(40), candidate: "b".repeat(40) },
      [{ phase: "suite", ok: true, code: 0, totalTests: 500, passedTests: 500 }],
    );
    const identity = JSON.parse(await readFile(written.identityPath, "utf8"));
    expect(identity.planRowsSatisfied).toBeNull();
    expect(identity.planRowsTotal).toBeNull();
    expect(identity.planRowsUncovered).toBeNull();
  });
});

describe("E4-R101-A (T6) L6: the workflow runs THIS script, on BOTH platforms", () => {
  it("invokes the committed runner rather than an inline shell recipe", async () => {
    const ci = await readFile(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci, "CI must drive the committed cross-platform runner").toContain("scripts/e4/r97-closed-loop.mjs");
  });

  it("runs the closed loop on Windows AND Ubuntu", async () => {
    const ci = await readFile(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("r97-r98-closed-loop:"));
    const body = job.slice(0, job.indexOf("\n  cold-start-ubuntu:"));
    expect(body, "the closed loop must be a matrix, not Ubuntu-only").toContain("matrix.os");
    expect(body, "windows-latest must be one of the matrix legs").toContain("windows-latest");
    expect(body, "ubuntu-latest must be one of the matrix legs").toContain("ubuntu-latest");
  });

  it("keeps the paid-authorization literal out of the workflow", async () => {
    // `packages/security/src/workflow-paid-authorization.test.ts` scans ci.yml and
    // requires ZERO contiguous hits; a matrix job must not reintroduce one.
    const ci = await readFile(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).not.toMatch(/RUN_PAID_BENCHMARKS\s*[:=]\s*["']?1/);
  });

  it("uses NO bash step in the closed-loop job — the Windows leg has no bash", async () => {
    // Plan 怎么做 1: "不要求 bash、WSL 或 Docker". The previous job was entirely bash.
    // A remaining `shell: bash` step would make the Windows leg fail on a runner
    // that has no bash, or — worse — silently not run. The whole job is one Node
    // command plus one artifact upload, so nothing here needs a shell.
    const ci = await readFile(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    const start = ci.indexOf("r97-r98-closed-loop:");
    const end = ci.indexOf("cold-start-ubuntu:");
    const body = ci.slice(start, end);
    expect(body, "the closed-loop job must not depend on bash").not.toContain("shell: bash");
    // The pins that the removed bash steps asserted must still be asserted, from
    // the JSON report the runner already produces.
    expect(body, "the pinned regressions must still be checked").not.toContain('grep -qF "✓"');
  });

  it("runs the anti-cheat mutation gate, so the suite's strength is itself checked", async () => {
    // Plan 怎么做 7 requires the five mutations to turn their tests RED. A suite that
    // passes while every mutation goes undetected proves nothing about the suite,
    // so the gate runs in CI rather than only on the author's machine.
    const ci = await readFile(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    const start = ci.indexOf("r97-r98-closed-loop:");
    const end = ci.indexOf("cold-start-ubuntu:");
    const body = ci.slice(start, end);
    expect(body, "CI must run the mutation gate").toContain("r97-mutation-check.mjs");
    // It mutates production source on disk, so it must NOT run concurrently with
    // the suite phase: a mutation in flight would make an unrelated test fail.
    const mutationStep = body.indexOf("r97-mutation-check.mjs");
    const suiteStep = body.indexOf("r97-closed-loop.mjs");
    expect(mutationStep, "the mutation gate must come AFTER the closed loop").toBeGreaterThan(suiteStep);
  });
});
