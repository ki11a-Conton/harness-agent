/**
 * E4-R100-A (T4) — BIND THE APPROVED IDENTITY TO THE ACTUAL EXECUTION.
 *
 * WHAT THIS PINS (plan §T4 做什么 3/4, 怎么做 6/8/9, 怎么验收 3/5)
 * --------------------------------------------------------------
 * MEASURED DEFECT N6 (plan §0.2, priority P0):
 *
 *   "driver 不把批准的 provider/model/endpoint/input digest 传给 worker."
 *
 * The plan §T4 怎么做 6 states the requirement exactly:
 *
 *   "显式向 worker 传递批准的 providerId/modelId/endpoint 以及输入摘要。worker 必须
 *    使用它们构造请求；不能回落到 openai/gpt-4o-mini 或环境里的另一 endpoint。缺必需
 *    字段直接拒绝."
 *
 * MEASURED: the offline executor's argv was literally
 *
 *     "--provider", "openai",
 *     "--model", opts.modelId ?? "gpt-4o-mini",
 *
 * so the identity that actually reached the request was a HARDCODED constant. A
 * plan approved for `local-test-endpoint`/`approved-model` would have run as
 * `openai`/`gpt-4o-mini`, and the acceptance criterion —
 *
 *   "批准非默认模型和本地测试 endpoint，实际捕获请求中的 model/目标地址与批准一致；
 *    污染环境默认值不能改变请求目的地"
 *
 * — could not have held. The tests below capture the request the arm's runtime
 * ACTUALLY produced and compare it against the approved identity, which is the
 * only way to tell "the flag was passed" from "the request went there".
 *
 * MEASURED DEFECT N7 (plan §0.2, priority P1):
 *
 *   "observeArms 指纹目录错误，armBuildIdentity 漏掉实际导入的执行模块."
 *
 * `armBuildIdentity`'s manifest listed two paths and hashed only ONE of them by
 * content — everything else entered the digest as `size:mtime`. Plan §T4 怎么做 8
 * forbids exactly that:
 *
 *   "使用字节 hash，不依赖 mtime/size。至少覆盖 benchmark-command、runtime、
 *    provider/verification 的实际执行依赖与 adapter."
 *
 * A rebuild that preserved size and mtime therefore left the approved build
 * digest UNCHANGED while the bytes that run a case had changed. The tests below
 * change content while PRESERVING size and mtime, and require the digest to move.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const WORKER = pathToFileURL(join(REPO, "scripts", "e4", "r97-arm-worker.mjs")).href;
const EXEC = pathToFileURL(join(REPO, "scripts", "e4", "r97-arm-exec.mjs")).href;
const EVAL = pathToFileURL(join(REPO, "packages", "evaluation", "dist", "index.js")).href;

const worker = (await import(WORKER)) as {
  armBuildIdentity: (dir: string) => { checkoutDir: string; sourceSha: string | null; buildDigest: string | null };
  BUILD_ARTIFACT_PATHS?: readonly (readonly string[])[];
  requiredIdentityOf: (o: Record<string, unknown>) => { providerId: string; modelId: string; endpointBaseUrl: string | null; issue: string | null };
  runArmUnit: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  ARM_WORKER_VERSION: string;
};

const exec = (await import(EXEC)) as {
  armExecutionDigest: (dir: string) => Promise<{ digest: string; files: number } | null>;
  executionManifest: (dir: string) => Promise<readonly string[]>;
};

const evaluation = (await import(EVAL)) as {
  loadBenchmarkCase: (dir: string) => Promise<{
    requestMd: unknown;
    expectedMd: unknown;
    fixture: unknown;
    verification?: unknown;
    requires?: unknown;
    schemaMode?: unknown;
  }>;
  caseInputFingerprintV1: (parts: Record<string, unknown>) => string;
};

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r100-identity-"));
  dirs.push(d);
  return d;
}

/**
 * The machine-global advisory claim anchor is redirected per run, INSIDE
 * `runWithIdentity` below, rather than by a helper here: the anchor's default
 * lives in the system temp directory, so ledgers opened by this file share
 * campaign ids with ledgers opened by OTHER test files running in parallel
 * workers. That collision is a fact about the anchor, not about the identity
 * under test.
 */
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

describe("R100 I1: the approved identity is REQUIRED, never defaulted", () => {
  it("accepts an explicitly approved provider/model/endpoint", () => {
    const got = worker.requiredIdentityOf({
      providerId: "openai",
      modelId: "approved-model-x",
      endpointBaseUrl: "http://127.0.0.1:9/v1",
    });
    expect(got.issue).toBeNull();
    expect(got.providerId).toBe("openai");
    expect(got.modelId).toBe("approved-model-x");
    expect(got.endpointBaseUrl).toBe("http://127.0.0.1:9/v1");
  });

  it("REFUSES a missing or empty modelId rather than falling back to gpt-4o-mini", () => {
    // Plan §T4 怎么做 6: "不能回落到 openai/gpt-4o-mini … 缺必需字段直接拒绝."
    for (const bad of [undefined, "", "   "]) {
      const got = worker.requiredIdentityOf({
        providerId: "openai",
        modelId: bad,
        endpointBaseUrl: "http://127.0.0.1:9/v1",
      });
      expect(got.issue, `modelId ${JSON.stringify(bad)} must be refused`).not.toBeNull();
      expect(got.issue).toMatch(/model/i);
    }
  });

  it("REFUSES a missing providerId rather than falling back to openai", () => {
    for (const bad of [undefined, ""]) {
      const got = worker.requiredIdentityOf({ providerId: bad, modelId: "m", endpointBaseUrl: "http://127.0.0.1:9/v1" });
      expect(got.issue).not.toBeNull();
      expect(got.issue).toMatch(/provider/i);
    }
  });

  it("REFUSES a malformed endpoint, and treats `null` as the provider default", () => {
    // `null` is a legitimate approval: it means "the provider's built-in
    // endpoint", which is a real choice the plan digest covers.
    const none = worker.requiredIdentityOf({ providerId: "openai", modelId: "m", endpointBaseUrl: null });
    expect(none.issue).toBeNull();
    expect(none.endpointBaseUrl).toBeNull();
    // A non-URL is not a choice, it is a broken approval.
    for (const bad of ["not a url", "ftp://x/y", ""]) {
      const got = worker.requiredIdentityOf({ providerId: "openai", modelId: "m", endpointBaseUrl: bad });
      expect(got.issue, `endpoint ${JSON.stringify(bad)} must be refused`).not.toBeNull();
    }
  });
});

describe("R100 I2: the request the arm ACTUALLY made carries the approved identity", () => {
  /**
   * Drive ONE real unit with an explicit, NON-DEFAULT identity and read the
   * identity back out of the arm's own report.
   *
   * The report's `meta.model` is written by the arm CLI from the plan it actually
   * executed (`benchmark-command.ts`), so it is a measurement of what ran — not a
   * restatement of the argv this test passed.
   */
  async function runWithIdentity(over: Record<string, unknown>) {
    const root = await tempDir();
    const build = worker.armBuildIdentity(REPO);
    // The advisory claim anchor is MACHINE-GLOBAL on disk (default:
    // `tmpdir()/e4-r97-campaign-claims`), so a ledger opened here shares a
    // campaign id with ledgers opened by OTHER test files running in parallel
    // workers. Without this redirect a run is refused with
    // `BUDGET_CAMPAIGN_DIR_DUPLICATE` — a collision between unrelated suites, not
    // a fact about the identity being measured. Redirecting to a per-run scratch
    // anchor makes each identity run its own campaign, which is what it is.
    const anchor = await tempDir();
    const previous = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
    process.env["R97_CAMPAIGN_CLAIMS_DIR"] = anchor;
    try {
      return await worker.runArmUnit({
        checkoutDir: REPO,
        repoRoot: REPO,
        caseId: "r98-tool-write-request",
        suite: "regression",
        arm: "baseline",
        repetition: 1,
        planDigest: "a".repeat(64),
        approvedSourceSha: build.sourceSha,
        executionStateDir: join(root, "state"),
        ledgerDir: join(root, "ledger"),
        outDir: join(root, "out"),
        timeoutMs: 300_000,
        ...over,
      });
    } finally {
      if (previous === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
      else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = previous;
    }
  }

  it("runs under the APPROVED model and endpoint, not the default pair", async () => {
    const record = await runWithIdentity({
      providerId: "openai",
      modelId: "approved-model-x",
      endpointBaseUrl: "http://127.0.0.1:9/v1",
    });
    // The unit really executed, so there is a report to read the identity from.
    expect(String(record["detail"])).toContain("verification_passed=");
    const report = record["report"] as Record<string, unknown>;
    expect(report).not.toBeNull();

    // THE MEASUREMENT: three independent views of the identity, none of them a
    // restatement of the argv this test passed.
    //
    //   declared — what the ARM'S OWN CLI bound for this argv (its dry-run plan);
    //   runtime  — the ModelRef the CORE RUNTIME handed to `createClient`.
    const execution = record["executionIdentity"] as {
      declaredModelId?: string | null;
      runtimeModelId?: string | null;
      approvedModelId?: string | null;
      declaredEndpointIdentity?: string | null;
      drift?: readonly string[];
    } | null;
    expect(execution, "the worker must record the identity it actually executed under").toBeTruthy();
    expect(execution!.approvedModelId).toBe("approved-model-x");
    // The arm's own plan and the runtime's own model ref must AGREE with the
    // approval. Either one disagreeing is the drift the worker refuses.
    expect(execution!.declaredModelId, "the arm's own plan must bind the APPROVED model").toBe("approved-model-x");
    expect(execution!.runtimeModelId, "the runtime must actually ask for the APPROVED model").toBe("approved-model-x");
    expect(execution!.declaredModelId).not.toBe("gpt-4o-mini");
    expect(execution!.drift).toEqual([]);
    // The endpoint is bound as a digest, never the raw URL (it is not a secret,
    // but the plan's own contract normalizes it).
    expect(execution!.declaredEndpointIdentity).toMatch(/^[0-9a-f]{64}$/);
  }, 300_000);

  it("a DIFFERENT endpoint produces a DIFFERENT endpoint identity — the flag reaches the plan", async () => {
    // Each run is its own campaign (`runWithIdentity` gives each one a scratch
    // claim anchor), so this measures the endpoint flag and nothing else.
    const a = await runWithIdentity({
      providerId: "openai",
      modelId: "m-one",
      endpointBaseUrl: "http://127.0.0.1:9/v1",
      planDigest: "b".repeat(64),
    });
    const b = await runWithIdentity({
      providerId: "openai",
      modelId: "m-one",
      endpointBaseUrl: "http://127.0.0.1:10/v1",
      planDigest: "c".repeat(64),
    });
    const ia = a["executionIdentity"] as { declaredEndpointIdentity?: string } | null;
    const ib = b["executionIdentity"] as { declaredEndpointIdentity?: string } | null;
    expect(ia).toBeTruthy();
    expect(ib).toBeTruthy();
    // If `--endpoint` never reached the arm's CLI, both would bind the SAME
    // identity (the provider's built-in default) and these would be equal.
    expect(ia!.declaredEndpointIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(ia!.declaredEndpointIdentity).not.toBe(ib!.declaredEndpointIdentity);
  }, 600_000);

  it("REFUSES to dispatch at all when the identity is incomplete", async () => {
    // A refusal must happen BEFORE the ledger is touched, so an incomplete
    // approval cannot charge the campaign for work it may not run.
    const root = await tempDir();
    const build = worker.armBuildIdentity(REPO);
    const record = await worker.runArmUnit({
      checkoutDir: REPO,
      repoRoot: REPO,
      caseId: "r98-tool-write-request",
      suite: "regression",
      arm: "baseline",
      repetition: 1,
      planDigest: "a".repeat(64),
      approvedSourceSha: build.sourceSha,
      executionStateDir: join(root, "state"),
      ledgerDir: join(root, "ledger"),
      outDir: join(root, "out"),
      // The approved identity is missing: this must be a refusal, not a default.
      providerId: "openai",
      modelId: undefined,
    });
    expect(record["status"]).toBe("failed");
    expect(record["failureCategory"]).toBe("harness");
    expect(String(record["detail"])).toMatch(/model/i);
    // NOTHING was dispatched and NOTHING was charged.
    expect(record["consumed"]).toBe(0);
  }, 120_000);
});

describe("R100 I3: the build identity is a BYTE hash over the modules that actually execute", () => {
  /** Build a minimal fake arm tree with the given content at a fixed mtime. */
  async function fakeArm(files: Record<string, string>): Promise<string> {
    const dir = await tempDir();
    const when = new Date("2020-01-01T00:00:00Z");
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, ...rel.split("/"));
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
      await utimes(abs, when, when);
    }
    return dir;
  }

  it("names the modules the executor really imports, not just main.js", () => {
    // The executor imports `benchmark-command.js` and `packages/model/dist/
    // index.js` (see `loadArmModules`). A manifest that covers neither cannot
    // detect a change to what runs a case.
    const manifest = (worker.BUILD_ARTIFACT_PATHS ?? []).map((p) => p.join("/"));
    expect(manifest).toContain("apps/cli/dist/benchmark-command.js");
    expect(manifest).toContain("packages/model/dist/index.js");
    // The runtime that drives the tool loop and the verifier that judges it.
    expect(manifest).toContain("packages/core/dist/index.js");
    expect(manifest).toContain("packages/evaluation/dist/index.js");
  });

  it("CHANGES when content changes while size and mtime are PRESERVED", async () => {
    // Plan §T4 怎么做 8: "使用字节 hash，不依赖 mtime/size."
    // Two DIFFERENT strings of the SAME length, written with the SAME mtime: a
    // size+mtime digest cannot tell them apart.
    const a = await fakeArm({
      "apps/cli/dist/benchmark-command.js": "//AAAAAAAA",
      "apps/cli/dist/main.js": "//M",
      "packages/model/dist/index.js": "//N",
      "packages/evaluation/dist/index.js": "//E",
      "packages/core/dist/index.js": "//C",
    });
    const b = await fakeArm({
      "apps/cli/dist/benchmark-command.js": "//BBBBBBBB",
      "apps/cli/dist/main.js": "//M",
      "packages/model/dist/index.js": "//N",
      "packages/evaluation/dist/index.js": "//E",
      "packages/core/dist/index.js": "//C",
    });
    // The precondition that makes this test meaningful: same size, same mtime.
    const sa = await stat(join(a, "apps", "cli", "dist", "benchmark-command.js"));
    const sb = await stat(join(b, "apps", "cli", "dist", "benchmark-command.js"));
    expect(sa.size).toBe(sb.size);
    expect(Math.trunc(sa.mtimeMs)).toBe(Math.trunc(sb.mtimeMs));
    expect(await readFile(join(a, "apps", "cli", "dist", "benchmark-command.js"), "utf8")).not.toBe(
      await readFile(join(b, "apps", "cli", "dist", "benchmark-command.js"), "utf8"),
    );

    const ia = worker.armBuildIdentity(a);
    const ib = worker.armBuildIdentity(b);
    expect(ia.buildDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      ib.buildDigest,
      "a byte-identical-in-size change to the module that RUNS a case must move the build digest",
    ).not.toBe(ia.buildDigest);
  });

  it("is null when a covered module is missing, so an unestablished build never passes", async () => {
    const partial = await fakeArm({
      "apps/cli/dist/benchmark-command.js": "//x",
      "apps/cli/dist/main.js": "//y",
      // packages/model/dist/index.js is deliberately absent.
    });
    expect(worker.armBuildIdentity(partial).buildDigest).toBeNull();
  });

  it("the executed-bytes manifest covers the provider and runtime trees, not only the CLI", async () => {
    const manifest = await exec.executionManifest(REPO);
    const roots = new Set(manifest.map((rel) => rel.split("/").slice(0, 2).join("/")));
    // The runtime that executes a case and the provider/verification code it
    // calls are part of what runs — plan §T4 怎么做 8 names them explicitly.
    expect(roots.has("packages/model")).toBe(true);
    expect(roots.has("packages/core")).toBe(true);
    expect(roots.has("apps/cli")).toBe(true);
  });
});

// ===========================================================================
// E4-R103 (A3 怎么做 3/5) — THE WORKER RUNS THE BYTES IT WAS APPROVED FOR.
// ===========================================================================
//
// Plan §A3 怎么做 3: "worker 接到明确批准的案例指纹，并校验自己复制后真正要运行的内容."
// Plan §A3 怎么做 5: "将 approved case fingerprint / inputsDigest 显式传给 worker；缺少
// 必需摘要直接拒绝. 消除 `repo:unknown` 可以用于正式执行的路径."
//
// MEASURED DEFECTS this block pins:
//
//   F3(b) `inputDigestFor` built `repo:${opts.inputsDigest ?? "unknown"}` and the
//         formal caller never passed one, so every formal unit's durable input
//         digest was the literal `repo:unknown` — the drift check the execution
//         state implements had a constant to compare.
//   F3(d) `stageCase` verified only that the staged `case.json` PARSED and that its
//         declared suite matched. The bytes that would actually execute
//         (`request.md`, `expected.md`, `fixture/**`) were never compared to the
//         approved fingerprint, so unapproved content ran under an approved name.
describe("E4-R103 (A3): the worker stages the bytes it was approved for", () => {
  const CASE_ID = "r98-tool-write-request";
  const CASE_SRC = join(REPO, "benchmarks", "r98-fixtures", CASE_ID);
  const fingerprintOf = async (dir: string) => {
    const c = await evaluation.loadBenchmarkCase(dir);
    return evaluation.caseInputFingerprintV1({
      requestMd: c.requestMd,
      expectedMd: c.expectedMd,
      fixture: c.fixture,
      verification: c.verification ?? null,
      requires: c.requires ?? null,
      schemaMode: c.schemaMode ?? null,
    });
  };

  /**
   * Run one unit against an explicit checkout, with its own campaign claim anchor
   * so this suite cannot collide with a ledger another test file opened.
   */
  async function runUnitIn(checkoutDir: string, over: Record<string, unknown> = {}) {
    const root = await tempDir();
    const anchor = await tempDir();
    const previous = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
    process.env["R97_CAMPAIGN_CLAIMS_DIR"] = anchor;
    try {
      return await worker.runArmUnit({
        checkoutDir,
        repoRoot: REPO,
        caseId: CASE_ID,
        suite: "regression",
        arm: "baseline",
        repetition: 1,
        planDigest: "d".repeat(64),
        // The build binding is exercised elsewhere; this block measures the INPUT
        // binding, so the sha check is deliberately out of the way.
        approvedSourceSha: null,
        providerId: "openai",
        modelId: "approved-model-x",
        endpointBaseUrl: "http://127.0.0.1:9/v1",
        executionStateDir: join(root, "state"),
        ledgerDir: join(root, "ledger"),
        outDir: join(root, "out"),
        timeoutMs: 120_000,
        ...over,
      });
    } finally {
      if (previous === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
      else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = previous;
    }
  }

  /** A minimal arm tree: the five artifacts the build identity covers, a real git
   *  HEAD (the build identity refuses a checkout whose revision is unknown), and a
   *  real copy of the case under test. Nothing here is ever imported — the units
   *  below refuse during STAGING, which is the point. */
  async function armTreeWithCase() {
    const dir = await tempDir();
    for (const [rel, content] of Object.entries({
      "apps/cli/dist/main.js": "// stub main\n",
      "apps/cli/dist/benchmark-command.js": "export async function runBenchmarkCommand() { throw new Error('stub'); }\n",
      "packages/model/dist/index.js": "export class ScriptedModelProvider {}\n",
      "packages/evaluation/dist/index.js": "export const stub = true;\n",
      "packages/core/dist/index.js": "export const stub = true;\n",
    })) {
      const abs = join(dir, ...rel.split("/"));
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
    const dest = join(dir, "benchmarks", "r98-fixtures", CASE_ID);
    await mkdir(join(dest, ".."), { recursive: true });
    await cp(CASE_SRC, dest, { recursive: true });
    // `armBuildIdentity` reads `git rev-parse HEAD`, and a checkout whose revision
    // cannot be established is refused before staging. One empty commit gives this
    // tree a real HEAD without needing any of the arm's history.
    const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git(["init", "--quiet"]);
    git(["-c", "user.email=a3@example.invalid", "-c", "user.name=a3", "commit", "--quiet", "--allow-empty", "-m", "arm tree"]);
    return dir;
  }

  it("REFUSES a unit dispatched with NO approved fingerprint, before the ledger exists", async () => {
    const root = await tempDir();
    const anchor = await tempDir();
    const previous = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
    process.env["R97_CAMPAIGN_CLAIMS_DIR"] = anchor;
    let record: Record<string, unknown>;
    try {
      record = await worker.runArmUnit({
        checkoutDir: REPO,
        repoRoot: REPO,
        caseId: CASE_ID,
        suite: "regression",
        arm: "baseline",
        repetition: 1,
        planDigest: "d".repeat(64),
        approvedSourceSha: null,
        providerId: "openai",
        modelId: "approved-model-x",
        endpointBaseUrl: "http://127.0.0.1:9/v1",
        executionStateDir: join(root, "state"),
        ledgerDir: join(root, "ledger"),
        outDir: join(root, "out"),
        // THE FORMAL CALLER'S DECLARATION: an approved input digest is required.
        requireInputsDigest: true,
      });
    } finally {
      if (previous === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
      else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = previous;
    }
    expect(record["status"]).toBe("failed");
    expect(record["failureCategory"]).toBe("harness");
    expect(String(record["detail"])).toMatch(/approved case fingerprint|inputsDigest/i);
    expect(record["consumed"]).toBe(0);
    // "Before the ledger exists" is the stronger property: a unit with no approved
    // inputs cannot even open the campaign's allowance.
    expect(existsSync(join(root, "ledger"))).toBe(false);
  }, 120_000);

  it("REFUSES when the staged bytes do not match the approved fingerprint", async () => {
    // The case is real and stages cleanly; only the APPROVED value is wrong. This
    // is the shape of "the checkout's case content changed after approval": the
    // unit must refuse rather than execute bytes nobody fingerprinted.
    const record = await runUnitIn(REPO, {
      inputsDigest: "f".repeat(64),
      requireInputsDigest: true,
    });
    expect(record["status"]).toBe("failed");
    expect(record["failureCategory"]).toBe("harness");
    const detail = String(record["detail"]);
    // Both sides are named, so an operator can see WHICH bytes changed rather than
    // receiving "mismatch".
    expect(detail).toContain("f".repeat(64));
    expect(detail).toMatch(/fingerprint as [0-9a-f]{64}/);
    expect(detail).toMatch(/content nobody approved/);
    // NOTHING was dispatched: no report, no captured request, no charge.
    expect(record["report"]).toBeNull();
    expect(record["capturedRequests"]).toEqual([]);
    expect(record["consumed"]).toBe(0);
    expect(record["stagedCaseFingerprint"]).toBeNull();
  }, 180_000);

  it("REFUSES when the SOURCE changes inside the copy window (probe → copy)", async () => {
    // Plan §A3 怎么做 5: "staging 完成后重新计算实际字节的指纹，与批准值比较". The window
    // between "which case did I find?" and "what did I copy?" is exactly where a
    // checkout can move underneath the unit, and a check that runs BEFORE the copy
    // cannot see it. The barrier makes that window deterministic instead of racy.
    const checkout = await armTreeWithCase();
    const approved = await fingerprintOf(join(checkout, "benchmarks", "r98-fixtures", CASE_ID));
    const record = await runUnitIn(checkout, {
      inputsDigest: approved,
      requireInputsDigest: true,
      beforeStageCopy: async ({ source }: { source: string }) => {
        // The source is mutated AFTER it was probed and BEFORE it is copied.
        await writeFile(join(source, "request.md"), "MUTATED DURING THE COPY WINDOW\n");
      },
    });
    expect(record["status"]).toBe("failed");
    expect(record["failureCategory"]).toBe("harness");
    expect(String(record["detail"])).toMatch(/content nobody approved/);
    expect(record["consumed"]).toBe(0);
    expect(record["stagedCaseFingerprint"]).toBeNull();
  }, 180_000);

  it("ACCEPTS matching bytes and records the fingerprint it actually staged", async () => {
    // The negative cases above are only meaningful if the check is not simply
    // refusing everything: the SAME call with the CORRECT fingerprint must get past
    // staging and record what it staged.
    const checkout = await armTreeWithCase();
    const approved = await fingerprintOf(join(checkout, "benchmarks", "r98-fixtures", CASE_ID));
    const record = await runUnitIn(checkout, {
      inputsDigest: approved,
      requireInputsDigest: true,
    });
    expect(record["stagedCaseFingerprint"]).toBe(approved);
    // It got PAST staging: whatever happened next (this stub tree cannot execute a
    // case) is not a fingerprint refusal.
    expect(String(record["detail"] ?? "")).not.toMatch(/content nobody approved/);
    expect(String(record["caseSource"] ?? "")).toContain(CASE_ID);
  }, 180_000);
});

// ===========================================================================
// E4-R104 (A4) — THE APPROVED BUILD IDENTITY COVERS WHAT REALLY EXECUTES.
// ===========================================================================
//
// MEASURED DEFECT F4 (release integrity, plan §A4):
//
//   "armBuildIdentity 的 BUILD_ARTIFACT_PATHS 是手写的五个文件名；packages/core/
//    dist/runtime/runtime.js、packages/evaluation/dist/r97-budget-channel.js 等
//    真正执行 case 的模块既不在清单里、也不在其传递闭包里。改写它们不会移动
//    buildDigest，旧批准继续有效."
//
// The three tests below are the three halves of that defect, and each one names the
// production change that makes it fail:
//
//   1. coverage — a change to a module reached THROUGH the real import graph (not
//      named by any list) must move the digest;
//   2. fail-closed — an execution dependency that cannot be resolved must make the
//      identity "not established" (`null`), never a digest over what is left;
//   3. refusal — an approval that recorded digest D must be REFUSED before the
//      first call once the build no longer hashes to D.
describe("E4-R104 (A4): the arm build identity is derived from the real import graph", () => {
  const A4_CASE_ID = "r98-tool-write-request";

  /**
   * A synthetic arm whose EXECUTOR really imports a TRANSITIVE module.
   *
   * The link is the whole point: `benchmark-command.js` is a genuine entry file,
   * and the module that drives the runtime sits two hops below it, behind a
   * relative specifier. A hand-written file list never sees it.
   */
  async function linkedArm(runtimeBody = 'export const RT = "AAAA";\n'): Promise<string> {
    const dir = await tempDir();
    const when = new Date("2020-01-01T00:00:00Z");
    const files: Record<string, string> = {
      "apps/cli/dist/main.js": "// stub main\n",
      "apps/cli/dist/benchmark-command.js": [
        'import "../../../packages/model/dist/index.js";',
        'import "../../../packages/core/dist/index.js";',
        'export async function runBenchmarkCommand() { throw new Error("stub"); }',
        "",
      ].join("\n"),
      "packages/model/dist/index.js": "export class ScriptedModelProvider {}\n",
      "packages/core/dist/index.js": 'import "./runtime/runtime.js";\nexport const stub = true;\n',
      "packages/core/dist/runtime/runtime.js": runtimeBody,
      "packages/evaluation/dist/index.js": "export const stub = true;\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, ...rel.split("/"));
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
      await utimes(abs, when, when);
    }
    // `armBuildIdentity` reads `git rev-parse HEAD`, and a checkout whose revision
    // cannot be established is refused before staging.
    const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git(["init", "--quiet"]);
    git(["-c", "user.email=a4@example.invalid", "-c", "user.name=a4", "commit", "--quiet", "--allow-empty", "-m", "arm tree"]);
    return dir;
  }

  it("1. CHANGES when a TRANSITIVELY imported module changes, at identical size and mtime", async () => {
    const dir = await linkedArm('export const RT = "AAAA";\n');
    const before = worker.armBuildIdentity(dir);
    expect(before.buildDigest, "the fixture must establish an identity at all").toMatch(/^[0-9a-f]{64}$/);

    // The module is two hops from the entry file and is named by NO list. It is
    // rewritten to a string of the SAME LENGTH, and the original mtime is put back,
    // so only a content hash can notice.
    const runtime = join(dir, "packages", "core", "dist", "runtime", "runtime.js");
    const st = await stat(runtime);
    await writeFile(runtime, 'export const RT = "BBBB";\n');
    await utimes(runtime, st.atime, st.mtime);
    const after = await stat(runtime);
    expect(after.size).toBe(st.size);
    expect(Math.trunc(after.mtimeMs)).toBe(Math.trunc(st.mtimeMs));

    expect(
      worker.armBuildIdentity(dir).buildDigest,
      "a change to a module reached through the real import graph must invalidate the approved build",
    ).not.toBe(before.buildDigest);
  }, 120_000);

  it("2. is NOT ESTABLISHED (null) when an execution dependency cannot be resolved", async () => {
    // Deleting a dependency the executor imports must not produce a digest of the
    // remaining files: that is a smaller covered set wearing the same name, and it
    // would let a broken checkout look approved.
    const dir = await linkedArm();
    expect(worker.armBuildIdentity(dir).buildDigest).toMatch(/^[0-9a-f]{64}$/);
    await rm(join(dir, "packages", "core", "dist", "runtime", "runtime.js"));
    expect(
      worker.armBuildIdentity(dir).buildDigest,
      "an unresolvable execution dependency means the build identity is NOT ESTABLISHED",
    ).toBeNull();
  }, 120_000);

  it("3. REFUSES a unit whose approved build digest no longer matches, before the ledger opens", async () => {
    // Recording that a build changed is NOT the same as refusing to run a changed
    // build: the refusal has to happen before the first external call, and before
    // the campaign is charged for work it may not run.
    const dir = await linkedArm();
    const approved = worker.armBuildIdentity(dir);
    expect(approved.buildDigest).toMatch(/^[0-9a-f]{64}$/);

    const runtime = join(dir, "packages", "core", "dist", "runtime", "runtime.js");
    const st = await stat(runtime);
    await writeFile(runtime, 'export const RT = "BBBB";\n');
    await utimes(runtime, st.atime, st.mtime);

    const root = await tempDir();
    const anchor = await tempDir();
    const previous = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
    process.env["R97_CAMPAIGN_CLAIMS_DIR"] = anchor;
    let record: Record<string, unknown>;
    try {
      record = await worker.runArmUnit({
        checkoutDir: dir,
        repoRoot: REPO,
        caseId: A4_CASE_ID,
        suite: "regression",
        arm: "baseline",
        repetition: 1,
        planDigest: "d".repeat(64),
        approvedSourceSha: approved.sourceSha,
        // THE APPROVAL'S OWN BUILD BINDING. Without it a unit runs whatever bytes
        // happen to be on disk, which is the defect.
        approvedBuildDigest: approved.buildDigest,
        providerId: "openai",
        modelId: "approved-model-x",
        endpointBaseUrl: "http://127.0.0.1:9/v1",
        executionStateDir: join(root, "state"),
        ledgerDir: join(root, "ledger"),
        outDir: join(root, "out"),
        timeoutMs: 30_000,
      });
    } finally {
      if (previous === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
      else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = previous;
    }
    expect(record["status"]).toBe("failed");
    expect(record["failureCategory"]).toBe("harness");
    expect(String(record["detail"] ?? ""), "the refusal must NAME the build digest it refused").toMatch(
      /build digest/i,
    );
    // NOTHING was dispatched and NOTHING was charged — not even a ledger was opened.
    expect(record["consumed"]).toBe(0);
    expect(record["capturedRequests"]).toEqual([]);
    expect(existsSync(join(root, "ledger"))).toBe(false);
  }, 120_000);
});
