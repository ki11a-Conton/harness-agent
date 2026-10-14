import { expect, it } from "vitest";
import { compareText } from "./change-compare.js";

it.each([["line", "line\n"], ["line\n", "line"], ["line\n", "\uFEFFline\n"]])("shows format-only edits in the actual diff (%j to %j)", (before, after) => {
  const compared = compareText(before!, after!, 100);
  expect(compared.hunks.length).toBeGreaterThan(0); expect(compared.added).toBe(1); expect(compared.deleted).toBe(1);
});
it("keeps identical unterminated text unchanged and marks real EOF line changes", () => {
  expect(compareText("line", "line", 100)).toMatchObject({ hunks: [], added: 0, deleted: 0 });
  const changed = compareText("before", "after", 100);
  expect(changed.hunks.flatMap(hunk => hunk.lines)).toContain("\\ No newline at end of file");
});
