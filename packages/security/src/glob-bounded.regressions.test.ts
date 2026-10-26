import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newAgentId, newSessionId } from "@ar/contracts";
import { globToRegex, matchGlob, normalizePath } from "./glob.js";
import { DeterministicPermissionEngine } from "./permission.js";

function legacyMatch(pattern: string, target: string): boolean {
  const p = normalizePath(pattern), t = normalizePath(target);
  const regex = globToRegex(p);
  return regex.test(t) || (!p.includes("/") && regex.test(t.slice(t.lastIndexOf("/") + 1)));
}

function strings(alphabet: string[], maxLength: number): string[] {
  const all = [""];
  let layer = [""];
  for (let length = 1; length <= maxLength; length++) {
    layer = layer.flatMap(prefix => alphabet.map(char => prefix + char));
    all.push(...layer);
  }
  return all;
}

describe("glob matching preserves permission semantics with bounded backtracking", () => {
  it("agrees with the compatibility RegExp across exhaustive small globs and paths", () => {
    const targets = strings(["a", "b", "/"], 4);
    for (const pattern of strings(["a", "*", "?", "/"], 4)) {
      for (const target of targets) {
        expect(matchGlob(pattern, target), JSON.stringify({ pattern, target })).toBe(legacyMatch(pattern, target));
      }
    }
  });

  it("agrees on seeded UTF-16, regex punctuation, Windows paths and line terminators", () => {
    let seed = 0x6a09e667;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const alphabet = "ab/*?\\.[]{}()^$+|\n\r\u2028\u2029😀\ud800";
    const random = (max: number) => {
      let value = "";
      for (let j = next() % max; j > 0; j--) value += alphabet[next() % alphabet.length]!;
      return value;
    };
    for (let i = 0; i < 10000; i++) {
      const pattern = random(16), target = random(24);
      expect(matchGlob(pattern, target), JSON.stringify({ pattern, target })).toBe(legacyMatch(pattern, target));
    }
    for (const pattern of ["**", "*", "?", "**/a", "***/a", "****/a", "**/?", "*\n", "a$", "[a]"]) {
      for (const target of ["\n", "a\n", "a\r\n", "\u2028/a", "x\n/a", "\n/a", "x/\n/a", "C:\\src\\a", "😀"]) {
        expect(matchGlob(pattern, target), JSON.stringify({ pattern, target })).toBe(legacyMatch(pattern, target));
      }
    }
  });

  it.each(["\n", "\r", "\u2028", "\u2029"])("retains the distinct single/double-star newline behavior for %j", newline => {
    expect(matchGlob("*", newline)).toBe(true);
    expect(matchGlob("?", newline)).toBe(true);
    expect(matchGlob("**", newline)).toBe(false);
    expect(matchGlob("**/a", `${newline}/a`)).toBe(false);
    expect(matchGlob("a", `a${newline}`)).toBe(false);
  });

  it("finishes adversarial missing-suffix matches under an out-of-process watchdog", () => {
    // Run the actual source in an owned process: a regression cannot stall the
    // test runner's timers. Node 22+ is the project's supported CI runtime.
    const moduleUrl = new URL("./glob.ts", import.meta.url).href;
    const script = `
      import { matchGlob } from ${JSON.stringify(moduleUrl)};
      const results = [];
      for (const count of [24, 48, 96]) {
        results.push(matchGlob("*a".repeat(count) + "b", "a".repeat(200) + ".ts"));
        results.push(matchGlob("**/".repeat(count) + "missing", "a/".repeat(100) + "present"));
        results.push(matchGlob("*a".repeat(count) + "b", "a".repeat(200) + "b"));
      }
      results.push(matchGlob("**/".repeat(100000) + "a", "x/".repeat(100) + "a"));
      results.push(matchGlob("*".repeat(100000) + "a", "x/".repeat(100) + "a"));
      results.push(matchGlob("*a".repeat(100000) + "b", "a".repeat(200) + ".ts"));
      console.log(JSON.stringify(results));
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8", timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual([false, false, true, false, false, true, false, false, true, true, true, false]);
  });

  it("continues denying nested and Windows paths, including equally-specific conflicts", async () => {
    const engine = new DeterministicPermissionEngine();
    const request = { action: "read", resource: "file", agentId: newAgentId(), sessionId: newSessionId() };
    for (const target of ["secrets/key.pem", "src/secrets/key.pem", "src\\secrets\\key.pem"]) {
      const result = await engine.evaluate({ ...request, target }, { rules: [
        { action: "read", resource: "file", pattern: "**/secrets/**", effect: "allow" },
        { action: "read", resource: "file", pattern: "**/secrets/**", effect: "deny" },
      ], defaultEffect: "allow" });
      expect(result.effect).toBe("deny");
    }
    expect((await engine.evaluate({ ...request, target: "src/public.ts" }, { rules: [
      { action: "read", resource: "file", pattern: "**/secrets/**", effect: "allow" },
    ], defaultEffect: "deny" })).effect).toBe("deny");
  });
});
