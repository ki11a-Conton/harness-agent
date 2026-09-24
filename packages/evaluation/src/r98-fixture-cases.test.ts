/**
 * E4-R98 — offline conformance for the two `r98-tool-write-*` fixture cases.
 *
 * PURPOSE (plan §R99 怎么验收): the two write cases exist to prove that a run
 * actually EXECUTES (a real tool touches a real file) and that each case enters
 * its OWN context. A run that only prints a completion message must fail, and a
 * run that reuses the other case's context (or one fixed placeholder prompt)
 * must be caught.
 *
 * This test is the OFFLINE half of that claim: it loads both cases through the
 * REAL `loadBenchmarkCase` and asserts the fixtures are well-formed and
 * DISCRIMINATING — different requests, different verification targets, and a
 * target file that does NOT already exist in the initial fixture state (so the
 * verification cannot pass vacuously). No provider call, no network, no
 * absolute Windows path, no dependency on the developer's machine.
 *
 * WHY THESE LIVE OUTSIDE benchmarks/regression/: the regression suite is a
 * frozen, counted artifact — `apps/cli/src/audit.benchmark-profile.test.ts`
 * asserts `caseCount: 30` against the REAL tree and `benchmarks/README.md`
 * states "全部 30 个回归用例", which `docs:verify` compares against. Adding two
 * cases there silently broke both. The loader takes a case's `suite` from its
 * own `case.json` and does NOT require the directory name to match, so these
 * fixtures keep their honest `"suite": "regression"` label while living in
 * their own directory and leaving the established counts intact.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBenchmarkCase, type BenchmarkCase } from "./baseline.js";
import type { VerificationSpec } from "@ar/contracts";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../benchmarks/r98-fixtures");
/** The frozen suite the established counts are asserted against. */
const REGRESSION_ROOT = resolve(import.meta.dirname, "../../../benchmarks/regression");

const FIRST_ID = "r98-tool-write-request";
const SECOND_ID = "r98-tool-write-second";

/** The file each request is supposed to CREATE, and the content it must hold. */
const FIRST_TARGET = "out/r98-request.txt";
const FIRST_CONTENT = "r98-request-first-write";
const SECOND_TARGET = "notes/r98-second.txt";
const SECOND_CONTENT = "r98-second-distinct-write";

async function load(id: string): Promise<BenchmarkCase> {
  return loadBenchmarkCase(join(FIXTURE_ROOT, id));
}

/** The artifact specs of a case (the file-existence half of the claim). */
function artifactSpecs(caseDef: BenchmarkCase): Array<Extract<VerificationSpec, { kind: "artifact" }>> {
  return (caseDef.verification ?? []).filter(
    (spec): spec is Extract<VerificationSpec, { kind: "artifact" }> => spec.kind === "artifact",
  );
}

describe("R98 fixture cases load through the REAL loader", () => {
  it("loads both r98-tool-write cases with the regression suite and non-empty docs", async () => {
    for (const id of [FIRST_ID, SECOND_ID]) {
      const caseDef = await load(id);
      expect(caseDef.id).toBe(id);
      expect(caseDef.suite).toBe("regression");
      expect(caseDef.expected).toEqual({ status: "completed" });
      expect(caseDef.requestMd.trim().length).toBeGreaterThan(0);
      expect(caseDef.expectedMd.trim().length).toBeGreaterThan(0);
      expect(caseDef.task).toBe(caseDef.requestMd.trim());
      // Each case must carry a verification gate; without one the judge has
      // nothing to prove execution against.
      expect((caseDef.verification ?? []).length).toBeGreaterThan(0);
    }
  });

  it("keeps the two request texts DIFFERENT and free of any r97 placeholder text", async () => {
    const first = await load(FIRST_ID);
    const second = await load(SECOND_ID);
    // A single fixed placeholder prompt cannot satisfy both cases.
    expect(first.requestMd).not.toBe(second.requestMd);
    // The plan's anti-placeholder assertion: neither request may smuggle a
    // previous round's token in.
    expect(first.requestMd.toLowerCase()).not.toContain("r97");
    expect(second.requestMd.toLowerCase()).not.toContain("r97");
  });

  it("keeps the two verification blocks DIFFERENT (different paths AND different expectations)", async () => {
    const first = await load(FIRST_ID);
    const second = await load(SECOND_ID);
    expect(first.verification).not.toEqual(second.verification);

    const firstArtifacts = artifactSpecs(first);
    const secondArtifacts = artifactSpecs(second);
    expect(firstArtifacts).toHaveLength(1);
    expect(secondArtifacts).toHaveLength(1);
    expect(firstArtifacts[0]!.path).toBe(FIRST_TARGET);
    expect(secondArtifacts[0]!.path).toBe(SECOND_TARGET);
    expect(firstArtifacts[0]!.path).not.toBe(secondArtifacts[0]!.path);
    // `mustChange` is the only thing that makes an artifact spec prove a WRITE
    // rather than mere existence; a pre-seeded file must not be able to pass.
    expect(firstArtifacts[0]!.mustChange).toBe(true);
    expect(secondArtifacts[0]!.mustChange).toBe(true);
  });

  it("does NOT pre-seed the file either request is supposed to create", async () => {
    const first = await load(FIRST_ID);
    const second = await load(SECOND_ID);
    // The loader exposes the fixture as relative path → UTF-8 content. If the
    // target were present, an artifact check could pass without any tool call.
    expect(Object.keys(first.fixture)).not.toContain(FIRST_TARGET);
    expect(Object.keys(second.fixture)).not.toContain(SECOND_TARGET);
    // Cross-check: neither fixture may carry the OTHER case's target either —
    // that is how a reused context would leak a pass.
    expect(Object.keys(first.fixture)).not.toContain(SECOND_TARGET);
    expect(Object.keys(second.fixture)).not.toContain(FIRST_TARGET);
    // Sanity: the loader really did read a non-empty fixture, so the negative
    // assertion above is about a real directory and not a missing one.
    expect(Object.keys(first.fixture).length).toBeGreaterThan(0);
    expect(Object.keys(second.fixture).length).toBeGreaterThan(0);
  });

  it("NEGATIVE CONTROL: the expected content strings are absent from the initial fixture state", async () => {
    const first = await load(FIRST_ID);
    const second = await load(SECOND_ID);
    const firstState = Object.values(first.fixture).join("\n");
    const secondState = Object.values(second.fixture).join("\n");
    // "The file already had the right content" can never be why a run passes.
    expect(firstState).not.toContain(FIRST_CONTENT);
    expect(secondState).not.toContain(SECOND_CONTENT);
    // Nor may either fixture carry the other case's expected content.
    expect(firstState).not.toContain(SECOND_CONTENT);
    expect(secondState).not.toContain(FIRST_CONTENT);
  });

  it("the command half of each gate asserts the content, not just existence", async () => {
    for (const [id, target, content] of [
      [FIRST_ID, FIRST_TARGET, FIRST_CONTENT],
      [SECOND_ID, SECOND_TARGET, SECOND_CONTENT],
    ] as const) {
      const caseDef = await load(id);
      const commands = (caseDef.verification ?? []).filter(
        (spec): spec is Extract<VerificationSpec, { kind: "command" }> => spec.kind === "command",
      );
      expect(commands, `${id} needs a content assertion`).toHaveLength(1);
      const recipe = [commands[0]!.command, ...(commands[0]!.args ?? [])].join(" ");
      // The artifact check alone only proves existence + changedPaths (R77 V2),
      // so the exact content must be asserted by the command.
      expect(recipe).toContain(target);
      expect(recipe).toContain(content);
    }
  });
});

describe("R98 fixtures do NOT disturb the frozen suite counts", () => {
  // MEASURED regression this guards: placing these two fixtures inside
  // `benchmarks/regression/` took the directory to 32 and broke
  // `apps/cli/src/audit.benchmark-profile.test.ts` (`caseCount: 30`) plus the
  // `benchmarks/README.md` claim that `docs:verify` checks. They now live in
  // their own directory, so the counts and the labels can both stay honest.
  it("keeps the frozen regression suite at its counted 30 cases", async () => {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(REGRESSION_ROOT, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
    expect(dirs.length).toBe(30);
    // And neither fixture is hiding inside the frozen suite.
    expect(dirs.map((d) => d.name)).not.toContain(FIRST_ID);
    expect(dirs.map((d) => d.name)).not.toContain(SECOND_ID);
  });

  it("the relocated fixtures still declare the honest regression suite label", async () => {
    for (const id of [FIRST_ID, SECOND_ID]) {
      const caseDef = await load(id);
      // Relocation must not have been used to change the label: the case really
      // is a regression-suite case, it just is not part of the counted 30.
      expect(caseDef.suite).toBe("regression");
    }
  });
});
