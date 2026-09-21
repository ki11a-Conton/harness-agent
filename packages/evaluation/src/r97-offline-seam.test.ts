/**
 * E4-R101-A (T6) — THE OFFLINE SEAM MUST SCRIPT EVERY FROZEN CASE.
 *
 * WHY THIS FILE EXISTS (plan §T6 做什么 2, 怎么做 3/5, 怎么验收 1)
 * ------------------------------------------------------------
 * MEASURED, by running the full offline acceptance command
 * (`node scripts/e4/r97-offline-acceptance.mjs --all`) against the two real arm
 * builds:
 *
 *   driver status: PARTIAL / CASE_FAILURES
 *   reason: "arm baseline case regression/reg-03-add-import failed:
 *            E4-R98: E4-R98: case regression/reg-03-add-import declares no
 *            artifact path, so a write script cannot be derived from it
 *            (10 of 16 unit(s) measured nothing; 20 logical call(s) consumed)"
 *
 * Ten of the sixteen units — five cases × two arms — reported NOTHING. The
 * offline loop therefore could not be accepted, and the failure was not a defect
 * in the campaign: it was a defect in the SEAM that drives it.
 *
 * TWO DISTINCT DEFECTS, and the plan names both:
 *
 *   1. `scriptForCase` THREW for a case that declares only a `kind:"command"`
 *      verifier. The frozen R87 selection is NOT a set of write-the-file cases:
 *      measured, FIVE of its eight cases carry ONLY a command verifier
 *      (`reg-03-add-import`, `reg-06-json-parse-test`, `reg-14-stack`,
 *      `reg-17-gcd`, `reg-24-error-handling`) and the other THREE carry ONLY an
 *      artifact verifier (`reg-16-cicd-step`, `stress-many-artifacts`,
 *      `stress-very-long-json`). A throw on the first group is a
 *      `infrastructure` failure, so the case never reached its own verifier —
 *      the exact "measured nothing" outcome plan §T3 forbids.
 *
 *   2. `writeTargetOf` returned `content: null` for an artifact-only case, and
 *      `content: null` is REFUSED by the `write_file` tool's own schema
 *      (`content: z.string()`). Measured with a probe against the baseline arm:
 *      the tool call fails (`toolFailures=2`), the runtime recovers, and the
 *      artifact verifier then reports PASS purely because the fixture file
 *      already existed and `mustChange` only requires the path to appear in
 *      `changedPaths` — a FALSE PASS produced by a write that never happened.
 *
 * WHAT THE FIX IS, AND WHAT IT IS NOT
 * -----------------------------------
 * The seam supplies the MODEL'S OUTPUT for an offline run. It is a scripted
 * provider, not a solver, so it must be honest about which cases it can drive:
 *
 *   - a case whose own `kind:"command"` verifier embeds the expected literal
 *     (`!== '<content>'`, as both R98 fixtures do) is scripted from THAT literal
 *     — a STRONG pass, because the case's own command checks the bytes;
 *   - a case that declares an artifact but no recoverable literal is scripted
 *     with an explicitly labelled offline-acceptance banner. It produces a REAL
 *     write of REAL non-null content, so the tool call succeeds and the artifact
 *     verifier's positive result is genuine — but the content is NOT a solution,
 *     and the campaign summary must say so. These passes are WEAK: measured, the
 *     frozen artifact verifiers only require the path to exist and to have been
 *     touched;
 *   - a case that declares NO artifact at all (the five command-only cases) is
 *     scripted as the "claimed completion, wrote nothing" negative control, so it
 *     reaches its OWN verifier and is classified from the REAL report. Measured,
 *     all five of those commands genuinely fail against the as-staged fixtures,
 *     so each becomes an honest `case_failed` — a VALID NEGATIVE the driver
 *     deliberately excludes from `failures[]`.
 *
 * NOTHING here weakens a verifier and nothing invents an answer key: the literal
 * path reads the case's own contract, and the banner path is labelled as a banner
 * in the case's own artifact.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const EXEC = pathToFileURL(join(REPO, "scripts", "e4", "r97-arm-exec.mjs")).href;

interface WriteTarget {
  path: string;
  content: string | null;
  contentSource?: string;
}

interface CaseDef {
  caseId: string;
  requestMd: string;
  expectedMd: string;
  verification: unknown[];
  writeTarget: WriteTarget | null;
  passStrength: "strong" | "weak" | null;
}

const exec = (await import(EXEC)) as {
  writeTargetOf: (parsed: unknown, ctx?: { caseId?: string; requestMd?: string }) => WriteTarget | null;
  scriptForCase: (def: CaseDef, shape: string) => Array<[string, unknown]>;
  readCaseDef: (dir: string, caseId: string) => Promise<CaseDef>;
  withArmExecTag: (message: string) => string;
  passStrengthOf: (target: WriteTarget | null) => "strong" | "weak" | null;
};

/** Read one case's own `case.json` from the MAIN repo, the same bytes the
 *  frozen selection fingerprints. */
async function caseJson(rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(REPO, "benchmarks", rel, "case.json"), "utf8")) as Record<string, unknown>;
}

/** The FIVE frozen cases that declare ONLY a command verifier. Measured by
 *  sweeping every `case.json` under the frozen selection. */
const COMMAND_ONLY = [
  "regression/reg-03-add-import",
  "regression/reg-06-json-parse-test",
  "regression/reg-14-stack",
  "regression/reg-17-gcd",
  "regression/reg-24-error-handling",
];

/** The THREE frozen cases that declare ONLY an artifact verifier. */
const ARTIFACT_ONLY = [
  "regression/reg-16-cicd-step",
  "stress/stress-many-artifacts",
  "stress/stress-very-long-json",
];

describe("E4-R101-A (T6) C6: an explicit arm pair is USED, never re-prepared", () => {
  it("does not run --prepare when the caller supplied BOTH arm directories", async () => {
    // MEASURED DEFECT (found while wiring the closed loop, not by a test): the
    // closed loop calls this runner with `--all --baseline-dir <arm> --candidate-dir
    // <arm>`. `--all` turns on `--prepare`, and `stepPrepare` ignored the explicit
    // directories — it ran `r97-observe-arms.mjs --root <tmp>` and built a WHOLE
    // SECOND pair of arm worktrees (two `pnpm install` + `pnpm build`) into a
    // throwaway temp directory that no later step read. The campaign then ran
    // against the caller's arms while the summary recorded the temp root as the
    // arms used, so the artifact described a different pair than the one measured.
    //
    // The rule: if the caller says WHICH arms to use, honour that and do not build
    // another pair. `--prepare` remains the way to ASK for arms to be built.
    const { parseArgs } = await import(pathToFileURL(join(REPO, "scripts", "e4", "r97-offline-acceptance.mjs")).href) as {
      parseArgs: (argv: string[]) => { prepare: boolean };
    };
    const all = parseArgs(["--all"]);
    expect(all.prepare, "--all alone must still prepare: it is how CI gets arms").toBe(true);

    const withDirs = parseArgs(["--all", "--baseline-dir", "D:/b", "--candidate-dir", "D:/c"]);
    expect(
      withDirs.prepare,
      "an explicit arm pair must SUPPRESS the redundant build, not be silently ignored",
    ).toBe(false);

    // ...but asking for BOTH explicitly still prepares, because that is a request
    // rather than an inference.
    const explicit = parseArgs(["--prepare", "--baseline-dir", "D:/b", "--candidate-dir", "D:/c"]);
    expect(explicit.prepare, "an explicit --prepare is always honoured").toBe(true);
  });

  it("records the arm directories it MEASURED, and null for a root it did not create", async () => {
    // The summary is evidence, so it must name the arms the campaign actually ran
    // against. Before the fix it printed the throwaway temp root while the campaign
    // used the caller's pair — an artifact describing a different pair than the one
    // measured. `armsRoot: null` says "this run built no arms" rather than naming a
    // directory nothing read.
    const runner = await readFile(join(REPO, "scripts", "e4", "r97-offline-acceptance.mjs"), "utf8");
    expect(runner, "the summary must record the measured baseline dir").toContain("baselineDir: opts.baselineDir");
    expect(runner, "the summary must record the measured candidate dir").toContain("candidateDir: opts.candidateDir");
    expect(
      runner,
      "an unbuilt arms root must be reported as null, not as a path nothing measured",
    ).toContain("armsRoot: opts.armsBuilt ? opts.armsRoot : null");
  });
});

describe("E4-R101-A (T6) C1: the seam reads the case's OWN contract", () => {
  it("recovers the literal from a case whose command verifier embeds it", async () => {
    // The R98 fixture states its expectation in its own verifier, so the script
    // and the verifier are bound to one source of truth.
    const target = exec.writeTargetOf(await caseJson("r98-fixtures/r98-tool-write-request"), {
      caseId: "r98-tool-write-request",
    });
    expect(target).not.toBeNull();
    expect(target?.path).toBe("out/r98-request.txt");
    expect(target?.content).toBe("r98-request-first-write");
    expect(target?.contentSource).toBe("command-literal");
  });

  it("returns NO write target for a case that declares only a command verifier", async () => {
    // The agent's job here is to EDIT the fixture, which no rule can derive from
    // the case files. Reporting `null` is the honest answer; THROWING is not,
    // because a throw is an infrastructure failure that measures nothing.
    for (const rel of COMMAND_ONLY) {
      expect(exec.writeTargetOf(await caseJson(rel), { caseId: rel }), rel).toBeNull();
    }
  });
});

describe("E4-R101-A (T6) C2: scripting NEVER throws a case into infrastructure", () => {
  it("scripts a command-only case as the claim-only negative control", async () => {
    const def = await exec.readCaseDef(join(REPO, "benchmarks", "regression", "reg-03-add-import"), "regression/reg-03-add-import");
    expect(def.writeTarget).toBeNull();
    const script = exec.scriptForCase(def, "write-then-stop");
    // The measured defect: this call THREW, and the worker's catch-all turned the
    // throw into `infrastructure`, so the case never reached its own verifier.
    expect(script.length).toBeGreaterThan(0);
    expect(script[0]?.[0]).toBe("text");
    expect(script.some(([kind]) => kind === "tool")).toBe(false);
    // The claim must NAME ITS OWN CASE (plan §T6 怎么做 7's "固定 request=r97"
    // mutation). MEASURED: this assertion was missing, so replacing every claim
    // with the literal `"r97"` left the test GREEN — the mutation gate caught the
    // gap. A fixed text for every case is exactly the defect R99 exists to remove:
    // it makes two different cases enter the SAME context.
    const text = String(script[0]?.[1] ?? "");
    expect(text).toContain(def.caseId);
    expect(text, "a fixed `r97` placeholder is the defect this seam replaced").not.toBe("r97");
  });

  it("gives DIFFERENT cases DIFFERENT claim text — never one fixed placeholder", async () => {
    // The stronger, cross-case form. Two command-only cases must not send the same
    // text, because the whole point of the R99 seam is that each case's own
    // request reaches its own context.
    const texts: string[] = [];
    for (const rel of COMMAND_ONLY) {
      const def = await exec.readCaseDef(join(REPO, "benchmarks", rel), rel);
      const script = exec.scriptForCase(def, "write-then-stop");
      texts.push(String(script[0]?.[1] ?? ""));
    }
    expect(texts.length).toBeGreaterThan(1);
    expect(new Set(texts).size, `every claim text was identical: ${texts[0]}`).toBe(texts.length);
    for (const [i, rel] of COMMAND_ONLY.entries()) {
      expect(texts[i], `${rel}'s claim must name its own case`).toContain(rel);
    }
  });

  it("scripts EVERY frozen command-only case without throwing", async () => {
    for (const rel of COMMAND_ONLY) {
      const bare = rel.split("/").pop() ?? rel;
      const def = await exec.readCaseDef(join(REPO, "benchmarks", rel), rel);
      expect(def.caseId, rel).toBe(rel);
      let script: Array<[string, unknown]> = [];
      expect(() => {
        script = exec.scriptForCase(def, "write-then-stop");
      }, `${rel} must be scriptable`).not.toThrow();
      expect(script[0]?.[0], rel).toBe("text");
      expect(bare.length, rel).toBeGreaterThan(0);
    }
  });
});

describe("E4-R101-A (T6) C3: an artifact-only case gets a REAL non-null write", () => {
  it("derives a labelled banner for a case with an artifact but no literal", async () => {
    // MEASURED: `content: null` is refused by `write_file`'s own zod schema, so
    // the tool call FAILED and the artifact verifier's pass was a false pass.
    for (const rel of ARTIFACT_ONLY) {
      const target = exec.writeTargetOf(await caseJson(rel), { caseId: rel });
      expect(target, rel).not.toBeNull();
      expect(typeof target?.content, rel).toBe("string");
      expect(target?.content?.length ?? 0, rel).toBeGreaterThan(0);
      expect(target?.contentSource, rel).toBe("offline-banner");
      // The banner must NAME itself, so a reader of the artifact cannot mistake
      // it for a solution the model produced.
      expect(target?.content, rel).toContain("offline-acceptance");
    }
  });

  it("puts the write FIRST, so the tool call really happens", async () => {
    const def = await exec.readCaseDef(join(REPO, "benchmarks", "stress", "stress-very-long-json"), "stress/stress-very-long-json");
    expect(def.writeTarget?.path).toBe("out/name.txt");
    const script = exec.scriptForCase(def, "write-then-stop");
    expect(script[0]?.[0]).toBe("tool");
    const payload = script[0]?.[1] as { path?: string; content?: unknown };
    expect(payload.path).toBe("out/name.txt");
    expect(typeof payload.content).toBe("string");
  });

  it("still scripts the `text-only` shape as a write-free negative control", async () => {
    const def = await exec.readCaseDef(join(REPO, "benchmarks", "stress", "stress-very-long-json"), "stress/stress-very-long-json");
    const script = exec.scriptForCase(def, "text-only");
    expect(script.some(([kind]) => kind === "tool")).toBe(false);
  });
});

describe("E4-R101-A (T6) C5: a pass is labelled STRONG or WEAK, never just 'passed'", () => {
  /**
   * WHY THIS EXISTS (plan §T6 怎么做 5, 怎么验收 5)
   * ---------------------------------------------
   * The acceptance run produces six passing units out of sixteen, and the six are
   * NOT all the same kind of pass:
   *
   *   - the two R98 fixture cases pass because their OWN command verifier embeds
   *     the exact literal the seam writes (`!== '<content>'`), so the case's own
   *     command checked the bytes. That is a STRONG pass.
   *   - the three artifact-only frozen cases pass because the seam wrote a banner
   *     and `TaskVerifier`'s artifact rule only requires the path to exist and to
   *     have been touched. Nothing checks the CONTENT, so the pass is WEAK.
   *
   * A summary that reports one `verifiedPasses` number hides that distinction,
   * and plan §T6 怎么做 8 requires the report to keep "已有 keyless MODEL_ERROR
   * 冒烟" distinct from a real tool-chain acceptance. The same honesty applies one
   * level down: a weak pass must not be presented as evidence that a case was
   * solved.
   */
  it("labels a literal-derived pass as strong", async () => {
    const target = exec.writeTargetOf(await caseJson("r98-fixtures/r98-tool-write-request"), {
      caseId: "r98-tool-write-request",
    });
    expect(exec.passStrengthOf(target)).toBe("strong");
  });

  it("labels a banner-derived pass as weak", async () => {
    for (const rel of ARTIFACT_ONLY) {
      const target = exec.writeTargetOf(await caseJson(rel), { caseId: rel });
      expect(exec.passStrengthOf(target), rel).toBe("weak");
    }
  });

  it("labels a case the seam could not write for at all as no pass at all", async () => {
    // A command-only case gets no write target, so any verdict it reaches comes
    // from its own verifier over an unmodified fixture — it can never be a pass
    // this seam produced, strong or weak.
    for (const rel of COMMAND_ONLY) {
      expect(exec.passStrengthOf(exec.writeTargetOf(await caseJson(rel), { caseId: rel })), rel).toBeNull();
    }
  });

  it("carries the strength through to the executed result, not just the target", async () => {
    // The worker records what it executed, so the strength must travel with the
    // run rather than being re-derived later from a case file that may have moved.
    const def = await exec.readCaseDef(join(REPO, "benchmarks", "r98-fixtures", "r98-tool-write-request"), "r98-tool-write-request");
    expect(def.passStrength).toBe("strong");
    const weak = await exec.readCaseDef(join(REPO, "benchmarks", "stress", "stress-very-long-json"), "stress/stress-very-long-json");
    expect(weak.passStrength).toBe("weak");
    const none = await exec.readCaseDef(join(REPO, "benchmarks", "regression", "reg-03-add-import"), "regression/reg-03-add-import");
    expect(none.passStrength).toBeNull();
  });
});

describe("E4-R101-A (T6) C4: a detail carries the executor tag exactly once", () => {
  it("adds the tag when it is absent and collapses it when repeated", () => {
    // MEASURED: the driver's reason line read
    //   "E4-R98: E4-R98: case … declares no artifact path"
    // because the worker's catch-all prefixes a message that already carries the
    // tag. A doubled tag is cosmetic, but it is also the signature of a
    // pass-through that nobody read.
    expect(exec.withArmExecTag("boom")).toBe("E4-R98: boom");
    expect(exec.withArmExecTag("E4-R98: boom")).toBe("E4-R98: boom");
    expect(exec.withArmExecTag("E4-R98: E4-R98: boom")).toBe("E4-R98: boom");
  });
});
