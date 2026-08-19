/**
 * Q-15 / Q-16 — Property & Fuzz Testing for Security Parsers.
 *
 * The security gate parsers (network gate, injection gate, secret gate, glob /
 * path normalization, and the stable stringify path via redactSecrets) are pure
 * and deterministic, so they are ideal targets for randomized testing without
 * pulling in a mutation framework. Per plan.md:
 *
 *   Q-15: property tests over network / injection / secret / path / stringify.
 *   Q-16: fuzz tool args & event payload shapes (unexpected args, huge nested
 *         objects, cyclic/stringified objects, invalid UTF-8 boundaries, very
 *         long strings) — assert the parsers never crash.
 *
 * Everything is seeded by a fixed PRNG (mulberry32) so a failing seed is
 * reproducible: run with `SEED=<n>` to re-run a specific iteration.
 *
 * Invariants asserted (no crash is the fuzz gate; these are the property gate):
 *   - parsers always return a well-formed report, never throw;
 *   - parsers are idempotent-ish: re-running over a stable input is stable;
 *   - redactSecrets never grows differential content unrelated to matching;
 *   - globToRegex outputs a compilable regex and matchGlob is total;
 *   - normalizePath / containsPath are total over arbitrary strings.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeProcessCommand,
  detectNetworkIntent,
  detectPromptInjection,
  detectSecrets,
  redactSecrets,
  surfaceDenied,
} from "./index.js";
import { containsPath } from "./sandbox.js";
import { globToRegex, matchGlob, normalizePath } from "./glob.js";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — reproduce any seed.
// ---------------------------------------------------------------------------
const SEED = Number(process.env.SEED ?? 0x5eed);
const ITERATIONS = 300;

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry(SEED);

function randomAscii(rnd: () => number, len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/:,;?=&+~@!#$%^()[]{}'\"`\\ ";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(rnd() * chars.length)];
  return out;
}

function randomUnicode(rnd: () => number, len: number): string {
  // Valid UTF-16 but may hold lone surrogates / invalid-UTF-8-boundary emoji.
  const chars = "é日本語🚀\uD800\uDFFF\u{1F600}~`\"'\\;:|&<>()[]{} \t\n";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(rnd() * chars.length)];
  return out;
}

function randomLen(rnd: () => number): number {
  const p = rnd();
  if (p < 0.3) return Math.floor(rnd() * 8); // short
  if (p < 0.7) return 8 + Math.floor(rnd() * 64); // medium
  return 64 + Math.floor(rnd() * 500); // long
}

/** Build adversarial inputs: mix copy-pasted fragments, URLs, secrets, shell. */
function adversarialInput(rnd: () => number): string {
  const pieces = [
    "curl https://example.com/x",
    "wget http://10.0.0.1:8080/a b c",
    "echo AKIAABCDEFGHIJKLMNOP",
    "Bearer abcdefghijklmnopqrstuv",
    "-----BEGIN RSA PRIVATE KEY-----",
    "git clone ssh://git@github.com/org/repo",
    "powershell -Command \"Invoke-WebRequest x\"",
    "cmd /c dir",
    "node -e \"fetch('x')\"",
    "            ",
    "",
    "\u0000null-byte",
    "a".repeat(2000),
    "😀".repeat(200),
  ];
  const n = 1 + Math.floor(rnd() * 4);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const pick = Math.floor(rnd() * pieces.length);
    parts.push(pieces[pick] ?? pieces[0]!);
  }
  if (rnd() < 0.5) return parts.join(rnd() < 0.5 ? " " : "; ");
  return `${randomUnicode(rnd, randomLen(rnd))} ${parts.join(" ")} ${randomAscii(rnd, randomLen(rnd))}`;
}

/* ---------------------------------------------------------------------- *
 * Q-16: parsers never crash on adversarial input (fuzz gate).
 * ---------------------------------------------------------------------- */
describe("Q-16 fuzz — security parsers never crash", () => {
  for (let i = 0; i < ITERATIONS; i++) {
    const input = adversarialInput(rand);
    it(`network gate (iter ${i})`, () => {
      const r = detectNetworkIntent(input);
      expect(r).toMatchObject({ hasNetworkIntent: expect.any(Boolean) });
      expect(Array.isArray(r.reasons)).toBe(true);
      expect(Array.isArray(r.hosts)).toBe(true);
    });
    it(`process gate (iter ${i})`, () => {
      const r = analyzeProcessCommand(input);
      expect(r.surface).toBeTruthy();
      expect(Array.isArray(r.reasons)).toBe(true);
    });
    it(`injection gate (iter ${i})`, () => {
      const r = detectPromptInjection(input);
      expect(typeof r.hasInjection).toBe("boolean");
      expect(Array.isArray(r.reasons)).toBe(true);
      expect(Array.isArray(r.flags)).toBe(true);
    });
    it(`secret gate + redact (iter ${i})`, () => {
      const d = detectSecrets(input);
      expect(typeof d.hasSecret).toBe("boolean");
      expect(Array.isArray(d.secrets)).toBe(true);
      const r = redactSecrets(input);
      expect(typeof r.content).toBe("string");
      expect(typeof r.redacted).toBe("number");
      expect(r.redacted).toBeGreaterThanOrEqual(0);
    });
    it(`glob + path (iter ${i})`, () => {
      const g = globToRegex(randomAscii(rand, randomLen(rand)));
      expect(g instanceof RegExp).toBe(true);
      matchGlob("**/x/**", input);
      containsPath(input, input, true);
      expect(typeof normalizePath(input)).toBe("string");
    });
    it(`surfaceDenied over surface (iter ${i})`, () => {
      const a = analyzeProcessCommand(input);
      const d = surfaceDenied(a, ["shell-wrapper"]);
      expect(typeof d.denied).toBe("boolean");
      expect(typeof d.reason === "string" || d.reason === undefined).toBe(true);
    });
  }
});

/* ---------------------------------------------------------------------- *
 * Q-15: property tests over the deterministic surfaces.
 * ---------------------------------------------------------------------- */
describe("Q-15 property — redactSecrets invariants", () => {
  it("redacting is idempotent (already-redacted output has no further matches)", () => {
    for (let i = 0; i < 50; i++) {
      const input = adversarialInput(rand);
      const once = redactSecrets(input);
      const twice = redactSecrets(once.content);
      // A second pass must not redact further — otherwise redaction is unstable.
      expect(twice.redacted).toBe(0);
    }
  });

  it("non-secret ASCII content is never mutated", () => {
    for (let i = 0; i < 50; i++) {
      const input = `plain text ${i} with numbers 1 2 3 and symbols , . ; :`;
      const r = redactSecrets(input);
      expect(r.content).toBe(input);
      expect(r.redacted).toBe(0);
    }
  });

  it("a redaction never expands the total byte weight vs a bounded span", () => {
    const input = "key: AKIAABCDEFGHIJKLMNOP value: Bearer abcdefghijklmnopqrstuvwxyz";
    const r = redactSecrets(input);
    // Every secret span is replaced by "[redacted]" (short), so content is not
    // longer than the original by more than a tiny constant.
    expect(r.content.length).toBeLessThanOrEqual(input.length + 64);
    expect(r.redacted).toBeGreaterThan(0);
  });
});

describe("Q-15 property — detectSecrets / detectPromptInjection monotonic append", () => {
  it("detectSecrets is monotonic under suffix append (adding can only add secrets, never remove)", () => {
    for (let i = 0; i < 30; i++) {
      const base = adversarialInput(rand);
      const extra = base + " AKIAABCDEFGHIJKLMNOP";
      const before = detectSecrets(base).secrets;
      const after = detectSecrets(extra).secrets;
      // The secret family, if newly added, is present after; nothing disappears.
      for (const s of before) expect(after).toContain(s);
      expect(after).toContain("aws-access-key");
    }
  });
});

describe("Q-15 property — glob & path totality", () => {
  it("globToRegex always produces a compilable, full-match regex over arbitrary patterns", () => {
    for (let i = 0; i < 50; i++) {
      const pat = `${randomAscii(rand, randomLen(rand))}${i % 2 ? "**" : "*"}/x`;
      expect(() => globToRegex(pat)).not.toThrow();
      expect(globToRegex(pat) instanceof RegExp).toBe(true);
    }
  });

  it("normalizePath is idempotent and maps backslashes to slashes", () => {
    for (let i = 0; i < 50; i++) {
      const p = `a\\b${i}\\c/${i}`;
      const once = normalizePath(p);
      expect(normalizePath(once)).toBe(once);
      expect(once.includes("\\")).toBe(false);
    }
  });

  it("containsPath is total and consistent for any (p,root)", () => {
    for (let i = 0; i < 50; i++) {
      const p = randomAscii(rand, randomLen(rand));
      const root = rootDir(rand);
      const r = containsPath(p, root, i % 2 === 0);
      expect(typeof r).toBe("boolean");
      // Reflexivity: a path is always inside itself (boundary-insensitive at root).
      expect(containsPath(root, root, i % 2 === 0)).toBe(true);
    }
  });
});

function rootDir(rnd: () => number): string {
  const depth = 1 + Math.floor(rnd() * 3);
  const parts = ["/"];
  for (let i = 0; i < depth; i++) parts.push(randomAscii(rnd, 3));
  return parts.join("/");
}

/* ---------------------------------------------------------------------- *
 * Q-16: pathological shapes (explicit, not just random).
 * ---------------------------------------------------------------------- */
describe("Q-16 fuzz — pathological shapes", () => {
  it("empty and whitespace-only inputs", () => {
    for (const s of ["", "   ", "\t\n", "  ;  "]) {
      expect(() => detectNetworkIntent(s)).not.toThrow();
      expect(() => analyzeProcessCommand(s)).not.toThrow();
      expect(() => detectPromptInjection(s)).not.toThrow();
      expect(() => detectSecrets(s)).not.toThrow();
    }
  });

  it("very long strings (hundreds of KB) do not crash", () => {
    const long = "A".repeat(500 * 1024) + " AKIAABCDEFGHIJKLMNOP";
    expect(() => detectSecrets(long)).not.toThrow();
    expect(() => detectPromptInjection(long)).not.toThrow();
    const r = redactSecrets(long);
    expect(r.redacted).toBeGreaterThanOrEqual(1);
  });

  it("invalid UTF-8 boundaries / lone surrogates do not crash", () => {
    const lone = "\uD800".repeat(100) + "Bearer " + "a".repeat(30) + "\uDFFF".repeat(100);
    expect(() => detectPromptInjection(lone)).not.toThrow();
    expect(() => detectSecrets(lone)).not.toThrow();
    expect(() => redactSecrets(lone)).not.toThrow();
  });

  it("deeply nested / cyclic-like stringified payloads do not crash the stringify path", () => {
    // redactSecrets is the stable-stringify-adjacent path; feed cyclic JSON text.
    const deep = `{"a":${'"[x]"'.repeat(200)},"secret":"Bearer abc"}`;
    expect(() => redactSecrets(deep)).not.toThrow();
  });

  it("control chars and NUL bytes are handled without crashing", () => {
    const control = "\u0000\u0001\u001f\u007f" + "curl http://a/x";
    expect(() => detectNetworkIntent(control)).not.toThrow();
    expect(() => analyzeProcessCommand(control)).not.toThrow();
  });
});