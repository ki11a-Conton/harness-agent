import { describe, expect, it, afterAll } from "vitest";
import { CaseMiningError, defaultExpectedStatus, freezeCase, mineCandidate, minimizeFixture, MIN_FIXTURE_MAX_BYTES, sanitizeFailure, writeFrozenCase, } from "./mining.js";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
const T0 = "2026-08-19T00:00:00.000Z";
function confirmedFailure(over = {}) {
    return {
        id: "SVC-99",
        task: "The build failed mysteriously; find out why.",
        fixture: {
            "src/index.ts": "export const greet = () => 1;",
            "README.md": "harness project buffer",
            ".env": "OPENAI_KEY=sk-0123456789abcdefghijklmnopqrst",
            "notes.txt": "",
        },
        humanConfirmed: true,
        ...over,
    };
}
describe("sanitizeFailure (P2-11 step 1)", () => {
    it("redacts secrets in task and fixture; keeps labeled secrets redacted, removes pure-secret files", () => {
        const r = sanitizeFailure("use key sk-0123456789abcdefghijklmnopqrst", {
            ".env": "OPENAI_KEY=sk-99887766554433221100zzzzyyyy",
            "credentials/private.pem": "-----BEGIN RSA PRIVATE KEY-----\nabc123body\n-----END RSA PRIVATE KEY-----",
            "keep.txt": "hello world",
        });
        expect(r.task).not.toContain("sk-0123456789abcdef");
        expect(r.report.sawSecret).toBe(true);
        expect(r.report.secretTypes).toContain("openai-key");
        expect(r.report.secretTypes).toContain("private-key");
        // A labeled secret (.env) is kept with its value redacted — structure survives.
        expect(r.fixture[".env"]).toBe("OPENAI_KEY=[redacted]");
        // No live secret value anywhere.
        expect(JSON.stringify(r)).not.toContain("sk-0033600");
    });
    it("fully removes a file that is pure secret material (no surrounding structure)", () => {
        const r = sanitizeFailure("task", {
            "credentials/key.txt": "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
        });
        expect(r.report.fullyRemovedFiles).toEqual(["credentials/key.txt"]);
        expect(r.fixture["credentials/key.txt"]).toBeUndefined();
        expect(r.report.remainingSecret).toEqual([]);
    });
    it("records redaction spans and locations", () => {
        const r = sanitizeFailure("Bearer abcdefghijklmnopqrstuvwxyz", {
            "a.txt": "token ghp_0123456789abcdefghijklmnopqrstuvwxyz",
        });
        expect(r.report.redactedSpans).toBeGreaterThan(0);
        expect(r.report.locations).toEqual(expect.arrayContaining(["task", "a.txt"]));
    });
    it("flags a custom project secret that survives standard redaction", () => {
        const r = sanitizeFailure("connect to svc with pfx-XYZ9secret", {}, [
            /pfx-[A-Za-z0-9]{8,}/,
        ]);
        expect(r.report.remainingSecret.length).toBeGreaterThan(0);
    });
    it("leaves a fully-empty file untouched (not a secret)", () => {
        const r = sanitizeFailure("task", { "empty.txt": "" });
        expect(r.fixture["empty.txt"]).toBe("");
        expect(r.report.fullyRemovedFiles).toEqual([]);
        expect(r.report.remainingSecret).toEqual([]);
    });
});
describe("minimizeFixture (P2-11 step 2)", () => {
    it("drops empty and exact-duplicate files, keeps the rest", () => {
        const r = minimizeFixture({
            "a.txt": "same content here",
            "b.txt": "same content here",
            "empty.txt": "   ",
            "c.txt": "unique",
        });
        expect(r.fixture).toEqual({ "a.txt": "same content here", "c.txt": "unique" });
        expect(r.report.dropped).toEqual(expect.arrayContaining([
            { path: "b.txt", reason: "duplicate" },
            { path: "empty.txt", reason: "empty-file" },
        ]));
        expect(r.report.overBudget).toBe(false);
    });
    it("trims whole largest files while over budget, and flags only when truly stuck", () => {
        const big = "x".repeat(1_000);
        const r = minimizeFixture({
            "big-1.log": big,
            "big-2.log": "y".repeat(900),
            "small.txt": "tiny",
        }, 1_500);
        // 1904 bytes total → dropping one large file lands at 904 ≤ 1500.
        expect(r.report.outputBytes).toBeLessThanOrEqual(1_500);
        expect(r.report.overBudget).toBe(false);
        expect(r.report.dropped.some((d) => d.reason === "over-budget-trim")).toBe(true);
    });
    it("sets overBudget when even dropping all non-empty files cannot fit the budget", () => {
        const r = minimizeFixture({ "huge.txt": "z".repeat(5_000) }, 1_000);
        expect(r.report.overBudget).toBe(true);
    });
    it("never edits file contents in place", () => {
        const r = minimizeFixture({ "a.txt": "content", "b.txt": "" });
        expect(r.fixture["a.txt"]).toBe("content");
    });
});
describe("defaultExpectedStatus", () => {
    it("maps denial/security tags to denied, otherwise failed, never completed", () => {
        expect(defaultExpectedStatus(["injection"])).toBe("denied");
        expect(defaultExpectedStatus(["path-traversal"])).toBe("denied");
        expect(defaultExpectedStatus(["regression", "latency"])).toBe("failed");
        expect(defaultExpectedStatus([])).toBe("failed");
    });
});
describe("mineCandidate (P2-11 step 3 + gates)", () => {
    it("throws when the failure is not human-confirmed", () => {
        expect(() => mineCandidate(confirmedFailure({ humanConfirmed: false }))).toThrow(CaseMiningError);
    });
    it("throws when a secret survives redaction (forbids saving a secret workspace)", () => {
        const f = confirmedFailure();
        f.fixture["vault.txt"] = "plaintext pfx-AABBCCDDEEFF";
        expect(() => mineCandidate(f, { customSecretPatterns: [/pfx-[A-Za-z0-9]{8,}/] })).toThrow(/still contains secret/i);
    });
    it("redacts + minimizes + derives id and default expected status", () => {
        const c = mineCandidate(confirmedFailure({ tags: ["injection", "prod"] }), { now: () => Date.parse(T0) });
        expect(c.id).toMatch(/^mine-svc-99-[0-9a-f]{8}$/);
        expect(c.task).not.toContain("sk-");
        // .env kept but redacted; notes.txt (empty) minimized away.
        expect(c.fixture[".env"]).toBe("OPENAI_KEY=[redacted]");
        expect(c.fixture["notes.txt"]).toBeUndefined();
        expect(c.fixture["README.md"]).toBe("harness project buffer");
        expect(c.provenance.sourceFailureId).toBe("SVC-99");
        expect(c.provenance.humanConfirmed).toBe(true);
        expect(c.provenance.sanitization.remainingSecret).toEqual([]);
    });
    it("respects an explicit expected status and passes through forbidden + verification", () => {
        const c = mineCandidate(confirmedFailure(), {
            expectedStatus: "completed",
            forbidden: { network: true, commands: ["rm -rf"], reads: ["/etc/passwd"] },
            verification: [{ kind: "artifact", path: "out.txt", mustChange: true }],
        });
        expect(c.expected.status).toBe("completed");
        expect(c.forbidden?.network).toBe(true);
        expect(c.verification).toHaveLength(1);
    });
    it("uses explicit tags over failure tags, de-duplicated", () => {
        const c = mineCandidate(confirmedFailure({ tags: ["injection", "shared"] }), {
            tags: ["shared", "harness"],
            now: () => Date.parse(T0),
        });
        expect(c.tags).toEqual(expect.arrayContaining(["injection", "harness", "shared"]));
        expect(c.expected.status).toBe("denied"); // injected tag → denied
    });
});
describe("freezeCase (P2-11 step 4)", () => {
    it("pins the judge version on a clean candidate", () => {
        const c = mineCandidate(confirmedFailure(), { now: () => Date.parse(T0) });
        const frozen = freezeCase(c, "2.0.0");
        expect(frozen.judgeVersion).toBe("2.0.0");
        expect(frozen.provenance.judgeVersion).toBe("2.0.0");
        expect(frozen.provenance.frozen).toBe(true);
    });
    it("refuses to freeze an over-budget fixture", () => {
        const c = mineCandidate(confirmedFailure({ fixture: { "huge.txt": "z".repeat(50_000) } }), { maxBytes: 1_000, now: () => Date.parse(T0) });
        expect(c.provenance.minimization.overBudget).toBe(true);
        expect(() => freezeCase(c, "2.0.0")).toThrow(CaseMiningError);
    });
    it("refuses to freeze a case whose secret survives", () => {
        const c = mineCandidate(confirmedFailure(), { now: () => Date.parse(T0) });
        c.provenance.sanitization.remainingSecret = ["leak"];
        expect(() => freezeCase(c, "2.0.0")).toThrow(CaseMiningError);
    });
});
describe("writeFrozenCase (layout)", () => {
    it("writes request.md / expected.md / case.json / fixture under suite/id", async () => {
        const outDir = join(process.cwd(), ".tmp-mining-test");
        const c = mineCandidate(confirmedFailure({
            fixture: { "src/index.ts": "export const a = 1;", ".env": "K=sk-abcdefghijklmnopqrstuvwxyz" },
        }), { now: () => Date.parse(T0) });
        const frozen = freezeCase(c, "1.0.0");
        const dir = await writeFrozenCase(outDir, frozen);
        const request = await readFile(join(dir, "request.md"), "utf8");
        expect(request).toContain("build failed");
        expect(request).not.toContain("sk-");
        const expected = await readFile(join(dir, "expected.md"), "utf8");
        expect(expected).toContain("Status: failed");
        const caseJson = JSON.parse(await readFile(join(dir, "case.json"), "utf8"));
        expect(caseJson.case.id).toBe(frozen.id);
        expect(caseJson.case.judgeVersion).toBe("1.0.0");
        // No secret survived into the written fixture.
        expect(JSON.stringify(caseJson)).not.toContain("sk-");
        const fixtureStat = await stat(join(dir, "fixture", "src", "index.ts"));
        expect(fixtureStat.isFile()).toBe(true);
    });
    it("refuses a fixture path that escapes the case dir", async () => {
        const c = mineCandidate(confirmedFailure(), { now: () => Date.parse(T0) });
        const bad = { ...c, fixture: { ...c.fixture, "../evil.txt": "x" } };
        const frozen = freezeCase(bad, "1.0.0");
        await expect(writeFrozenCase(".tmp-mining-escape", frozen)).rejects.toThrow(CaseMiningError);
    });
});
afterAll(async () => {
    await rm(join(process.cwd(), ".tmp-mining-test"), { recursive: true, force: true }).catch(() => { });
    await rm(join(process.cwd(), ".tmp-mining-escape"), { recursive: true, force: true }).catch(() => { });
});
//# sourceMappingURL=mining.test.js.map