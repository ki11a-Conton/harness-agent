/**
 * S4/task-6 — THE STRICT R5 FORMAL GATE (plan(20260929-015956).md §8, defect F5).
 *
 * WHAT THIS FILE IS
 *   A deterministic, offline counter-example suite over the gate in
 *   `scripts/e4/r5-real-formal.mjs`. The slow real dual-build chain stays in that
 *   script; this file never runs a campaign, never builds an arm and never makes a
 *   network request.
 *
 * HOW IT WORKS
 *   The gate is driven as a SUBPROCESS in its verify modes, because the thing under
 *   test is the EXIT CODE and the NAMED reason a report prints — not an in-process
 *   return value. `--emit-fixture-bundle` writes a deliberately synthetic but
 *   internally CONSISTENT bundle; every case below copies it, breaks exactly one
 *   invariant, and asserts that the gate exits NONZERO and NAMES the invariant it
 *   found.
 *
 * WHAT IT DOES NOT PROVE
 *   A passing `--verify` proves the bundle is CONSISTENT with its own bytes. It does
 *   NOT prove a real experiment ran — that is why every fixture carries
 *   `fixture: true` and why the real-chain mode must additionally require that the
 *   chain actually executed. "Harness gate passed" is not "experiment decision
 *   ACCEPT", and neither is model quality.
 *
 * OFFLINE: the only provider anywhere near this file is an in-process scripted
 * double inside the gate script's own phases, which this file does not invoke.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const GATE_SCRIPT = join(REPO_ROOT, "scripts", "e4", "r5-real-formal.mjs");
const PAIR_CONFIG_PATH = join(REPO_ROOT, "scripts", "e4", "r5-formal-pair.json");

type Json = Record<string, any>;

type GateRun = { status: number; output: string };

/** Run the gate and capture BOTH streams: the named reason must survive either one. */
function runGate(args: string[]): GateRun {
  const result = spawnSync(process.execPath, [GATE_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, "utf8")) as Json;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function editJson(path: string, mutate: (doc: Json) => void): Promise<void> {
  const doc = await readJson(path);
  mutate(doc);
  await writeJson(path, doc);
}

let workRoot = "";
let fixture = "";
let realShaped = "";

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "r5-formal-gate-"));
  fixture = join(workRoot, "fixture");
  const emitted = runGate(["--emit-fixture-bundle", fixture]);
  if (emitted.status !== 0) {
    throw new Error(`--emit-fixture-bundle failed (exit ${emitted.status}):\n${emitted.output}`);
  }
  // S5/N5 — a bundle with the REAL bundle's SHAPE. The build-binding checks below
  // can only be exercised on a bundle that carries the fields they require, and a
  // fixture is exempt from that PRESENCE rule on purpose. It is emitted by the same
  // synthetic emitter, so SHAPE is not EVIDENCE that an experiment ran.
  realShaped = join(workRoot, "real-shaped");
  const emittedReal = runGate(["--emit-real-shaped-bundle", realShaped]);
  if (emittedReal.status !== 0) {
    throw new Error(`--emit-real-shaped-bundle failed (exit ${emittedReal.status}):\n${emittedReal.output}`);
  }
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
});

/** Copy the consistent fixture, break exactly one invariant, return the new root. */
async function brokenCopy(name: string, mutate: (dir: string) => Promise<void>): Promise<string> {
  const dir = join(workRoot, `case-${name}`);
  await cp(fixture, dir, { recursive: true });
  await mutate(dir);
  return dir;
}

/** The same, from the REAL-SHAPED control bundle (build fields present). */
async function brokenRealCopy(name: string, mutate: (dir: string) => Promise<void>): Promise<string> {
  const dir = join(workRoot, `real-case-${name}`);
  await cp(realShaped, dir, { recursive: true });
  await mutate(dir);
  return dir;
}

async function expectRefusal(dir: string, code: string): Promise<GateRun> {
  const run = runGate(["--verify", dir]);
  expect(run.output).toContain(code);
  expect(run.status).not.toBe(0);
  return run;
}

describe("the consistent baseline bundle", () => {
  it("passes, so every counter-example below isolates exactly one broken invariant", () => {
    const run = runGate(["--verify", fixture]);
    expect(run.output).toContain("GATE PASS");
    expect(run.status).toBe(0);
  });

  it("is labelled a fixture, so a consistent bundle can never be read as a real experiment", async () => {
    const identity = await readJson(join(fixture, "identity.json"));
    expect(identity["fixture"]).toBe(true);
    expect(identity["schemaVersion"]).toBe("e4-r5-evidence-v1");
  });

  it("is re-verifiable from a copy in a DIFFERENT directory, from the bundle alone", async () => {
    const moved = join(workRoot, "moved-elsewhere", "deep", "nested");
    await cp(fixture, moved, { recursive: true });
    const run = runGate(["--verify", moved]);
    expect(run.status).toBe(0);
    expect(run.output).toContain("GATE PASS");
  });
});

describe("raw evidence is re-read, never trusted", () => {
  it("refuses a schedule missing a planned record, naming MISSING_RECORD", async () => {
    const dir = await brokenCopy("missing-record", async (d) => {
      await editJson(join(d, "schedule.json"), (doc) => {
        doc["records"] = (doc["records"] as unknown[]).slice(0, -1);
      });
    });
    await expectRefusal(dir, "MISSING_RECORD");
  });

  it("refuses a record whose result was replaced with passed, naming WRONG_AS_PASSED", async () => {
    const dir = await brokenCopy("wrong-as-passed", async (d) => {
      const schedule = await readJson(join(d, "schedule.json"));
      const record = (schedule["records"] as Json[])[0]!;
      const verifierPath = join(d, "evidence", String(record["armRunId"]), "verifier.json");
      // The raw verifier says the work did NOT verify; the record claims it did.
      await editJson(verifierPath, (doc) => {
        doc["verifiedCompletion"] = false;
      });
      await editJson(join(d, "schedule.json"), (doc) => {
        (doc["records"] as Json[])[0]!["verifiedCompletion"] = true;
      });
    });
    await expectRefusal(dir, "WRONG_AS_PASSED");
  });

  it("refuses a manifest whose bytes no longer match its recorded traceDigest, naming CORRUPT_RECORD", async () => {
    const dir = await brokenCopy("corrupt-record", async (d) => {
      const schedule = await readJson(join(d, "schedule.json"));
      const record = (schedule["records"] as Json[])[0]!;
      const manifestPath = join(d, "evidence", String(record["armRunId"]), "manifest.json");
      const original = await readFile(manifestPath, "utf8");
      await writeFile(manifestPath, `${original}\n`, "utf8");
    });
    await expectRefusal(dir, "CORRUPT_RECORD");
  });

  it("refuses a deleted verifier, naming INCOMPLETE_EVIDENCE", async () => {
    const dir = await brokenCopy("deleted-verifier", async (d) => {
      const schedule = await readJson(join(d, "schedule.json"));
      const record = (schedule["records"] as Json[])[0]!;
      await rm(join(d, "evidence", String(record["armRunId"]), "verifier.json"), { force: true });
    });
    await expectRefusal(dir, "INCOMPLETE_EVIDENCE");
  });

  it("refuses an evidence directory that is absent entirely, naming MISSING_EVIDENCE", async () => {
    const dir = await brokenCopy("missing-evidence", async (d) => {
      const schedule = await readJson(join(d, "schedule.json"));
      const record = (schedule["records"] as Json[])[0]!;
      await rm(join(d, "evidence", String(record["armRunId"])), { recursive: true, force: true });
    });
    await expectRefusal(dir, "MISSING_EVIDENCE");
  });

  it("refuses an aggregate that disagrees with the raw journal, naming JOURNAL_MISMATCH", async () => {
    const dir = await brokenCopy("journal-mismatch", async (d) => {
      await editJson(join(d, "aggregate.json"), (doc) => {
        (doc["cost"] as Json)["totalTokens"] = 999_999;
      });
    });
    await expectRefusal(dir, "JOURNAL_MISMATCH");
  });

  it("refuses an unexplained infrastructure error, naming UNEXPLAINED_INFRA_ERROR", async () => {
    const dir = await brokenCopy("unexplained-error", async (d) => {
      await editJson(join(d, "schedule.json"), (doc) => {
        const record = (doc["records"] as Json[])[0]!;
        record["status"] = "error";
        delete record["reason"];
      });
    });
    await expectRefusal(dir, "UNEXPLAINED_INFRA_ERROR");
  });
});

describe("content sensitivity and identity", () => {
  it("refuses a matrix where the empty variant passed, naming CONTENT_INSENSITIVE", async () => {
    const dir = await brokenCopy("content-insensitive", async (d) => {
      await editJson(join(d, "content-matrix.json"), (doc) => {
        const cases = doc["cases"] as Json;
        const first = cases[Object.keys(cases)[0]!] as Json;
        ((first["arms"] as Json)["baseline"] as Json)["empty"] = "passed";
      });
    });
    await expectRefusal(dir, "CONTENT_INSENSITIVE");
  });

  it("refuses a matrix that never ran a degradation variant, naming CONTENT_MATRIX_INCOMPLETE", async () => {
    // The honest failure mode: the four-variant schedule did not run. Deleting the
    // case would hide it, so the gate must FAIL and name the missing variant.
    const dir = await brokenCopy("content-matrix-incomplete", async (d) => {
      await editJson(join(d, "content-matrix.json"), (doc) => {
        const cases = doc["cases"] as Json;
        const first = cases[Object.keys(cases)[0]!] as Json;
        ((first["arms"] as Json)["candidate"] as Json)["skipped"] = "absent";
      });
    });
    await expectRefusal(dir, "CONTENT_MATRIX_INCOMPLETE");
  });

  it("refuses a matrix whose correct variant did not pass, naming CONTENT_CORRECT_FAILED", async () => {
    const dir = await brokenCopy("content-correct-failed", async (d) => {
      await editJson(join(d, "content-matrix.json"), (doc) => {
        const cases = doc["cases"] as Json;
        const first = cases[Object.keys(cases)[0]!] as Json;
        ((first["arms"] as Json)["baseline"] as Json)["correct"] = "failed";
      });
    });
    await expectRefusal(dir, "CONTENT_CORRECT_FAILED");
  });

  it("refuses a missing-ABI negative that reached the model, naming MISSING_ABI_REACHED_MODEL", async () => {
    const dir = await brokenCopy("missing-abi-reached-model", async (d) => {
      await editJson(join(d, "negatives.json"), (doc) => {
        const row = (doc["rows"] as Json[]).find((r) => r["violation"] === "missing-ABI")!;
        row["physicalModelCalls"] = 1;
        row["refusedBeforeAnyModelCall"] = false;
      });
    });
    await expectRefusal(dir, "MISSING_ABI_REACHED_MODEL");
  });

  it("refuses a negative refused for the WRONG reason, naming NEGATIVE_WRONG_REASON", async () => {
    // The hole the first real run exposed: a dirty driver work tree refuses EVERY
    // counter-example with PREREGISTRATION_IDENTITY_DRIFT, so a matrix of rows that
    // merely "refused" would look complete while proving nothing about any boundary.
    const dir = await brokenCopy("negative-wrong-reason", async (d) => {
      await editJson(join(d, "negatives.json"), (doc) => {
        const row = (doc["rows"] as Json[]).find((r) => r["violation"] === "missing-ABI")!;
        row["refusalCode"] = "PREREGISTRATION_IDENTITY_DRIFT";
      });
    });
    await expectRefusal(dir, "NEGATIVE_WRONG_REASON");
  });

  it("refuses a negative with no expected code, naming NEGATIVE_WRONG_REASON", async () => {
    const dir = await brokenCopy("negative-no-expectation", async (d) => {
      await editJson(join(d, "negatives.json"), (doc) => {
        const row = (doc["rows"] as Json[]).find((r) => r["violation"] === "unsupported-isolation")!;
        delete row["expectedRefusalCode"];
      });
    });
    await expectRefusal(dir, "NEGATIVE_WRONG_REASON");
  });

  it("refuses a wrong arm checkout, naming WRONG_PAIR", async () => {
    const dir = await brokenCopy("wrong-pair", async (d) => {
      await editJson(join(d, "identity.json"), (doc) => {
        ((doc["pair"] as Json)["baseline"] as Json)["sourceSha"] = "0".repeat(40);
      });
    });
    await expectRefusal(dir, "WRONG_PAIR");
  });

  it("refuses two arms that share one execution closure, naming IDENTICAL_CLOSURE", async () => {
    const dir = await brokenCopy("identical-closure", async (d) => {
      await editJson(join(d, "identity.json"), (doc) => {
        const pair = doc["pair"] as Json;
        (pair["candidate"] as Json)["buildDigest"] = (pair["baseline"] as Json)["buildDigest"];
      });
    });
    await expectRefusal(dir, "IDENTICAL_CLOSURE");
  });

  it("refuses a dirty arm checkout, naming DIRTY_ARM", async () => {
    const dir = await brokenCopy("dirty-arm", async (d) => {
      await editJson(join(d, "identity.json"), (doc) => {
        ((doc["pair"] as Json)["baseline"] as Json)["clean"] = false;
      });
    });
    await expectRefusal(dir, "DIRTY_ARM");
  });

  it("refuses an unrefused isolation/policy counter-example, naming POLICY_OR_ISOLATION_UNREFUSED", async () => {
    const dir = await brokenCopy("policy-unrefused", async (d) => {
      await editJson(join(d, "negatives.json"), (doc) => {
        const row = (doc["rows"] as Json[]).find((r) => r["violation"] === "unsupported-isolation")!;
        row["refused"] = false;
      });
    });
    await expectRefusal(dir, "POLICY_OR_ISOLATION_UNREFUSED");
  });
});

describe("the pinned pair is read from ONE authoritative file", () => {
  it("pins both arms in scripts/e4/r5-formal-pair.json and nowhere else", async () => {
    const config = await readJson(PAIR_CONFIG_PATH);
    expect(config["schemaVersion"]).toBe("e4-r5-formal-pair-v1");
    for (const armId of ["baseline", "candidate"]) {
      const sha = String((config[armId] as Json)["sha"]);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
    expect((config["allowedArmDiff"] as string[]).length).toBeGreaterThan(0);
  });

  it("refuses observations for a wrong HEAD, an identical closure and an infrastructure diff", async () => {
    const config = await readJson(PAIR_CONFIG_PATH);
    const good = (): Json => ({
      exists: true,
      head: String((config["baseline"] as Json)["sha"]),
      clean: true,
      buildDigest: "a".repeat(64),
      protocolFixes: { "P2-41": true, "P2-43": true },
      workerAbi: ["model-proxy-rpc-v1", "tool-budget-rpc-v1"],
    });
    const observations = {
      baseline: good(),
      candidate: { ...good(), head: "1".repeat(40), buildDigest: "a".repeat(64) },
      armDiffFiles: ["packages/evaluation/src/mechanism-guidance.ts", "packages/core/src/orchestrator.ts"],
    };
    const path = join(workRoot, "observations-broken.json");
    await writeJson(path, observations);
    const run = runGate(["--verify-pair-observations", path]);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("WRONG_PAIR");
    expect(run.output).toContain("IDENTICAL_CLOSURE");
    expect(run.output).toContain("INFRASTRUCTURE_DIFF");
  });

  it("accepts observations that match the pinned pair", async () => {
    const config = await readJson(PAIR_CONFIG_PATH);
    const arm = (id: string, digest: string): Json => ({
      exists: true,
      head: String((config[id] as Json)["sha"]),
      clean: true,
      buildDigest: digest,
      protocolFixes: { "P2-41": true, "P2-43": true },
      workerAbi: ["model-proxy-rpc-v1", "tool-budget-rpc-v1"],
    });
    const path = join(workRoot, "observations-good.json");
    await writeJson(path, {
      baseline: arm("baseline", "a".repeat(64)),
      candidate: arm("candidate", "b".repeat(64)),
      armDiffFiles: ["packages/evaluation/src/mechanism-guidance.ts"],
    });
    const run = runGate(["--verify-pair-observations", path]);
    expect(run.output).toContain("PAIR OK");
    expect(run.status).toBe(0);
  });

  it("refuses an arm that does not declare the versioned worker ABI, naming WORKER_ABI_MISSING", async () => {
    const config = await readJson(PAIR_CONFIG_PATH);
    const arm = (id: string, digest: string): Json => ({
      exists: true,
      head: String((config[id] as Json)["sha"]),
      clean: true,
      buildDigest: digest,
      protocolFixes: { "P2-41": true, "P2-43": true },
      workerAbi: [],
    });
    const path = join(workRoot, "observations-no-abi.json");
    await writeJson(path, {
      baseline: arm("baseline", "a".repeat(64)),
      candidate: arm("candidate", "b".repeat(64)),
      armDiffFiles: ["packages/evaluation/src/mechanism-guidance.ts"],
    });
    const run = runGate(["--verify-pair-observations", path]);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("WORKER_ABI_MISSING");
  });

  it("is the SAME pair scripts/e4/r97-observe-arms.mjs exposes as --pair r5", async () => {
    const config = await readJson(PAIR_CONFIG_PATH);
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(new URL("../../../scripts/e4/r97-observe-arms.mjs", import.meta.url).href)}); process.stdout.write(JSON.stringify({ r5: m.R5_PAIR, r97: [m.DEFAULT_BASELINE_SHA, m.DEFAULT_CANDIDATE_SHA] }));`,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const parsed = JSON.parse(probe.stdout) as { r5: Json; r97: string[] };
    // The formal pair comes FROM the config...
    expect(parsed.r5["baseline"]).toBe(String((config["baseline"] as Json)["sha"]));
    expect(parsed.r5["candidate"]).toBe(String((config["candidate"] as Json)["sha"]));
    // ...and the R97/R101 pair is deliberately UNTOUCHED, because
    // r97-driver-closed-loop.test.ts asserts those two exact SHAs and the
    // historical manifests are load-bearing.
    expect(parsed.r97).toEqual([
      "4f8d98ec65d475844d3ed4b959a3199f84ed5d03",
      "2314ce1db40bfa10dc58b0d136e0696450e90cc8",
    ]);
  });
});

// ---------------------------------------------------------------------------
// S5/N5 — the build identity is BOUND to the execution evidence
// ---------------------------------------------------------------------------
//
// WHY THIS BLOCK EXISTS. The gate used to accept, with exit 0, a bundle whose
// root `buildDigest` had been swapped, whose arm `entrySha256` had been swapped,
// whose record carried ANOTHER arm run's manifest, and whose manifests had the
// build fields deleted. Checking that a digest is 64-hex, and that two JSON files
// repeat each other, is not a binding. Measured against the pre-S5 gate:
//
//   | tamper                                   | pre-S5 | post-S5 |
//   | swap only the root buildDigest            | exit 0 | ARM_BUILD_DIGEST_MISMATCH |
//   | swap only one arm's entrySha256           | exit 0 | ARM_ENTRY_MISMATCH |
//   | splice another run's manifest             | exit 0 | MANIFEST_IDENTITY_MISMATCH |
//   | delete the manifest build fields          | exit 0 | ARM_BUILD_FIELDS_MISSING |
//   | swap baseline/candidate                   | WRONG_PAIR | WRONG_PAIR (unchanged) |
//
// FIXTURE COMPATIBILITY IS SEPARATE, deliberately: a bundle that DECLARES
// `fixture: true` is never evidence an experiment ran, and it is exempt from the
// PRESENCE requirement only — whatever build fields it does carry must still be
// self-consistent. A bundle that does not declare itself a fixture must name the
// build that ran, for every record.

describe("S5/N5 — the build identity is bound to the execution evidence", () => {
  it("control: a bundle with the real SHAPE passes, so each tamper below isolates one dimension", () => {
    const run = runGate(["--verify", realShaped]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("GATE PASS");
  });

  it("refuses a swapped ROOT buildDigest, naming ARM_BUILD_DIGEST_MISMATCH", async () => {
    const dir = await brokenRealCopy("root-build-digest", async (d) => {
      await editJson(join(d, "identity.json"), (doc) => {
        ((doc["pair"] as Json)["baseline"] as Json)["buildDigest"] = "e".repeat(64);
      });
    });
    await expectRefusal(dir, "ARM_BUILD_DIGEST_MISMATCH");
  });

  it("refuses a swapped ARM ENTRY hash, naming ARM_ENTRY_MISMATCH", async () => {
    const dir = await brokenRealCopy("arm-entry-hash", async (d) => {
      await editJson(join(d, "identity.json"), (doc) => {
        ((doc["pair"] as Json)["candidate"] as Json)["entrySha256"] = "9".repeat(64);
      });
    });
    await expectRefusal(dir, "ARM_ENTRY_MISMATCH");
  });

  it("refuses a SPLICED manifest even when its traceDigest was kept consistent, naming MANIFEST_IDENTITY_MISMATCH", async () => {
    // The traceDigest is re-derived from the spliced bytes on purpose: otherwise
    // CORRUPT_RECORD would catch it and this counter-example would prove nothing
    // about the identity binding.
    const dir = await brokenRealCopy("spliced-manifest", async (d) => {
      const schedule = await readJson(join(d, "schedule.json"));
      const records = schedule["records"] as Json[];
      const first = records[0]!;
      const second = records[1]!;
      const secondManifest = await readFile(join(d, "evidence", String(second["armRunId"]), "manifest.json"), "utf8");
      await writeFile(join(d, "evidence", String(first["armRunId"]), "manifest.json"), secondManifest, "utf8");
      await editJson(join(d, "schedule.json"), (doc) => {
        (doc["records"] as Json[])[0]!["traceDigest"] = createHash("sha256").update(secondManifest, "utf8").digest("hex");
      });
    });
    const run = await expectRefusal(dir, "MANIFEST_IDENTITY_MISMATCH");
    expect(run.output, "the spliced manifest was caught by its integrity digest, not by the identity binding").not.toContain("CORRUPT_RECORD");
  });

  it("refuses SWAPPED baseline/candidate identities, naming WRONG_PAIR", async () => {
    const dir = await brokenRealCopy("swapped-identities", async (d) => {
      await editJson(join(d, "identity.json"), (doc) => {
        const pair = doc["pair"] as Json;
        const baseline = pair["baseline"];
        pair["baseline"] = pair["candidate"];
        pair["candidate"] = baseline;
      });
    });
    await expectRefusal(dir, "WRONG_PAIR");
  });

  it("refuses two manifests EXCHANGED between the arms, naming ARM_BUILD_DIGEST_MISMATCH", async () => {
    // This is the tamper that entry-SHA equality between arms cannot catch: the two
    // real arms can share an entry hash, so the arm identity is the CLOSURE digest
    // and the probe.
    const dir = await brokenRealCopy("exchanged-manifests", async (d) => {
      const schedule = await readJson(join(d, "schedule.json"));
      const records = schedule["records"] as Json[];
      const first = records[0]!;
      const second = records[1]!;
      const firstPath = join(d, "evidence", String(first["armRunId"]), "manifest.json");
      const secondPath = join(d, "evidence", String(second["armRunId"]), "manifest.json");
      const firstText = await readFile(firstPath, "utf8");
      const secondText = await readFile(secondPath, "utf8");
      await writeFile(firstPath, secondText, "utf8");
      await writeFile(secondPath, firstText, "utf8");
      await editJson(join(d, "schedule.json"), (doc) => {
        const records = doc["records"] as Json[];
        records[0]!["traceDigest"] = createHash("sha256").update(secondText, "utf8").digest("hex");
        records[1]!["traceDigest"] = createHash("sha256").update(firstText, "utf8").digest("hex");
      });
    });
    const run = await expectRefusal(dir, "ARM_BUILD_DIGEST_MISMATCH");
    expect(run.output).toContain("MANIFEST_IDENTITY_MISMATCH");
  });

  it("refuses a manifest whose build fields were DELETED, naming ARM_BUILD_FIELDS_MISSING", async () => {
    const dir = await brokenRealCopy("deleted-build-fields", async (d) => {
      const schedule = await readJson(join(d, "schedule.json"));
      for (const rec of schedule["records"] as Json[]) {
        const manifestPath = join(d, "evidence", String(rec["armRunId"]), "manifest.json");
        const doc = await readJson(manifestPath);
        delete doc["armBuildDigest"];
        delete doc["armEntrySha256"];
        delete doc["armProbe"];
        const text = `${JSON.stringify(doc, null, 2)}\n`;
        await writeFile(manifestPath, text, "utf8");
        await editJson(join(d, "schedule.json"), (sched) => {
          const target = (sched["records"] as Json[]).find((r) => r["armRunId"] === rec["armRunId"])!;
          target["traceDigest"] = createHash("sha256").update(text, "utf8").digest("hex");
        });
      }
    });
    await expectRefusal(dir, "ARM_BUILD_FIELDS_MISSING");
  });

  it("refuses a bundle with no LOADED probe in its root identity, naming ARM_IDENTITY_INCOMPLETE", async () => {
    const dir = await brokenRealCopy("no-root-probe", async (d) => {
      await editJson(join(d, "identity.json"), (doc) => {
        ((doc["pair"] as Json)["baseline"] as Json)["probe"] = null;
      });
    });
    await expectRefusal(dir, "ARM_IDENTITY_INCOMPLETE");
  });

  it("keeps the LABELLED fixture working, so fixture compatibility stays separate from the real-layer rule", async () => {
    // Same single-dimension tamper as the deleted-build-fields case above, applied
    // to the bundle that declares `fixture: true`: presence is not required there
    // (and it is never evidence), but the real layer above still refuses it.
    const dir = await brokenCopy("fixture-no-build-fields", async (d) => {
      const schedule = await readJson(join(d, "schedule.json"));
      for (const rec of schedule["records"] as Json[]) {
        const manifestPath = join(d, "evidence", String(rec["armRunId"]), "manifest.json");
        const doc = await readJson(manifestPath);
        delete doc["armBuildDigest"];
        delete doc["armEntrySha256"];
        delete doc["armProbe"];
        const text = `${JSON.stringify(doc, null, 2)}\n`;
        await writeFile(manifestPath, text, "utf8");
        await editJson(join(d, "schedule.json"), (sched) => {
          const target = (sched["records"] as Json[]).find((r) => r["armRunId"] === rec["armRunId"])!;
          target["traceDigest"] = createHash("sha256").update(text, "utf8").digest("hex");
        });
      }
    });
    const run = runGate(["--verify", dir]);
    expect(run.output, run.output).toContain("GATE PASS");
    expect(run.status).toBe(0);
  });
});
