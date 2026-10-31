import { expect, it } from "vitest";
import { applyBatchReplace, applyReplace } from "./edit.js";

for (const bom of ["", "\ufeff"]) {
  for (const prefix of ["\n", "\r\n"]) {
    for (const middle of ["\n", "\r\n"]) {
      for (const suffix of ["\n", "\r\n"]) {
        it(`keeps exact untouched bytes across CRLF boundaries ${JSON.stringify({ bom, prefix, middle, suffix })}`, () => {
          const original = `${bom}head${prefix}old${middle}next${suffix}tail`;
          const expected = `${bom}head${prefix}new${middle}extra${suffix}tail`;
          expect(applyReplace(original, "old\nnext", "new\nextra").content).toBe(expected);
          expect(applyBatchReplace(original, [{ oldText: "old\nnext", newText: "new\nextra" }]).content).toBe(expected);
        });
      }
    }
  }
}
it("maps LF boundaries themselves to the complete original CRLF bytes", () => {
  expect(applyReplace("a\r\nb\r\nc", "\n", "!", { replaceAll: true }).content).toBe("a!b!c");
  expect(applyReplace("a\r\nb\nc\r\nd", "\n", "!", { occurrence: 3 }).content).toBe("a\r\nb\nc!d");
});
it("preserves a literal lone CR and does not perform additional Unicode normalization", () => {
  expect(applyReplace("head\rword\r\ntail", "word\n", "new\n").content).toBe("head\rnew\r\ntail");
  expect(applyReplace("🙂\r\nＡ\nA\r\ntail", "Ａ\nA", "B").content).toBe("🙂\r\nB\r\ntail");
});
