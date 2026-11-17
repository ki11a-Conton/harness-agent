import { expect, it } from "vitest";
import { lineDiff } from "./edit.js";

it.each([
  { before: "a\nb", after: "a\nb", expected: ["(no change)"] },
  { before: "a\nb\nc", after: "a\nB\nc", expected: ["- b", "+ B"] },
  { before: "", after: "hello", expected: ["- ", "+ hello"] },
  { before: "hello", after: "", expected: ["- hello", "+ "] },
  { before: "a", after: "a\nb", expected: ["+ b"] },
  { before: "a\nb", after: "a", expected: ["- b"] },
  { before: "a\n", after: "a", expected: ["- "] },
  { before: "a", after: "a\n", expected: ["+ "] },
  { before: "a\nb\n", after: "a\nB\n", expected: ["- b", "+ B"] },
  { before: "\ufeff汉字\r\n🙂\nTail", after: "\ufeff汉字\r\n😀\nTail", expected: ["- 🙂", "+ 😀"] },
  { before: "x\nsame\ny", after: "X\nsame\nY", expected: ["- x", "- same", "- y", "+ X", "+ same", "+ Y"] },
])("diff preserves line-boundary semantics: $before -> $after", ({ before, after, expected }) => {
  expect(lineDiff(before, after)).toEqual(expected);
});

it("counts all changed lines while emitting only the requested preview", () => {
  expect(lineDiff("one\ntwo\nthree\nfour", "ONE\nTWO\nTHREE\nFOUR", 2)).toEqual([
    "- one", "- two", "…4 line(s) removed", "+ ONE", "+ TWO", "…4 line(s) added",
  ]);
  expect(lineDiff("a\nb", "A\nB", 0)).toEqual(["…2 line(s) removed", "…2 line(s) added"]);
});

it("bounds long preview lines explicitly without splitting emoji", () => {
  const body = "a" + "🙂".repeat(3000) + "z";
  const diff = lineDiff(body, "b" + "🙂".repeat(3000) + "Z");
  expect(diff).toHaveLength(2);
  expect(diff[0]).toMatch(/^- a/); expect(diff[0]).toMatch(/z$/);
  expect(diff[1]).toMatch(/^\+ b/); expect(diff[1]).toMatch(/Z$/);
  for (const line of diff) {
    expect(line.length).toBeLessThan(1200);
    expect(line).toMatch(/truncated/i);
    expect(line).not.toMatch(/[\uD800-\uDFFF]/u);
  }
});
