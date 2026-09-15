/**
 * E4-R77 — offline oracle calibration for the frozen 8-case baseline.
 *
 * PURPOSE (plan §6.3/§6.4): establish, per case, what the REAL verifier actually
 * proves — not what the case NAME suggests. For each regression case we run the
 * ORIGINAL (broken) fixture and a MINIMAL CORRECT implementation through the REAL
 * `loadBenchmarkCases` loader + the REAL `TaskVerifier`, and additionally run a
 * "weak/cheating" implementation that SHOULD fail. A case whose verifier accepts
 * the cheat does not measure the ability its label claims.
 *
 * All oracle work happens in TEMPORARY COPIES. Correct/cheating solutions are
 * never written into the benchmarked fixture directories.
 *
 * FINDINGS RECORDED HERE (see docs/E4-R77-report.md):
 *  - V1: `TaskVerifier.checkCommand` shell-quotes args with POSIX single quotes,
 *    but on win32 the ProcessExecutor runs them through `cmd.exe`. The quoted
 *    command is mangled, so EVERY `kind: "command"` case fails on Windows
 *    regardless of the implementation. The oracle tests therefore assert BOTH
 *    (a) the defect is present and (b) the case's SEMANTIC oracle is sound once
 *    the quoting defect is bypassed (documented as a separate, un-fixed defect).
 *  - V2: the `artifact` verifier checks existence + changedPaths, NEVER content,
 *    so an EMPTY file satisfies `mustChange`.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadBenchmarkCases } from "@ar/evaluation";
import { ProcessExecutor, TaskVerifier } from "@ar/tools";

const FROZEN_DIR = resolve(process.cwd(), "benchmarks", "baseline-e4-r74");

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e4-r77-oracle-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

const writeInto = (rel: string, content: string) => async (root: string) => {
  const abs = join(root, ...rel.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
};

/** Materialize a frozen case's fixture into a throwaway workspace. */
async function materialize(caseId: string, mutate?: (root: string) => Promise<void>): Promise<string> {
  const root = await tempDir();
  await cp(join(FROZEN_DIR, caseId, "fixture"), root, { recursive: true });
  if (mutate !== undefined) await mutate(root);
  return root;
}

async function specsFor(caseId: string) {
  const cases = await loadBenchmarkCases(FROZEN_DIR);
  const caseDef = cases.find((c) => c.id === caseId);
  if (caseDef === undefined) throw new Error(`no such frozen case: ${caseId}`);
  return caseDef.verification ?? [];
}

/** Run the case's REAL verification specs through the REAL TaskVerifier. */
async function runVerifier(caseId: string, root: string): Promise<{ passed: boolean; messages: string[] }> {
  const specs = (await specsFor(caseId)).map((spec) => {
    if (spec.kind !== "artifact") return spec;
    return { ...spec, path: isAbsolute(spec.path) ? spec.path : join(root, spec.path) };
  });
  const verifier = new TaskVerifier();
  const result = await verifier.verify(
    { verification: specs } as unknown as Parameters<TaskVerifier["verify"]>[0],
    { cwd: root, sessionId: "e4-r77", changedPaths: [] } as unknown as Parameters<TaskVerifier["verify"]>[1],
  );
  return {
    passed: result.passed,
    messages: result.checks.map((c) => `${c.kind}:${c.passed ? "pass" : "FAIL"} ${c.error?.message ?? ""}`.trim()),
  };
}

/** Evaluate the SEMANTIC oracle of a command spec by running its argv DIRECTLY,
 *  bypassing the verifier's platform-mismatched shell quoting. This is what the
 *  verifier would decide on a POSIX host, and what it should decide here. */
async function runCommandSpecDirectly(caseId: string, root: string): Promise<{ passed: boolean; detail: string }> {
  const specs = (await specsFor(caseId)).filter((s) => s.kind === "command");
  const executor = new ProcessExecutor();
  for (const spec of specs) {
    if (spec.kind !== "command") continue;
    // Quote every arg cmd.exe-natively (double quotes), unlike the verifier's
    // POSIX single-quote escaping. The runtime's own exec path does the same.
    const argv = (spec.args ?? []).map((a) => `"${a.replace(/"/g, '\\"')}"`);
    const command = [spec.command, ...argv].join(" ");
    const out = await executor.run({ command, cwd: root, timeoutMs: 120_000, maxOutputBytes: 1_048_576 });
    if (out.status !== "success") {
      return { passed: false, detail: `direct run exit=${out.exitCode} stderr=${out.stderr.slice(0, 200)}` };
    }
  }
  return { passed: true, detail: "direct run exit=0" };
}

describe("E4-R77: the 8 frozen cases load through the REAL loader", () => {
  it("loads exactly the 8 frozen case ids", async () => {
    const cases = await loadBenchmarkCases(FROZEN_DIR);
    expect(cases.map((c) => c.id).sort()).toEqual([
      "adv-path-confusion",
      "adv-tool-output-injection",
      "reg-02-fix-reverse",
      "reg-06-json-parse-test",
      "reg-12-csv-parse",
      "reg-24-error-handling",
      "reg-30-sort-order",
      "stress-10-subagents",
    ]);
  });
});

describe("E4-R77 (V1): command verification is BROKEN on win32 (POSIX quoting into cmd.exe)", () => {
  it("V1 REPRO: a CORRECT implementation still FAILS the real command verifier on win32", async () => {
    const root = await materialize(
      "reg-02-fix-reverse",
      writeInto("src/strings.js", "export function reverse(s) { return [...s].reverse().join(''); }\n"),
    );
    const r = await runVerifier("reg-02-fix-reverse", root);
    // The defect: a semantically correct fix is judged FAILED on Windows because
    // the POSIX single-quoting is mangled by cmd.exe.
    expect(r.passed).toBe(false);
    expect(r.messages.join(" ")).toContain("command");
  });

  it("V1: the SAME correct implementation PASSES when the spec argv is run directly (no bad quoting)", async () => {
    const root = await materialize(
      "reg-02-fix-reverse",
      writeInto("src/strings.js", "export function reverse(s) { return [...s].reverse().join(''); }\n"),
    );
    const direct = await runCommandSpecDirectly("reg-02-fix-reverse", root);
    expect(direct.passed).toBe(true);
  });

  it("V1: the BROKEN fixture fails under direct execution too (so the oracle still discriminates)", async () => {
    const root = await materialize("reg-02-fix-reverse");
    const direct = await runCommandSpecDirectly("reg-02-fix-reverse", root);
    expect(direct.passed).toBe(false);
  });
});

describe("E4-R77: regression oracles discriminate (evaluated by direct argv execution)", () => {
  const cases: Array<[string, string, string]> = [
    [
      "reg-02-fix-reverse",
      "src/strings.js",
      "export function reverse(s) { return [...s].reverse().join(''); }\n",
    ],
    [
      "reg-12-csv-parse",
      "src/csv.js",
      "export function parse_csv(line) { return line.split(',').map((f) => f.trim()); }\n",
    ],
    [
      "reg-30-sort-order",
      "src/users.js",
      "export function sortUsers(users) { return [...users].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }\n",
    ],
    [
      "reg-06-json-parse-test",
      "test/parse.test.js",
      "import test from 'node:test';\nimport assert from 'node:assert';\ntest('round-trips', () => { assert.deepStrictEqual(JSON.parse('{\"a\":1}'), { a: 1 }); });\n",
    ],
  ];

  it.each(cases)("%s: ORIGINAL fixture fails the oracle", async (caseId) => {
    const root = await materialize(caseId);
    const direct = await runCommandSpecDirectly(caseId, root);
    expect(direct.passed).toBe(false);
  });

  it.each(cases.filter(([id]) => id !== "reg-06-json-parse-test"))(
    "%s: minimal CORRECT implementation passes the oracle",
    async (caseId, file, impl) => {
      const root = await materialize(caseId, writeInto(file, impl));
      const direct = await runCommandSpecDirectly(caseId, root);
      expect(direct.passed).toBe(true);
    },
  );

  it("V3 history: the OLD reg-06 spec `node --test test/` is NOT runnable (trailing-slash dir arg)", async () => {
    // The R74 spec passed the directory WITH a trailing slash; Node treats the
    // positional as a module path, so even a correct test fails with
    // MODULE_NOT_FOUND — a failure unrelated to the agent's work. This is what
    // forced the R77 revision (below).
    const root = await materialize(
      "reg-06-json-parse-test",
      writeInto(
        "test/parse.test.js",
        "import test from 'node:test';\nimport assert from 'node:assert';\ntest('round-trips', () => { assert.deepStrictEqual(JSON.parse('{\"a\":1}'), { a: 1 }); });\n",
      ),
    );
    const executor = new ProcessExecutor();
    const out = await executor.run({ command: "node --test test/", cwd: root, timeoutMs: 120_000, maxOutputBytes: 1_048_576 });
    expect(out.status).not.toBe("success");
    expect(out.stdout + out.stderr).toContain("Cannot find module");
  });

  it("V3 FIXED (R77 revision): the revised spec `node --test test/parse.test.js` passes the correct test", async () => {
    const root = await materialize(
      "reg-06-json-parse-test",
      writeInto(
        "test/parse.test.js",
        "import test from 'node:test';\nimport assert from 'node:assert';\ntest('round-trips', () => { assert.deepStrictEqual(JSON.parse('{\"a\":1}'), { a: 1 }); });\n",
      ),
    );
    const direct = await runCommandSpecDirectly("reg-06-json-parse-test", root);
    expect(direct.passed).toBe(true);
  });

  it("V3 (R77 revision): the revised spec still fails without any test file", async () => {
    const root = await materialize("reg-06-json-parse-test");
    const direct = await runCommandSpecDirectly("reg-06-json-parse-test", root);
    expect(direct.passed).toBe(false);
  });
});

describe("E4-R77 (F3): reg-24's frozen oracle cannot distinguish 'handled' from 'always null'", () => {
  const correct = `import { readFileSync } from 'node:fs';
export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
`;

  it("reg-24: the ORIGINAL fixture (throws) fails the oracle", async () => {
    const root = await materialize("reg-24-error-handling");
    const direct = await runCommandSpecDirectly("reg-24-error-handling", root);
    expect(direct.passed).toBe(false);
  });

  it("reg-24: a request-faithful try/catch implementation passes the oracle", async () => {
    const root = await materialize("reg-24-error-handling", writeInto("src/io.js", correct));
    const direct = await runCommandSpecDirectly("reg-24-error-handling", root);
    expect(direct.passed).toBe(true);
  });

  it("F3 FIXED (R77 revision): the strengthened frozen spec REJECTS `always return null`", async () => {
    const root = await materialize(
      "reg-24-error-handling",
      writeInto("src/io.js", "export function readJson(path) { return null; }\n"),
    );
    const direct = await runCommandSpecDirectly("reg-24-error-handling", root);
    // The R74 frozen spec accepted this cheat (single-point assertion on the
    // bad-JSON path only). The R77 revision adds the valid-JSON half that
    // expected.md always demanded, so a degenerate always-null implementation
    // now fails through the REAL spec, not a parallel re-implementation.
    expect(direct.passed).toBe(false);
  });

  it("F3 (R77 revision): the strengthened frozen spec still passes a request-faithful implementation", async () => {
    const root = await materialize("reg-24-error-handling", writeInto("src/io.js", correct));
    const direct = await runCommandSpecDirectly("reg-24-error-handling", root);
    expect(direct.passed).toBe(true);
  });

  it("F3 history: the OLD weak spec (temp copy) is what allowed `always return null`", async () => {
    // Evidence for the revision record: the R74 spec (bad.json null check only)
    // passes the cheat. Kept here so the revision's motivation is testable.
    const root = await materialize("reg-24-error-handling");
    await writeFile(join(root, "src", "io.js"), "export function readJson(path) { return null; }\n", "utf8");
    const executor = new ProcessExecutor();
    const out = await executor.run({
      command: 'node -e "import(\'./src/io.js\').then(m => { if (m.readJson(\'data/bad.json\') !== null) process.exit(1) })"'.replace(/\\'/g, "'"),
      cwd: root,
      timeoutMs: 120_000,
      maxOutputBytes: 1_048_576,
    });
    expect(out.status).toBe("success");
  });

  it("F3: expected.md ALREADY demands the valid-JSON behavior the frozen spec never checked", async () => {
    const expected = await readFile(join(FROZEN_DIR, "reg-24-error-handling", "expected.md"), "utf8");
    expect(expected).toContain("valid JSON returns the object");
    // The R77 revision now enforces that half; data/good.json is the witness.
    const good = await readFile(join(FROZEN_DIR, "reg-24-error-handling", "fixture", "data", "good.json"), "utf8");
    expect(JSON.parse(good)).toEqual({ a: 1 });
  });
});

describe("E4-R77 (V2): the artifact verifier accepts an EMPTY file", () => {
  it("V2 REPRO: mustChange passes on a zero-byte file", async () => {
    const root = await tempDir();
    await mkdir(join(root, "out"), { recursive: true });
    await writeFile(join(root, "out", "parts.md"), "", "utf8");
    const verifier = new TaskVerifier();
    const res = await verifier.verify(
      {
        verification: [{ kind: "artifact", path: "out/parts.md", mustChange: true }],
      } as unknown as Parameters<TaskVerifier["verify"]>[0],
      {
        cwd: root,
        sessionId: "e4-r77",
        changedPaths: [join(root, "out", "parts.md")],
      } as unknown as Parameters<TaskVerifier["verify"]>[1],
    );
    expect(res.passed).toBe(true);
  });

  it("V2: an artifact that is NOT in changedPaths still fails (the check is not vacuous)", async () => {
    const root = await tempDir();
    await mkdir(join(root, "out"), { recursive: true });
    await writeFile(join(root, "out", "parts.md"), "content", "utf8");
    const verifier = new TaskVerifier();
    const res = await verifier.verify(
      {
        verification: [{ kind: "artifact", path: "out/parts.md", mustChange: true }],
      } as unknown as Parameters<TaskVerifier["verify"]>[0],
      { cwd: root, sessionId: "e4-r77", changedPaths: [] } as unknown as Parameters<TaskVerifier["verify"]>[1],
    );
    expect(res.passed).toBe(false);
  });
});

describe("E4-R77: stress-10-subagents oracle surface", () => {
  it("requires the delegation mechanisms and a subagent.started floor", async () => {
    const cases = await loadBenchmarkCases(FROZEN_DIR);
    const c = cases.find((x) => x.id === "stress-10-subagents")!;
    expect(c.requires).toEqual(["subagent", "scheduler"]);
    expect(c.expectedEvents?.atLeast?.["subagent.started"]).toBe(10);
    expect(c.maxDurationMs).toBe(180_000);
  });

  it("the artifact half alone is satisfied by an EMPTY out/parts.md (V2 applies here too)", async () => {
    const root = await materialize("stress-10-subagents");
    await mkdir(join(root, "out"), { recursive: true });
    await writeFile(join(root, "out", "parts.md"), "", "utf8");
    const verifier = new TaskVerifier();
    const res = await verifier.verify(
      {
        verification: [{ kind: "artifact", path: "out/parts.md", mustChange: true }],
      } as unknown as Parameters<TaskVerifier["verify"]>[0],
      {
        cwd: root,
        sessionId: "e4-r77",
        changedPaths: [join(root, "out", "parts.md")],
      } as unknown as Parameters<TaskVerifier["verify"]>[1],
    );
    // Recorded honestly: the artifact check does NOT verify the 10 topics or any
    // content. This is why the R77 revision adds a content check — the empty
    // file must FAIL the FULL verification now.
    expect(res.passed).toBe(true);
  });

  it("V2 FIXED (R77 revision): the full verification REJECTS an empty out/parts.md", async () => {
    // The revised frozen spec adds a command check requiring >= 10 non-empty
    // lines, so "wrote a file" is no longer enough. Direct-argv evaluation
    // bypasses the win32 command-quoting defect (V1) to check the CONTENT rule.
    const root = await materialize("stress-10-subagents");
    await mkdir(join(root, "out"), { recursive: true });
    await writeFile(join(root, "out", "parts.md"), "", "utf8");
    const direct = await runCommandSpecDirectly("stress-10-subagents", root);
    expect(direct.passed).toBe(false);
  });

  it("V2 (R77 revision): a 10-line merge file passes the content check", async () => {
    const root = await materialize("stress-10-subagents");
    await mkdir(join(root, "out"), { recursive: true });
    const lines = Array.from({ length: 10 }, (_, i) => `part ${i + 1}: result`).join("\n");
    await writeFile(join(root, "out", "parts.md"), lines + "\n", "utf8");
    const direct = await runCommandSpecDirectly("stress-10-subagents", root);
    expect(direct.passed).toBe(true);
  });
});
