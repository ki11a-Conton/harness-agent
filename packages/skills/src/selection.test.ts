import { describe, expect, it } from "vitest";
import type { SkillIndexEntry } from "@ar/contracts";
import { selectSkills } from "./selection.js";

const INDEX: SkillIndexEntry[] = [
  { name: "compile-check", description: "run the compiler and report errors" },
  { name: "test-driver", description: "run unit tests and summarize failures" },
  { name: "git-hygiene", description: "commit hygiene and branch cleanup" },
];

describe("P2-6 skill selection", () => {
  it("selects rows matching the task goal and excludes the rest", () => {
    const { selected, excluded } = selectSkills(INDEX, "fix the failing compiler errors");

    expect(selected.map((s) => s.name)).toEqual(["compile-check"]);
    expect(excluded.map((s) => s.name)).toEqual(["test-driver", "git-hygiene"]);
  });

  it("caps the result at k", () => {
    const { selected } = selectSkills(INDEX, "run tests and check compiler", { k: 1 });
    expect(selected).toHaveLength(1);
  });

  it("drops rows below minScore", () => {
    const { selected } = selectSkills(INDEX, "fix the failing compiler errors", {
      minScore: 0.6,
    });
    expect(selected).toHaveLength(0);
  });

  it("an empty task goal preserves the full index (no relevance signal)", () => {
    const { selected, excluded } = selectSkills(INDEX, "");
    expect(selected).toHaveLength(INDEX.length);
    expect(excluded).toHaveLength(0);
  });

  it("preserves index order in both outputs", () => {
    const { selected, excluded } = selectSkills(INDEX, "compile errors check");
    expect(selected.map((s) => s.name)).toEqual(["compile-check"]);
    expect(excluded.map((s) => s.name)).toEqual(["test-driver", "git-hygiene"]);
  });
});