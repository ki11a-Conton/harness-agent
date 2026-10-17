import { describe, expect, it } from "vitest";
import { parseChampionEvalArgs } from "./commands.js";

/**
 * CLI-002: `agent champion eval` used to derive its two positional run files
 * with `rest.slice(1).filter(a => !a.startsWith("--"))`, which keeps FLAG VALUES
 * as positionals. `champion eval --mode real-model a.json b.json` therefore
 * read `baselinePath = "real-model"` and `candidatePath = "a.json"` — a silently
 * wrong pair of inputs.
 */
describe("parseChampionEvalArgs (CLI-002)", () => {
  it("keeps both run files when the flags come first", () => {
    const parsed = parseChampionEvalArgs(["--mode", "real-model", "baseline.json", "candidate.json"]);
    expect(parsed).toMatchObject({ ok: true, files: ["baseline.json", "candidate.json"], mode: "real-model" });
  });

  it("keeps both run files when the flags come last", () => {
    const parsed = parseChampionEvalArgs(["baseline.json", "candidate.json", "--mode", "real-model"]);
    expect(parsed).toMatchObject({ ok: true, files: ["baseline.json", "candidate.json"], mode: "real-model" });
  });

  it("never treats a --mode or --candidate VALUE as a run file", () => {
    const parsed = parseChampionEvalArgs(["a.json", "b.json", "--candidate", "cand-1", "--strict", "--historical"]);
    expect(parsed).toMatchObject({
      ok: true,
      files: ["a.json", "b.json"],
      candidateId: "cand-1",
      strict: true,
      historical: true,
    });
  });

  it("defaults to the stub mode with no candidate", () => {
    expect(parseChampionEvalArgs(["baseline.json", "candidate.json"])).toEqual({
      ok: true,
      files: ["baseline.json", "candidate.json"],
      mode: "stub",
      strict: false,
      historical: false,
    });
  });

  it("rejects an unknown --mode value instead of silently running the stub mode", () => {
    expect(parseChampionEvalArgs(["--mode", "bogus", "a.json", "b.json"]).ok).toBe(false);
  });

  it("rejects a flag that is missing its value", () => {
    expect(parseChampionEvalArgs(["a.json", "b.json", "--mode"]).ok).toBe(false);
    expect(parseChampionEvalArgs(["a.json", "b.json", "--candidate"]).ok).toBe(false);
    // A following flag is not a usable value.
    expect(parseChampionEvalArgs(["a.json", "b.json", "--candidate", "--strict"]).ok).toBe(false);
  });

  it("rejects unknown flags instead of ignoring them", () => {
    expect(parseChampionEvalArgs(["--nope", "a.json", "b.json"]).ok).toBe(false);
  });

  it("rejects --flag=value, which this command never supported", () => {
    expect(parseChampionEvalArgs(["a.json", "b.json", "--mode=real-model"]).ok).toBe(false);
  });

  it("requires exactly two positional run files", () => {
    expect(parseChampionEvalArgs(["only-one.json"]).ok).toBe(false);
    expect(parseChampionEvalArgs([]).ok).toBe(false);
    expect(parseChampionEvalArgs(["--strict"]).ok).toBe(false);
    expect(parseChampionEvalArgs(["a.json", "b.json", "c.json"]).ok).toBe(false);
  });
});
