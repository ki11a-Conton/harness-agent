import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  errorInfo,
  newAgentId,
  newApprovalId,
  newEventId,
  newMemoryId,
  newMessageId,
  newProcessId,
  newRunId,
  newSessionId,
  newSkillId,
  newToolCallId,
  newTraceId,
  newTurnId,
} from "./index.js";
import { EVENT_TYPES } from "./event.js";

const SRC = join(import.meta.dirname);

describe("ids", () => {
  it("produces stable opaque prefixed IDs", () => {
    expect(newSessionId()).toMatch(/^session_/);
    expect(newTurnId()).toMatch(/^turn_/);
    expect(newMessageId()).toMatch(/^message_/);
    expect(newToolCallId()).toMatch(/^toolcall_/);
    expect(newApprovalId()).toMatch(/^approval_/);
    expect(newEventId()).toMatch(/^event_/);
    expect(newRunId()).toMatch(/^run_/);
    expect(newMemoryId()).toMatch(/^memory_/);
    expect(newSkillId()).toMatch(/^skill_/);
    expect(newAgentId()).toMatch(/^agent_/);
    expect(newProcessId()).toMatch(/^proc_/);
    expect(newTraceId()).toMatch(/^trace_/);
  });

  it("never collides", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = newEventId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe("errors", () => {
  it("applies retry defaults per failure class", () => {
    expect(errorInfo("PERMISSION_DENIED").retryable).toBe(false);
    expect(errorInfo("NETWORK_ERROR").safeToRetry).toBe(true);
    expect(errorInfo("MODEL_ERROR").retryable).toBe(true);
    expect(errorInfo("PROCESS_TIMEOUT").safeToRetry).toBe(false);
    expect(errorInfo("SECURITY_DENIED").retryable).toBe(false);
    expect(errorInfo("SECURITY_DENIED").safeToRetry).toBe(false);
  });

  it("carries custom message and overrides", () => {
    const e = errorInfo("TOOL_SCHEMA_ERROR", "bad args", { evidence: "x" });
    expect(e.message).toBe("bad args");
    expect(e.evidence).toBe("x");
  });
});

describe("event types", () => {
  it("includes security.injection_denied", () => {
    expect(EVENT_TYPES).toContain("security.injection_denied");
    expect(EVENT_TYPES).toContain("security.network_denied");
    expect(EVENT_TYPES).toContain("security.permission_denied");
    expect(EVENT_TYPES).toContain("security.filesystem_denied");
    expect(EVENT_TYPES).toContain("security.process_denied");
    expect(EVENT_TYPES).toContain("security.secret_redacted");
  });
});

describe("contracts purity", () => {
  it("contains no forbidden imports (no core/UI/providers/filesystem deps)", () => {
    const srcFiles = readdirSync(SRC, { recursive: true }) as string[];
    const sources = srcFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of sources) {
      const text = readFileSync(join(SRC, file), "utf8");
      const forbidden = ["@ar/core", "@ar/model", "@ar/tools", "@ar/security", "node:fs", "zod/"];
      for (const f of forbidden) {
        expect(text, `${file} must not import ${f}`).not.toContain(f);
      }
    }
  });

  it("has no circular relative imports", () => {
    const files = new Set(
      (readdirSync(SRC, { recursive: true }) as string[])
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")),
    );
    const moduleImports = new Map<string, Set<string>>();
    for (const file of files) {
      const text = readFileSync(join(SRC, file), "utf8");
      const imports = new Set<string>();
      for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const target = m[1]!.replace(/\.js$/, "").replace(/^\.\//, "");
        const resolved = `${target}.ts`;
        if (files.has(resolved)) imports.add(resolved);
      }
      moduleImports.set(file, imports);
    }

    const WHITE = "WHITE";
    const GRAY = "GRAY";
    const BLACK = "BLACK";
    const color = new Map<string, string>();
    const cycleNodes = new Set<string>();

    function dfs(node: string): void {
      color.set(node, GRAY);
      for (const next of moduleImports.get(node) ?? []) {
        const c = color.get(next);
        if (c === GRAY) {
          cycleNodes.add(next);
        } else if (c === WHITE) {
          dfs(next);
        }
      }
      color.set(node, BLACK);
    }

    for (const f of files) {
      if ((color.get(f) ?? WHITE) === WHITE) dfs(f);
    }

    expect([...cycleNodes], "circular imports detected").toEqual([]);
  });
});