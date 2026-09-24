// E4-R101 — prepare the TWO REAL ARM CHECKOUTS the R97 D6 acceptance path needs.
//
// WHY THIS FILE EXISTS (plan §R101 做什么 1 and §R101 怎么做 line 241)
// -------------------------------------------------------------------
//   "使用 runner.temp/mkdtemp 与参数化路径，不硬编码 D:/r97-arm-*。提供实际存在、
//    版本化的setup命令，不只在注释中引用未提交脚本."
//
// The D6 test told an operator to run `node scripts/e4/r97-observe-arms.mjs` and
// that file DID NOT EXIST. A setup instruction that names a missing script is
// worse than no instruction: it reads as documented, reproducible setup while
// the only thing that ever worked was a sequence of ad-hoc commands typed into
// one author's PowerShell. This is that sequence, committed and parameterised.
//
// WHAT IT DOES
// ------------
//   1. Resolves the two historical revisions (flags > environment > the frozen
//      defaults the R97 plan binds).
//   2. Creates a DETACHED worktree for each under a root that is `mkdtemp`-based
//      by default, so nothing depends on the author's disk layout.
//   3. Runs `pnpm install` and `pnpm build` INSIDE each arm. `dist/` is
//      git-ignored and absent at both historical revisions, so each arm's
//      `apps/cli/dist/main.js` can ONLY come from a real build in that checkout.
//   4. Asserts each arm is CLEAN (`git status --porcelain` empty) and that its
//      CLI entry exists. A dirty arm is refused by the plan as non-reproducible,
//      and a missing entry is an unbuildable arm — both are reported here, where
//      the cause is visible, rather than surfacing later as a confusing
//      "observation invalid".
//   5. Prints the two environment variables the D6 test reads.
//
// FAIL-CLOSED ON NETWORK/INSTALL FAILURE (plan §R101 怎么做 line 242)
// ------------------------------------------------------------------
//   "网络依赖失败记录为setup failure，不能生成伪造观测."
// An install or build that fails is a SETUP FAILURE: this script exits non-zero
// and prints nothing that could be mistaken for a usable arm directory. It never
// falls back to the driver's own tree, never copies another arm's build, and
// never reports a directory as ready that it did not itself verify.
//
// USAGE
// -----
//   node scripts/e4/r97-observe-arms.mjs
//   node scripts/e4/r97-observe-arms.mjs --root D:/arms
//   node scripts/e4/r97-observe-arms.mjs --baseline <sha> --candidate <sha>
//   node scripts/e4/r97-observe-arms.mjs --print-env      # print only, no setup
//
// Exit codes: 0 ready · 1 setup failure · 2 usage error.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

export const EXIT_OK = 0;
export const EXIT_SETUP_FAILED = 1;
export const EXIT_CONFIG = 2;

/**
 * The frozen revisions the R97 plan binds.
 *
 * These are the SAME two SHAs the CI job uses and the D6 test asserts against,
 * so a locally prepared pair and a CI-prepared pair describe the same
 * experiment. They are defaults, never a hard requirement: `--baseline` /
 * `--candidate` override them, which is what makes the script usable for a
 * future campaign without editing code.
 */
export const DEFAULT_BASELINE_SHA = "e9776ba66190ea63b1bacb685c91aa900b6935e7";
export const DEFAULT_CANDIDATE_SHA = "a20373743b56de6a3a110fecdd254737ece71afa";

/** The env vars the D6 test reads, named once so the printed advice and the test
 *  cannot drift apart. */
export const ARM_DIR_ENV = {
  baseline: "R97_ARM_BASELINE_DIR",
  candidate: "R97_ARM_CANDIDATE_DIR",
};

/** The git shas are opaque here on purpose: any 40-hex commit is acceptable, and
 *  the caller may legitimately prepare a different pair. */
function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function run(command, args, opts = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    cwd: opts.cwd,
    timeout: opts.timeout ?? 900_000,
    // `shell: false` always: a path with spaces or shell metacharacters must not
    // be able to alter the command. This matters on Windows, where the checkout
    // root frequently contains a space.
    shell: false,
  });
}

/** A worktree's own git HEAD, or `null` when the directory is not a checkout. */
function headOf(dir) {
  try {
    const out = run("git", ["-C", dir, "rev-parse", "HEAD"]);
    const trimmed = String(out).trim();
    return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/** The uncommitted state of a worktree, or `null` when it cannot be read. */
function porcelainOf(dir) {
  try {
    return String(run("git", ["-C", dir, "status", "--porcelain"]));
  } catch {
    return null;
  }
}

/**
 * Prepare ONE arm. Returns `{ dir, sha, cliEntry }` on success.
 *
 * Throws on every failure path, and the caller turns that into a setup failure.
 * There is deliberately no partial success: an arm whose build failed is NOT a
 * usable arm, and returning its directory would invite the observation step to
 * report something it cannot back.
 */
async function prepareArm(opts) {
  const { label, sha, dir, repoRoot } = opts;

  // The revision must exist LOCALLY. Fetching is the caller's business (CI
  // fetches the specific SHA before invoking this), because a fetch here would
  // silently turn a missing revision into a network operation with its own
  // failure modes.
  try {
    run("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    throw new Error(
      `arm ${label}: revision ${sha} is not present in ${repoRoot} — fetch it first ` +
        `(git fetch --no-tags --depth 1 origin ${sha}). A missing revision is a SETUP failure, never a fabricated observation.`,
    );
  }

  // A pre-existing registration (a pruned-but-registered worktree) makes
  // `worktree add` fail with a confusing message, so clear the registration and
  // any leftover directory first.
  try {
    run("git", ["-C", repoRoot, "worktree", "remove", "--force", dir]);
  } catch {
    // Not registered: nothing to remove.
  }
  await rm(dir, { recursive: true, force: true });

  run("git", ["-C", repoRoot, "worktree", "add", "--detach", dir, sha], { stdio: ["ignore", "pipe", "pipe"] });

  // The checkout must really BE that revision: the D6 assertions compare against
  // these exact SHAs, so a wrong checkout would otherwise fail much later.
  const head = headOf(dir);
  if (head !== sha) {
    throw new Error(`arm ${label}: after checkout ${dir} reports HEAD ${String(head)}, expected ${sha}`);
  }

  // `pnpm` is invoked through the shell on Windows because it is a `.cmd` shim
  // there and `execFileSync` cannot execute a `.cmd` without one. The arguments
  // are fixed literals, never interpolated user input, so the shell introduces no
  // injection surface.
  //
  // `shell: false` is preferred everywhere else. On Windows the shim needs a
  // shell, and passing an ARGS ARRAY with `shell: true` is deprecated (DEP0190)
  // because Node concatenates rather than escapes — so the one shell invocation
  // is built as a single command STRING with literal arguments, which is exactly
  // the case the deprecation warns about and is safe here because nothing in it
  // is caller-controlled.
  const isWindows = process.platform === "win32";
  const runPnpm = (args) => {
    const literal = args.join(" ");
    if (isWindows) {
      return execFileSync(`pnpm.cmd ${literal}`, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 1_800_000,
        shell: true,
      });
    }
    return execFileSync("pnpm", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1_800_000,
      shell: false,
    });
  };

  try {
    runPnpm(["install", "--prefer-offline"]);
  } catch (err) {
    throw new Error(`arm ${label}: pnpm install FAILED in ${dir} — ${firstLine(err)}`);
  }
  try {
    runPnpm(["build"]);
  } catch (err) {
    throw new Error(`arm ${label}: pnpm build FAILED in ${dir} — ${firstLine(err)}`);
  }

  const cliEntry = join(dir, "apps", "cli", "dist", "main.js");
  if (!existsSync(cliEntry) || !statSync(cliEntry).isFile()) {
    throw new Error(`arm ${label}: no built CLI at ${cliEntry} after a successful build`);
  }

  // A DIRTY arm is refused by the plan (`clean: true` requires an empty
  // porcelain), and `node_modules`/`dist` are git-ignored so this must hold after
  // install+build. Asserting it here names the cause instead of surfacing it as
  // an invalid observation.
  const porcelain = porcelainOf(dir);
  if (porcelain === null) {
    throw new Error(`arm ${label}: could not read \`git status --porcelain\` in ${dir}`);
  }
  if (porcelain.trim() !== "") {
    throw new Error(
      `arm ${label}: ${dir} is DIRTY after install/build, so the plan would refuse it as non-reproducible:\n` +
        porcelain
          .split(/\r?\n/)
          .filter((l) => l.trim() !== "")
          .slice(0, 20)
          .join("\n"),
    );
  }

  return { dir, sha, cliEntry };
}

function firstLine(err) {
  const text = err instanceof Error ? err.message : String(err);
  // stderr is where pnpm puts the useful line; fall back to the message itself.
  const stderr = err !== null && typeof err === "object" && "stderr" in err ? String(err.stderr ?? "") : "";
  for (const raw of [stderr, text].join("\n").split(/\r?\n/)) {
    const line = raw.trim();
    if (line !== "") return line.slice(0, 400);
  }
  return "no output";
}

/** Read `--flag value` pairs, refusing a flag with no value. */
export function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return v;
  };
  return {
    root: value("--root"),
    baseline: value("--baseline"),
    candidate: value("--candidate"),
    printEnv: argv.includes("--print-env"),
  };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`r97-observe-arms: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CONFIG;
  }

  const baselineSha = parsed.baseline ?? process.env["R97_ARM_BASELINE_SHA"] ?? DEFAULT_BASELINE_SHA;
  const candidateSha = parsed.candidate ?? process.env["R97_ARM_CANDIDATE_SHA"] ?? DEFAULT_CANDIDATE_SHA;
  for (const [label, sha] of [
    ["--baseline", baselineSha],
    ["--candidate", candidateSha],
  ]) {
    if (!isSha(sha)) {
      process.stderr.write(`r97-observe-arms: ${label} must be a 40-hex commit sha (got ${JSON.stringify(sha)})\n`);
      return EXIT_CONFIG;
    }
  }
  if (baselineSha === candidateSha) {
    // The plan refuses a same-revision A/B (`ARMS_NOT_DISTINCT`), so preparing one
    // here would produce two arms that can never finalize. Refusing now is
    // cheaper and names the real problem.
    process.stderr.write(
      `r97-observe-arms: baseline and candidate are the SAME revision (${baselineSha}) — the plan refuses a same-build A/B, so there is nothing to prepare\n`,
    );
    return EXIT_CONFIG;
  }

  const root = parsed.root !== undefined ? resolve(parsed.root) : await mkdtemp(join(tmpdir(), "r97-arms-"));
  const dirs = {
    baseline: join(root, "baseline"),
    candidate: join(root, "candidate"),
  };

  if (parsed.printEnv) {
    // Print the variables for a pair that ALREADY exists, without touching disk.
    for (const [arm, dir] of Object.entries(dirs)) {
      process.stdout.write(`${ARM_DIR_ENV[arm]}=${dir}\n`);
    }
    return EXIT_OK;
  }

  process.stdout.write(`r97-observe-arms: root ${root}\n`);
  const prepared = {};
  for (const [arm, sha] of [
    ["baseline", baselineSha],
    ["candidate", candidateSha],
  ]) {
    process.stdout.write(`r97-observe-arms: preparing ${arm} @ ${sha}\n`);
    try {
      prepared[arm] = await prepareArm({ label: arm, sha, dir: dirs[arm], repoRoot: REPO_ROOT });
    } catch (err) {
      // SETUP FAILURE. Nothing is printed as ready, and the partial worktree is
      // left in place for inspection rather than silently deleted.
      process.stderr.write(`r97-observe-arms: SETUP FAILED — ${err instanceof Error ? err.message : String(err)}\n`);
      return EXIT_SETUP_FAILED;
    }
    process.stdout.write(`r97-observe-arms: ${arm} ready — ${prepared[arm].cliEntry}\n`);
  }

  // The two variables the D6 test reads, on stdout so a caller can eval them.
  process.stdout.write("\n# Export these, then run the D6 acceptance path:\n");
  process.stdout.write(`${ARM_DIR_ENV.baseline}=${prepared.baseline.dir}\n`);
  process.stdout.write(`${ARM_DIR_ENV.candidate}=${prepared.candidate.dir}\n`);
  process.stdout.write("\n# npx vitest run packages/evaluation/src/r97-driver-closed-loop.test.ts -t D6\n");
  return EXIT_OK;
}

// Run only when invoked directly, so the module stays importable by tests.
// `pathToFileURL` (not string concatenation) because the checkout root routinely
// contains a space on Windows and a hand-built `file://` URL would not match.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
