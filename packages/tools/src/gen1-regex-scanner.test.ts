import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegexScanner } from "./regex-scanner.js";
import { grepFiles } from "./navigate.js";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scanners: RegexScanner[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scanners.splice(0).map(scanner => scanner.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
function scanner(pattern: string, caseSensitive = false, signal?: AbortSignal, budgetMs = 5000) {
  const created = new RegexScanner(pattern, caseSensitive, signal, budgetMs); scanners.push(created); return created;
}

describe("Gen1 regex computation isolation", () => {
  it("keeps regex lines, Unicode columns, and case sensitivity compatible", async () => {
    const insensitive = scanner("中文|HELLO");
    expect(await insensitive.scan("x中文\r\nhello\nnone", 3)).toEqual([{ line: 1, column: 2 }, { line: 2, column: 1 }]);
    expect(await scanner("HELLO", true).scan("hello\nHELLO", 3)).toEqual([{ line: 2, column: 1 }]);
  });
  it("terminates real exponential backtracking at the total regex deadline", async () => {
    const risky = scanner("(a+)+$", true, undefined, 1000);
    const start = performance.now();
    await expect(risky.scan("a".repeat(60) + "!", 10)).rejects.toThrow("REGEX_SEARCH_LIMIT");
    await risky.close();
    expect(performance.now() - start).toBeLessThan(2500);
  });
  it("lets the main event loop cancel an already warm worker stuck in regex", async () => {
    const ac = new AbortController(), risky = scanner("(a+)+$", true, ac.signal);
    await risky.scan("safe", 10);
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; ac.abort(); }, 50);
    const start = performance.now();
    try { await expect(risky.scan("a".repeat(60) + "!", 10)).rejects.toThrow("cancelled"); }
    finally { clearTimeout(timer); await risky.close(); }
    expect(timerFired).toBe(true); expect(performance.now() - start).toBeLessThan(1500);
  });
  it("shares one total deadline across multiple sequential files rather than resetting it", async () => {
    const ac = new AbortController(), shared = scanner("needle", true, ac.signal, 1000);
    expect(await shared.scan("needle", 10)).toEqual([{ line: 1, column: 1 }]);
    expect(await shared.scan("second needle", 10)).toEqual([{ line: 1, column: 8 }]);
    await new Promise(resolve => setTimeout(resolve, 1050));
    await expect(shared.scan("third needle", 10)).rejects.toThrow("total search budget");
  });
  it("uses no computation worker for escaped literal matching", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "ar-literal-fast-")); roots.push(root);
    await fs.writeFile(join(root, "source.ts"), "中文\r\n([value]\n");
    const post = vi.spyOn(Worker.prototype, "postMessage");
    expect(await grepFiles({ root, pattern: "([value]", literal: true })).toEqual([
      { file: "source.ts", line: 2, column: 1, text: "([value]" },
    ]);
    expect(post).not.toHaveBeenCalled();
  });
  it("does not create a worker for a pre-aborted call", () => {
    const ac = new AbortController(); ac.abort();
    expect(() => scanner("needle", false, ac.signal)).toThrow();
  });
});
