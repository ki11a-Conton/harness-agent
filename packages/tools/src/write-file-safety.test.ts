import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newAgentId, newSessionId, newTurnId } from "@ar/contracts";
import { writeFileTool } from "./tools/write-file.js";

let ws = "";
const cwdCtx = {
  sessionId: newSessionId(),
  turnId: newTurnId(),
  agentId: newAgentId(),
  cwd: "",
  signal: new AbortController().signal,
};

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "wsafety-"));
  cwdCtx.cwd = ws;
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe("P2-27 write_file write-safety guard", () => {
  it("creates a new file normally", async () => {
    const out = await writeFileTool.execute({ path: "new.txt", content: "hello" }, cwdCtx as never);
    expect(out.status).toBe("success");
    expect(readFileSync(join(ws, "new.txt"), "utf8")).toBe("hello");
  });

  it("appends to an existing large file normally (additive, safe)", async () => {
    writeFileSync(join(ws, "big.log"), "x".repeat(10_000));
    const out = await writeFileTool.execute({ path: "big.log", content: "tail", append: true }, cwdCtx as never);
    expect(out.status).toBe("success");
    expect(readFileSync(join(ws, "big.log"), "utf8").endsWith("tail")).toBe(true);
  });

  it("BLOCKS a destructive overwrite: existing 4KB+ file replaced by a tiny string", async () => {
    const long = "Y".repeat(12_000) + "\nbody\n" + "Z".repeat(12_000);
    writeFileSync(join(ws, "config.dat"), long);
    const out = await writeFileTool.execute({ path: "config.dat", content: "gone" }, cwdCtx as never);
    expect(out.status).toBe("denied");
    expect(out.error?.code).toBe("WRITE_SAFETY_DENIED");
    expect(String(out.error?.message)).toContain("write-safety");
    // the original content is untouched
    expect(readFileSync(join(ws, "config.dat"), "utf8")).toBe(long);
  });

  it("allows a same-size overwrite of an existing large file (no shrink hazard)", async () => {
    const mid = "A".repeat(8000);
    writeFileSync(join(ws, "medium.txt"), mid);
    const out = await writeFileTool.execute({ path: "medium.txt", content: "B".repeat(8000) }, cwdCtx as never);
    expect(out.status).toBe("success");
    expect(readFileSync(join(ws, "medium.txt"), "utf8")).toBe("B".repeat(8000));
  });
});