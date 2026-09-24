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
 *  - V1: `TaskVerifier.checkCommand` shell-quoted args with POSIX single quotes,
 *    but on win32 the ProcessExecutor ran them through `cmd.exe`. The quoted
 *    command was mangled, so EVERY `kind: "command"` case failed on Windows
 *    regardless of the implementation. **FIXED in E4-R79** (structured
 *    `command + args` now spawns directly with `shell: false`); the tests below
 *    assert the FIXED cross-platform contract, not the historical defect. See
 *    docs/E4-R79-report.md.
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

/** Run the case's REAL verification specs through the REAL TaskVerifier.
 *
 *  `changedPaths` is supplied exactly as a real run would: the benchmark driver
 *  reports the files the agent touched, so an `artifact` + `mustChange` spec can
 *  be satisfied. The oracle is about the COMMAND/content rules, so every path
 *  the case references is reported as changed — otherwise an artifact spec would
 *  fail for a reason unrelated to what the oracle is measuring. */
async function runVerifier(caseId: string, root: string): Promise<{ passed: boolean; messages: string[] }> {
  const raw = await specsFor(caseId);
  const changedPaths: string[] = [];
  const specs = raw.map((spec) => {
    if (spec.kind !== "artifact") return spec;
    const abs = isAbsolute(spec.path) ? spec.path : join(root, spec.path);
    changedPaths.push(abs);
    return { ...spec, path: abs };
  });
  const verifier = new TaskVerifier();
  const result = await verifier.verify(
    { verification: specs } as unknown as Parameters<TaskVerifier["verify"]>[0],
    { cwd: root, sessionId: "e4-r77", changedPaths } as unknown as Parameters<TaskVerifier["verify"]>[1],
  );
  return {
    passed: result.passed,
    messages: result.checks.map((c) => `${c.kind}:${c.passed ? "pass" : "FAIL"} ${c.error?.message ?? ""}`.trim()),
  };
}

/** Run ONLY the case's command specs through the REAL TaskVerifier contract.
 *  Used where the question is purely "does the command/content rule hold". */
async function runCommandSpecDirectly(caseId: string, root: string): Promise<{ passed: boolean; detail: string }> {
  const r = await runVerifier(caseId, root);
  return { passed: r.passed, detail: r.messages.join(" | ") };
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

describe("E4-R79 (was R77 V1): structured command verification is platform-consistent", () => {
  const CORRECT = "export function reverse(s) { return [...s].reverse().join(''); }\n";

  it("V1 FIXED: a CORRECT implementation PASSES the real command verifier on every platform", async () => {
    // Before E4-R79 this assertion was `toBe(false)` and the suite was therefore
    // platform-dependent: `shellQuote` emitted POSIX single quotes while win32
    // ran the string through cmd.exe, so Windows failed a correct fix and Ubuntu
    // passed it. The defect is fixed in the verifier (argv path, shell:false),
    // so BOTH platforms must now agree that a correct fix passes.
    const root = await materialize("reg-02-fix-reverse", writeInto("src/strings.js", CORRECT));
    const r = await runVerifier("reg-02-fix-reverse", root);
    expect(r.messages.join(" ")).toContain("command");
    expect(r.passed).toBe(true);
  });

  it("V1: the ORIGINAL broken fixture still FAILS the real command verifier", async () => {
    const root = await materialize("reg-02-fix-reverse");
    const r = await runVerifier("reg-02-fix-reverse", root);
    expect(r.passed).toBe(false);
  });

  it("V1 regression: an argv metacharacter cannot execute a second command", async () => {
    // The old shell-string assembly let `&`/`;` inside an argument start a
    // second command. The argv path spawns without a shell, so `cmd /c`-style
    // injection is structurally impossible; this pins that property through the
    // REAL verifier rather than through a bespoke helper.
    const root = await materialize("reg-02-fix-reverse", writeInto("src/strings.js", CORRECT));
    const verifier = new TaskVerifier();
    const res = await verifier.verify(
      {
        verification: [
          {
            kind: "command",
            command: process.execPath,
            args: ["-e", "process.exit(0)", "&", "echo", "INJECTED", ";", "exit", "9"],
          },
        ],
      } as unknown as Parameters<TaskVerifier["verify"]>[0],
      { cwd: root, sessionId: "e4-r79", changedPaths: [] } as unknown as Parameters<TaskVerifier["verify"]>[1],
    );
    // exit 0 from the node program: the trailing tokens were argv, not commands.
    expect(res.passed).toBe(true);
    expect(res.checks[0]?.evidence?.description).toContain("exit code 0");
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
