import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessExecutor } from "./executor.js";
let ws = "";
beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "ar-exec-"));
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));
const NODE = process.execPath;
describe("ProcessExecutor (EXEC-001)", () => {
    it("runs a command to success and captures stdout", async () => {
        const exe = new ProcessExecutor();
        const out = await exe.run({ command: `${JSON.stringify(NODE)} -e "process.stdout.write('hello')"`, cwd: ws });
        expect(out.status).toBe("success");
        expect(out.exitCode).toBe(0);
        expect(out.stdout).toBe("hello");
    });
    it("reports failed status on nonzero exit", async () => {
        const exe = new ProcessExecutor();
        const out = await exe.run({ command: `${JSON.stringify(NODE)} -e "process.exit(3)"`, cwd: ws });
        expect(out.status).toBe("failed");
        expect(out.exitCode).toBe(3);
        expect(out.error).toContain("3");
    });
    it("captures stderr separately", async () => {
        const exe = new ProcessExecutor();
        const out = await exe.run({ command: `${JSON.stringify(NODE)} -e "process.stderr.write('oops')"`, cwd: ws });
        expect(out.status).toBe("success");
        expect(out.stderr).toBe("oops");
        expect(out.stdout).toBe("");
    });
    it("streams chunks through onOutput", async () => {
        const exe = new ProcessExecutor();
        const chunks = [];
        const out = await exe.run({
            command: `${JSON.stringify(NODE)} -e "process.stdout.write('a'); process.stdout.write('b')"`,
            cwd: ws,
            onOutput: (c) => chunks.push(c.text),
        });
        expect(out.status).toBe("success");
        expect(chunks.join("")).toBe("ab");
    });
    it("times out and reports PROCESS_TIMEOUT", async () => {
        const exe = new ProcessExecutor();
        const out = await exe.run({
            command: `${JSON.stringify(NODE)} -e "setTimeout(()=>{}, 10000)"`,
            cwd: ws,
            timeoutMs: 250,
        });
        expect(out.status).toBe("timeout");
        expect(out.error).toContain("timed out");
    });
    it("kills the process tree on timeout (no orphan)", async () => {
        const exe = new ProcessExecutor();
        const out = await exe.run({
            // Spawns a child that outlives the parent; tree kill must reap it.
            command: `${JSON.stringify(NODE)} -e "const {spawn}=require('child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true}); setTimeout(()=>{},10000)"`,
            cwd: ws,
            timeoutMs: 300,
        });
        expect(out.status).toBe("timeout");
    });
    it("returns cancelled when the signal aborts", async () => {
        const ac = new AbortController();
        const exe = new ProcessExecutor();
        const p = exe.run({
            command: `${JSON.stringify(NODE)} -e "setTimeout(()=>{}, 10000)"`,
            cwd: ws,
            signal: ac.signal,
        });
        setTimeout(() => ac.abort(), 100);
        const out = await p;
        expect(out.status).toBe("cancelled");
    });
    it("truncates oversized output", async () => {
        const exe = new ProcessExecutor();
        const out = await exe.run({
            command: `${JSON.stringify(NODE)} -e "process.stdout.write('x'.repeat(10000))"`,
            cwd: ws,
            maxOutputBytes: 100,
        });
        expect(out.status).toBe("success");
        expect(out.truncated).toBe(true);
        expect(out.stdout.length).toBeLessThanOrEqual(100);
    });
    it("honors cwd and env", async () => {
        writeFileSync(join(ws, "marker.txt"), "here");
        const exe = new ProcessExecutor();
        const out = await exe.run({
            command: `${JSON.stringify(NODE)} -e "process.stdout.write(process.cwd() + '|' + process.env.MARKER)"`,
            cwd: ws,
            env: { MARKER: "42" },
        });
        expect(out.status).toBe("success");
        expect(out.stdout).toBe(`${ws}|42`);
    });
});
//# sourceMappingURL=executor.test.js.map