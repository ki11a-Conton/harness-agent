/**
 * S5/N5 — THE PAIR'S BASELINE IS *DERIVED*, AND THE DERIVATION IS PROVEN.
 *
 * `scripts/e4/r5-formal-pair.json` (and the E4-R5 report) claimed that
 * `r5-real-formal.mjs --setup-pair` "creates the baseline locally from the candidate
 * SHA when it is absent, so the pair is reproducible offline". The flag existed and
 * NOTHING consumed it: the claim was false, and the pair was reproducible only by
 * fetching a commit this repository does not contain.
 *
 * The implementation now exists and is DETERMINISTIC — the same candidate always
 * yields the same baseline SHA on any machine, offline — and this file proves it the
 * only way that is worth anything: by making the generator reproduce a commit a
 * HUMAN built by another route.
 *
 * THE HEADLINE EVIDENCE. `4f8d98ec` is the hand-made R15 comparable baseline:
 * `2314ce1d` plus one commit whose entire diff is mechanism-guidance.ts
 * (`git diff --numstat` = `1 20`). Feeding the generator the HISTORICAL recipe
 * (that commit's own message, author and timestamp) must reproduce it
 * BYTE-FOR-BYTE — same blob `e11c4231…`, same tree `8c0471fc…`, same commit
 * `4f8d98ec…`. That is a property, not an assertion about our own output.
 *
 * A SHALLOW CLONE HAS NEITHER OBJECT. The historical cases SKIP (loudly, naming why)
 * when `2314ce1d`/`4f8d98ec` are absent, so the suite is honest on CI instead of red
 * for a reason that has nothing to do with the code under test.
 *
 * OFFLINE: git plumbing only. No network, no provider, no arm build.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DRIVER_URL = new URL("../../../scripts/e4/r5-real-formal.mjs", import.meta.url).href;
const GATE_SCRIPT = resolve(fileURLToPath(new URL("../../../scripts/e4/r5-real-formal.mjs", import.meta.url)));
const HISTORICAL_CANDIDATE = "2314ce1db40bfa10dc58b0d136e0696450e90cc8";
const HISTORICAL_BASELINE = "4f8d98ec65d475844d3ed4b959a3199f84ed5d03";
const HISTORICAL_BLOB = "e11c4231451e67d6ed84db1b92d32000e9c0db21";
const HISTORICAL_TREE = "8c0471fc664bf9c1a5d17bbb08ded70960474626";
const MECHANISM_PATH = "packages/evaluation/src/mechanism-guidance.ts";

function git(args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function objectPresent(revision: string): boolean {
  return git(["cat-file", "-e", `${revision}^{commit}`]) !== null;
}

/** Run a body against the REAL driver module (spawned, so TypeScript never has to
 *  resolve a `.mjs` import) and return whatever it prints as JSON. */
function driverJson(body: string): any {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(DRIVER_URL)}); process.stdout.write(JSON.stringify(await (async () => { ${body} })()));`],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`the driver module probe failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

let scratch = "";
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "n5-pair-setup-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

describe("S5/N5 — the ONE baseline transformation is deterministic and fail-closed", () => {
  it("neutralises the array literal to the empty string and leaves every other byte alone", () => {
    const source = [
      "export const KEEP_ME = 1;",
      "export const TOOL_CALL_EFFICIENCY_GUIDANCE_V1 = [",
      '  "",',
      '  "Tool-call efficiency guidance:",',
      '  "- do the thing",',
      '].join("\\n");',
      "export const ALSO_KEEP = 2;",
      "",
    ].join("\n");
    const out = driverJson(`return { out: m.neutraliseGuidance(${JSON.stringify(source)}) };`) as { out: string };
    expect(out.out).toContain('export const TOOL_CALL_EFFICIENCY_GUIDANCE_V1 = "";');
    expect(out.out).toContain("export const KEEP_ME = 1;");
    expect(out.out).toContain("export const ALSO_KEEP = 2;");
    expect(out.out).not.toContain("do the thing");
  });

  it("REFUSES a source that does not carry exactly one anchor, naming R5_PAIR_TRANSFORM_FAILED", () => {
    const twice = [
      'export const TOOL_CALL_EFFICIENCY_GUIDANCE_V1 = [\n  "",\n].join("\\n");',
      'export const TOOL_CALL_EFFICIENCY_GUIDANCE_V1 = [\n  "",\n].join("\\n");',
      "",
    ].join("\n");
    for (const source of ["export const NOTHING = 1;\n", twice]) {
      const result = driverJson(`
        let error = null;
        try { m.neutraliseGuidance(${JSON.stringify(source)}); } catch (err) { error = err instanceof Error ? err.message : String(err); }
        return { error };
      `) as { error: string | null };
      expect(result.error, `a source the generator does not understand was accepted`).toContain("R5_PAIR_TRANSFORM_FAILED");
    }
  });
});

describe("S5/N5 — the generator reproduces a HAND-MADE baseline commit byte-for-byte", () => {
  const present = objectPresent(HISTORICAL_CANDIDATE) && objectPresent(HISTORICAL_BASELINE);

  it.skipIf(!present)("derives blob, tree and commit identical to 4f8d98ec from its historical recipe", () => {
    const raw = execFileSync("git", ["-C", REPO_ROOT, "cat-file", "commit", HISTORICAL_BASELINE], { encoding: "utf8" });
    const blank = raw.indexOf("\n\n");
    const headers = raw.slice(0, blank).split("\n");
    const message = raw.slice(blank + 2);
    const authorLine = headers.find((l) => l.startsWith("author "))!.slice("author ".length);
    const parsed = authorLine.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/)!;
    const result = driverJson(`
      return await m.deriveNeutralisedCommit(${JSON.stringify(REPO_ROOT)}, {
        candidateSha: ${JSON.stringify(HISTORICAL_CANDIDATE)},
        message: ${JSON.stringify(message)},
        authorName: ${JSON.stringify(parsed[1])},
        authorEmail: ${JSON.stringify(parsed[2])},
        epochSeconds: ${Number(parsed[3])},
        timezone: ${JSON.stringify(parsed[4])},
      });
    `) as { sha: string; tree: string; blob: string };

    expect(result.blob, "the neutralised blob is not the historical one").toBe(HISTORICAL_BLOB);
    expect(result.tree, "the derived tree is not the historical one").toBe(HISTORICAL_TREE);
    expect(result.sha, "the derived commit is not the historical commit").toBe(HISTORICAL_BASELINE);
    // ...and the pair's whole diff really is the one mechanism file.
    expect(git(["diff", "--name-only", HISTORICAL_CANDIDATE, result.sha])).toBe(MECHANISM_PATH);
    expect(git(["diff", "--numstat", HISTORICAL_CANDIDATE, result.sha])).toBe(`1\t20\t${MECHANISM_PATH}`);
    // The parent of the derived commit is the candidate, and the guidance module it
    // carries IS the neutralised one.
    expect(git(["rev-parse", `${result.sha}^`])).toBe(HISTORICAL_CANDIDATE);
    expect(git(["rev-parse", `${result.sha}:${MECHANISM_PATH}`])).toBe(HISTORICAL_BLOB);
  });

  it.skipIf(present)("SKIPS the byte-exact self-proof where the historical objects are absent (naming why)", () => {
    // Reaching here means this checkout is shallow (CI). The generator is still
    // exercised by the transform cases above and by --setup-pair below; what is
    // skipped is only the historical COMPARISON.
    expect(present, "the historical objects are absent, so the byte-exact comparison cannot run here").toBe(false);
  });
});

describe("S5/N5 — --setup-pair refuses anything that is not the pinned baseline", () => {
  it("refuses a baseline SHA that is not what the candidate derives to, naming BASELINE_PIN_MISMATCH", async () => {
    const path = join(scratch, "pin-mismatch.json");
    await writeFile(
      path,
      `${JSON.stringify({ schemaVersion: "e4-r5-formal-pair-v1", baseline: { sha: "0".repeat(40) }, candidate: { sha: HISTORICAL_CANDIDATE } }, null, 2)}\n`,
      "utf8",
    );
    const result = driverJson(`return await m.setupPair(${JSON.stringify(path)}, ${JSON.stringify(REPO_ROOT)});`) as { ok: boolean; code: string; detail: string };
    expect(result.ok, "a baseline the candidate does not derive to was accepted").toBe(false);
    expect(result.code).toBe("BASELINE_PIN_MISMATCH");
    expect(result.detail).toContain("r5-formal-pair.json");
  });

  it("refuses a pair whose candidate is not in this repository, naming CANDIDATE_ABSENT", async () => {
    const path = join(scratch, "candidate-absent.json");
    await writeFile(
      path,
      `${JSON.stringify({ schemaVersion: "e4-r5-formal-pair-v1", baseline: { sha: "0".repeat(40) }, candidate: { sha: "1".repeat(40) } }, null, 2)}\n`,
      "utf8",
    );
    const result = driverJson(`return await m.setupPair(${JSON.stringify(path)}, ${JSON.stringify(REPO_ROOT)});`) as { ok: boolean; code: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CANDIDATE_ABSENT");
  });

  it("refuses a config that is not a pair at all, naming PAIR_CONFIG_INVALID", async () => {
    const path = join(scratch, "not-a-pair.json");
    await writeFile(path, `${JSON.stringify({ schemaVersion: "e4-r5-formal-pair-v1" }, null, 2)}\n`, "utf8");
    const result = driverJson(`return await m.setupPair(${JSON.stringify(path)}, ${JSON.stringify(REPO_ROOT)});`) as { ok: boolean; code: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PAIR_CONFIG_INVALID");
  });

  it.skipIf(!objectPresent(HISTORICAL_CANDIDATE))("the --derive-baseline FLAG works, not just the function it calls", () => {
    // A CLI smoke test on purpose: the function and its flag once disagreed about
    // argument order, and every unit test above still passed because they call the
    // FUNCTION. This is the seam that actually gets used to pin a pair.
    const result = spawnSync(process.execPath, [GATE_SCRIPT, "--derive-baseline", HISTORICAL_CANDIDATE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    // The LAST 40-hex on stdout is the derived baseline: the header line echoes the
    // CANDIDATE, so taking the first match would assert against the wrong commit.
    const matches = result.stdout.match(/[0-9a-f]{40}/g) ?? [];
    const sha = matches[matches.length - 1];
    expect(sha, `the flag printed no commit sha: ${result.stdout}`).toBeTruthy();
    expect(git(["cat-file", "-t", String(sha)])).toBe("commit");
    expect(git(["rev-parse", `${String(sha)}^`])).toBe(HISTORICAL_CANDIDATE);
  });
});
