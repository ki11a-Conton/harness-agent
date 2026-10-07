/**
 * N2 — the FORWARD fixture for the release `prereg` chain.
 *
 * WHAT THIS IS
 * ------------
 * A test may prepare temporary directories and input files; it may NOT inject a
 * test capability, a fake executor or a hand-made verifier outcome into the
 * release CLI. This module builds only the FORMER:
 *
 *   `prepareIdentityRoot(dir)`  a real git work tree containing
 *       - `docs/evidence/tool-call-efficiency-case-selection.json` — a selection
 *         artifact whose `cases` are a SUBSET of the committed frozen selection
 *         and whose `selectionProvenanceDigest` is computed by the package's own
 *         `computeFrozenSelectionDigest` (never hand-typed);
 *       - `docs/evidence/e4-r85-failure-taxonomy.json` — the COMMITTED bytes
 *         (copied verbatim, so the selection's `evidenceDigest` still matches);
 *       - `benchmarks/<suite>/<caseId>/…` — the COMMITTED case bytes, copied.
 *     Everything the observer re-derives (candidate source sha, clean tree, case
 *     content digests, eligibility digests, selection provenance) is therefore
 *     re-derived from REAL bytes; only the DATASET is narrowed to the one case
 *     this task must prove, which is what keeps the release-entry E2E bounded.
 *
 *   `prepareArmCheckout(dir, mode)`  a real git work tree for ONE arm:
 *       - `mode: "stub"` — the five declared build entries as tiny loadable
 *         modules. Enough for the executor's preflight (closure digest, entry
 *         hash, probe) when the arm is not actually LAUNCHED (the pricing
 *         composition test drives the admitted provider directly);
 *       - `mode: "real"` — the repository's OWN compiled output (`apps/cli/dist`
 *         and the declared package barrels) plus `node_modules/@ar/*` links into
 *         the arm's own copies, so the isolated worker really loads THIS arm's
 *         build and the runtime it imports is the arm's, not the driver's.
 *     The two arms are made byte-distinct by a declared variant marker, because
 *     the executor refuses one build for both arms (`ARM_BUILD_IDENTICAL`).
 *
 * NOTHING here writes into the repository: every root lives under
 * `.ci/n2-forward/` (git-ignored) or the OS temp directory.
 */

import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  R97_ARM_BUILD_ENTRIES,
  TOOL_CALL_EFFICIENCY_CASE_SELECTION_PATH,
  TOOL_CALL_EFFICIENCY_TAXONOMY_PATH,
  computeArmBuildDigestV1,
  computeFrozenSelectionDigest,
} from "@ar/evaluation";

/** The one frozen, non-holdout case the N2 forward run must complete. */
// Command verification now obeys the frozen network-deny policy. Use an
// already-selected, non-network oracle for the positive release-chain fixture;
// the unchanged HTTP case has a separate refusal regression.
export const N2_FORWARD_CASE = Object.freeze({ suite: "regression", caseId: "reg-12-csv-parse" });

const REPO_ROOT = process.cwd();

/** Run git in `dir`, failing loudly (a fixture that silently is not a work tree
 *  would make `cleanTree`/`candidateSourceSha` unchecked). */
function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

export function initCleanGitTree(dir: string): string {
  // `core.autocrlf=false` so the committed bytes are the bytes on disk: a
  // checkout that rewrites line endings would report a DIRTY tree immediately.
  git(dir, ["init", "-q", "--initial-branch=n2-forward"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "user.name", "n2-forward"]);
  git(dir, ["config", "user.email", "n2-forward@local"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "n2 forward fixture"]);
  const porcelain = git(dir, ["status", "--porcelain"]);
  if (porcelain !== "") throw new Error(`n2 forward fixture is not a clean work tree:\n${porcelain}`);
  return git(dir, ["rev-parse", "HEAD"]);
}

export interface PreparedIdentityRoot {
  root: string;
  /** The 40-hex HEAD the observer will re-derive as `candidateSourceSha`. */
  head: string;
  selectionPath: string;
  taxonomyPath: string;
  /** The case ids the narrowed dataset binds (always including the forward case). */
  caseIds: string[];
}

/**
 * Build the identity root the release chain observes.
 *
 * The narrowed case set is asserted to be a SUBSET of the committed frozen
 * selection (and never a holdout case), so "the dataset was reduced" can never
 * silently become "the dataset was replaced by something else".
 *
 * `maxCases` exists because the prerequisite builder enforces its own minimum
 * (`TOO_FEW_CASES: … < contract minimum 5`): a smaller dataset is not a legal
 * pre-registration at all, so a fixture that must BUILD an artifact asks for at
 * least five. `N2_FORWARD_CASE` is always kept FIRST, so the case this task
 * proves is present at every size.
 */
export function prepareIdentityRoot(root: string, opts: { maxCases?: number } = {}): PreparedIdentityRoot {
  const maxCases = opts.maxCases ?? 5;
  const selectionAbs = join(REPO_ROOT, TOOL_CALL_EFFICIENCY_CASE_SELECTION_PATH);
  const taxonomyAbs = join(REPO_ROOT, TOOL_CALL_EFFICIENCY_TAXONOMY_PATH);
  const committed = JSON.parse(readFileSync(selectionAbs, "utf8")) as {
    cases: { caseId: string; suite: string }[];
    [k: string]: unknown;
  };
  const isForwardCase = (c: { suite: string; caseId: string }): boolean =>
    c.suite === N2_FORWARD_CASE.suite && c.caseId === N2_FORWARD_CASE.caseId;
  if (committed.cases.filter(isForwardCase).length !== 1) {
    throw new Error(
      `${N2_FORWARD_CASE.suite}/${N2_FORWARD_CASE.caseId} is not in the committed frozen selection — refusing to build a dataset that is not a subset of it`,
    );
  }
  if ((N2_FORWARD_CASE.suite as string) === "holdout") throw new Error("the forward case may never be a holdout case");

  // REORDER, never add: the forward case first, then the committed order. A case
  // whose directory is missing is still legal to BIND (the observer would omit
  // its content digest and the gate would refuse), so it is dropped here only
  // because this fixture must produce an OBSERVABLE dataset.
  const ordered = [
    ...committed.cases.filter(isForwardCase),
    ...committed.cases.filter((c) => !isForwardCase(c)),
  ].filter((c) => existsSync(join(REPO_ROOT, "benchmarks", c.suite, c.caseId)));
  const picked = ordered.slice(0, maxCases);
  if (picked.length < maxCases) {
    throw new Error(`only ${picked.length} committed frozen cases exist in this checkout; asked for ${maxCases}`);
  }
  mkdirSync(join(root, "docs", "evidence"), { recursive: true });
  // The taxonomy is copied VERBATIM: the selection binds it by the digest of its
  // raw bytes, so any edit here would (correctly) fail the digest check.
  cpSync(taxonomyAbs, join(root, TOOL_CALL_EFFICIENCY_TAXONOMY_PATH));

  // The isolated arm worker is resolved relative to the RUNNING checkout
  // (`createPreregArmExecutor`'s `rootDir`, which the release CLI takes from its
  // own cwd), and the executor refuses with `ARM_WORKER_ENTRY_MISSING` when it is
  // absent. It is a self-contained `node:`-only module, so copying it verbatim is
  // enough — and it must be COMMITTED here, because the observer requires a clean
  // work tree.
  const workerRel = join("scripts", "e4", "prereg-arm-isolated-worker.mjs");
  const workerAbs = join(REPO_ROOT, workerRel);
  if (!existsSync(workerAbs)) throw new Error(`the arm worker ${workerRel} is missing from this checkout`);
  mkdirSync(join(root, "scripts", "e4"), { recursive: true });
  cpSync(workerAbs, join(root, workerRel));

  // The case bytes are copied verbatim from the repository: the observer hashes
  // THEM, so the artifact and the observation agree on real content.
  for (const c of picked) {
    cpSync(join(REPO_ROOT, "benchmarks", c.suite, c.caseId), join(root, "benchmarks", c.suite, c.caseId), {
      recursive: true,
    });
  }

  const body = {
    ...committed,
    cases: picked,
  } as Record<string, unknown> & { cases: { caseId: string; suite: string }[] };
  const selection = {
    ...body,
    selectionProvenanceDigest: computeFrozenSelectionDigest(
      body as unknown as Parameters<typeof computeFrozenSelectionDigest>[0],
    ),
  };
  const selectionOut = join(root, TOOL_CALL_EFFICIENCY_CASE_SELECTION_PATH);
  writeFileSync(selectionOut, `${JSON.stringify(selection, null, 2)}\n`, "utf8");

  const head = initCleanGitTree(root);
  return {
    root,
    head,
    selectionPath: selectionOut,
    taxonomyPath: join(root, TOOL_CALL_EFFICIENCY_TAXONOMY_PATH),
    caseIds: picked.map((c) => c.caseId),
  };
}

export type ArmMode = "stub" | "real";

export interface PreparedArm {
  dir: string;
  digest: string;
  head: string;
}

/** Link `<arm>/node_modules/<name>` to its target (junction on Windows). */
function linkDir(target: string, linkPath: string): void {
  mkdirSync(join(linkPath, ".."), { recursive: true });
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

/**
 * The third-party deps the built CLI/packages resolve by bare specifier. The
 * arm gets its own `node_modules` so it is a real checkout rather than a tree
 * that silently borrows the driver's resolution.
 */
function linkExternalDeps(armDir: string): void {
  const candidateRoots = [
    join(REPO_ROOT, "apps", "cli", "node_modules"),
    ...readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(REPO_ROOT, "packages", e.name, "node_modules")),
  ];
  for (const nodeModules of candidateRoots) {
    if (!existsSync(nodeModules)) continue;
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const names = entry.name.startsWith("@")
        ? readdirSync(join(nodeModules, entry.name)).map((n) => `${entry.name}/${n}`)
        : [entry.name];
      for (const name of names) {
        if (name.startsWith("@ar/")) continue; // the arm's OWN packages, linked below
        const link = join(armDir, "node_modules", name);
        if (existsSync(link)) continue;
        const target = join(nodeModules, name);
        if (!existsSync(target)) continue;
        linkDir(target, link);
      }
    }
  }
}

/**
 * Write ONE arm checkout.
 *
 * `stub` exists for tests that must prove the executor's IDENTITY preflight but
 * never launch the arm. `real` assembles the repository's own compiled output,
 * so the isolated worker loads a genuine build of this source tree.
 */
export function prepareArmCheckout(dir: string, mode: ArmMode, variant: string): PreparedArm {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `n2-arm-${variant}`, private: true, type: "module" }, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");

  const t0 = Date.now();
  const step = (what: string): void => {
    process.stderr.write(`[n2-arm:${variant}] ${what}: ${Date.now() - t0} ms\n`);
  };

  if (mode === "stub") {
    for (const rel of R97_ARM_BUILD_ENTRIES) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      const body =
        rel.endsWith("benchmark-command.js")
          ? [
              `export const R97_ARM_PROBE = "n2-stub-probe-${variant}";`,
              `export const R97_ARM_ABI = ["model-proxy-v1", "tool-budget-rpc-v1"];`,
              "export async function runOneCase(caseDef) {",
              "  return {",
              "    caseId: caseDef.id,",
              '    status: "passed",',
              '    actualStatus: "passed",',
              "    events: [],",
              "    metrics: { turn_count: 0, tool_call_count: 0, tokens_input: 1, tokens_output: 1, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 0 },",
              "    violations: [],",
              '    suite: caseDef.suite ?? "regression",',
              '    judgeVersion: "n2-stub-judge",',
              "  };",
              "}",
            ].join("\n")
          : `export const N2_STUB = ${JSON.stringify(`${rel}:${variant}`)};`;
      writeFileSync(abs, `${body}\n`, "utf8");
    }
  } else {
    // The REAL arm build: the repository's compiled CLI plus EVERY compiled
    // package, copied so the arm is a checkout of THIS build rather than a
    // pointer into the driver's tree.
    //
    // EVERY package, not only the five declared entries: the executor's closure
    // walk refuses any `@ar/*` specifier that resolves outside the arm
    // (`E4-R97-IDENTITY: … imports "@ar/contracts", which resolves outside …`),
    // because an arm that quietly borrows the driver's modules is not a
    // reproducible build of the arm. Linking the repository copy instead would
    // hit exactly that refusal, so the copies and the links must agree.
    cpSync(join(REPO_ROOT, "apps", "cli", "dist"), join(dir, "apps", "cli", "dist"), { recursive: true });
    for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(REPO_ROOT, "packages", entry.name);
      if (!existsSync(join(pkgDir, "dist"))) continue;
      cpSync(join(pkgDir, "dist"), join(dir, "packages", entry.name, "dist"), { recursive: true });
      if (existsSync(join(pkgDir, "package.json"))) {
        cpSync(join(pkgDir, "package.json"), join(dir, "packages", entry.name, "package.json"));
      }
    }
    // ...and every `@ar/*` name resolves to the arm's OWN copy, so one module
    // instance per package is loaded and `/health`-style brand checks cannot see
    // two copies of the same class.
    for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const link = join(dir, "node_modules", "@ar", name);
      if (existsSync(link)) continue;
      const armCopy = join(dir, "packages", name);
      if (!existsSync(join(armCopy, "dist"))) continue;
      linkDir(armCopy, link);
    }
    linkExternalDeps(dir);
  }
  step("build copied + links created");

  // A DECLARED variant marker. The executor refuses ONE build for both arms
  // (`ARM_BUILD_IDENTICAL`), so the two checkouts must be byte-distinct; the
  // marker makes the difference explicit and auditable rather than incidental.
  const entry = join(dir, R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"))!);
  writeFileSync(entry, `${readFileSync(entry, "utf8")}\n// n2-arm-variant: ${variant}\n`, "utf8");

  const digest = computeArmBuildDigestV1(dir);
  step("closure digest computed");
  const head = initCleanGitTree(dir);
  step("git tree committed");
  return { dir, digest, head };
}

/** Remove a fixture tree, tolerating a Windows junction that a plain rm cannot follow. */
export function removeFixture(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

/** Large real build trees must finish removal without blocking the hook timer.
 * rm removes a junction itself, never the dependency tree it points to. */
export async function removeFixtureAsync(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (existsSync(path)) throw new Error("N2_FIXTURE_CLEANUP_INCOMPLETE");
}
