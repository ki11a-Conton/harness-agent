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
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const WORKER = pathToFileURL(join(REPO, "scripts", "e4", "r97-arm-worker.mjs")).href;
const EXEC = pathToFileURL(join(REPO, "scripts", "e4", "r97-arm-exec.mjs")).href;

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
