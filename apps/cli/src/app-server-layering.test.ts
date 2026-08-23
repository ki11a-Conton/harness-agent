/**
 * P30-5 — CLI architecture guard.
 *
 * After the migration, ordinary CLI execution must NOT import `@ar/core`
 * values. The dependency direction is:
 *
 *   CLI → SDK/AppServerClient → App Server → LoadedSessionManager → Runtime
 *
 * `@ar/core` may still appear in type position (erased at runtime), but a
 * source-level value import in the ordinary user path is a layering
 * violation. The check is a pure static scan over import statements (no
 * module loading), so it runs anywhere.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliSrc = here; // apps/cli/src (this file lives inside it)

/** Admin/benchmark paths that intentionally stand up a runtime for
 *  measurement, plus tests (which construct the real runtime for integration
 *  coverage). Everything else must stay protocol-client-only. */
const ALLOWED_CORE_VALUE_FILES = new Set([
  "benchmark-command.ts",
  "champion-eval.ts",
  "production-audit.ts",
  "audit.ts",
]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(p));
    } else if (entry.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("P30-5 CLI → Server layering", () => {
  it("ordinary execution files do not import @ar/core (value imports forbidden)", () => {
    const files = listTsFiles(cliSrc)
      .filter((p) => !p.endsWith(".test.ts"));
    const violations: string[] = [];
    for (const file of files) {
      const rel = file.slice(cliSrc.length + 1).replace(/\\/g, "/");
      if (ALLOWED_CORE_VALUE_FILES.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      // Strip type-only import lines, which are erased at compile time.
      const withoutTypeOnly = src.replace(
        /import\s+type\s+[\s\S]*?from\s*["']@ar\/core["'];?/g,
        "",
      );
      if (
        withoutTypeOnly.includes('from "@ar/core"') ||
        withoutTypeOnly.includes("from '@ar/core'")
      ) {
        violations.push(rel);
      }
    }
    expect(violations).toEqual([]);
  });

  it("commands.ts exposes only the protocol RPC surface (no runtime handle)", () => {
    const src = readFileSync(join(cliSrc, "commands.ts"), "utf8");
    expect(src).not.toContain("runtime: AgentRuntime");
    expect(src).not.toMatch(/AgentRuntime/);
    expect(src).toContain("rpc: RpcClient");
  });

  it("main.ts builds the sandbox policy from @ar/harness, not @ar/core", () => {
    const src = readFileSync(join(cliSrc, "main.ts"), "utf8");
    expect(src).toContain('from "@ar/harness"');
    expect(src).not.toContain('from "@ar/core"');
  });
});