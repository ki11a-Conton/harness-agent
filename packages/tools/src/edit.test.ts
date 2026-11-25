import { describe, expect, it } from "vitest";
import { applyBatchReplace, applyLineRange, applyReplace, lineDiff } from "./edit.js";

describe("edit recovery after an exact miss", () => {
  it("reports the original multiline window and failed batch index without applying either edit", () => {
    const content = "\ufefftop\r\n\tif (ready) {\r\n  start();\n}\n";
    const oldText = "    if (ready) {\n    start();\n";
    const single = applyReplace(content, oldText, "unused");
    const batch = applyBatchReplace(content, [{ oldText: "top", newText: "changed" }, { oldText, newText: "unused" }]);
    for (const result of [single, batch]) {
      expect(result).toMatchObject({ ok: false, content, count: 0, matched: 0, reread: { offset: 2, limit: 2 } });
    }
    expect(batch.error).toContain("edits[1]");
    expect(applyReplace(content, "\ufeff  top", "unused").reread).toEqual({ offset: 1, limit: 1 });
  });

  it.each([
    { name: "overlapping candidates", file: "x\nx\nx", anchor: "  x\n  x" },
    { name: "internal whitespace", file: "a  + b", anchor: "   a + b" },
    { name: "changed punctuation", file: "return value!", anchor: "  return value;" },
    { name: "whitespace only", file: "x\n\ny", anchor: "    " },
    { name: "missing final newline", file: "x", anchor: "  x\n" },
    { name: "explicit BOM cannot move to a later line", file: "\ufeffa\nb", anchor: "\ufeff  b" },
    { name: "too many lines to establish uniqueness", file: "x\n" + "\n".repeat(8192), anchor: "  x" },
    { name: "large file", file: "x\n" + "z".repeat(256 * 1024), anchor: "  x" },
    { name: "page would exceed the reader budget", file: " ".repeat(60_000) + "x", anchor: "\tx" },
  ])("omits an unreliable or unreadable location for $name", ({ file, anchor }) => {
    const result = applyReplace(file, anchor, "unused");
    expect(result).toMatchObject({ ok: false, content: file, count: 0 });
    expect(result.reread).toBeUndefined();
  });
});

describe("P2-28 applyReplace", () => {
  const content = "a b a c a";

  it("defaults to first occurrence (backward compatible)", () => {
    const r = applyReplace(content, "a", "X");
    expect(r.ok).toBe(true);
    expect(r.content).toBe("X b a c a");
    expect(r.count).toBe(1);
    expect(r.matched).toBe(3);
  });

  it("refuses a conflicting ordinal and all-matches selection", () => {
    const result = applyReplace(content, "a", "X", { occurrence: 2, replaceAll: true });
    expect(result).toMatchObject({ ok: false, content, count: 0 });
  });

  it("replaceAll replaces every occurrence", () => {
    const r = applyReplace(content, "a", "X", { replaceAll: true });
    expect(r.content).toBe("X b X c X");
    expect(r.count).toBe(3);
  });

  it("occurrence targets exactly the Nth occurrence", () => {
    const r = applyReplace(content, "a", "X", { occurrence: 2 });
    expect(r.content).toBe("a b X c a");
    expect(r.count).toBe(1);
  });

  it("occurrence out of range fails loudly (never guesses)", () => {
    const r = applyReplace(content, "a", "X", { occurrence: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("out of range");
    expect(r.error).toContain("3");
    // content is untouched
    expect(r.content).toBe(content);
  });

  it("fails when the anchor is absent", () => {
    const r = applyReplace(content, "zzz", "X");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("rejects an empty anchor", () => {
    const r = applyReplace(content, "", "X");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("empty");
  });
});

describe("P2-28 applyLineRange", () => {
  const doc = "one\ntwo\nthree\nfour\nfive";

  it("replaces a middle line range with a multi-line replacement", () => {
    const r = applyLineRange(doc, 2, 3, "X\nXX");
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    expect(r.content).toBe("one\nX\nXX\nfour\nfive");
  });

  it("replaces a single line with an empty replacement (removes it)", () => {
    const r = applyLineRange(doc, 3, 3, "");
    expect(r.ok).toBe(true);
    expect(r.content).toBe("one\ntwo\nfour\nfive");
  });

  it("supports replacing from the first line", () => {
    const r = applyLineRange(doc, 1, 2, "start");
    expect(r.content).toBe("start\nthree\nfour\nfive");
  });

  it("clamps an end beyond the file length", () => {
    const r = applyLineRange(doc, 4, 99, "tail");
    expect(r.ok).toBe(true);
    expect(r.content).toBe("one\ntwo\nthree\ntail");
  });

  it("rejects invalid ranges", () => {
    expect(applyLineRange(doc, 0, 1, "x").ok).toBe(false);
    expect(applyLineRange(doc, 3, 2, "x").ok).toBe(false);
    expect(applyLineRange(doc, 1.5, 2, "x").ok).toBe(false);
  });
});

describe("P2-28 lineDiff", () => {
  it("emits removed and added lines for a local change", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc");
    expect(d).toContain("- b");
    expect(d).toContain("+ B");
  });

  it("reports no change when identical", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual(["(no change)"]);
  });

  it("caps very large diffs", () => {
    const big = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const d = lineDiff(big, `line0\nafter\n${Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n")}`);
    expect(d.some((l) => l.startsWith("…"))).toBe(true);
  });
});