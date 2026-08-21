import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Deterministic digest of champion state (stable key order). */
export function championDigest(state) {
    return JSON.stringify(sortKeys(state));
}
function sortKeys(value) {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
        const record = value;
        const out = {};
        for (const key of Object.keys(record).sort())
            out[key] = sortKeys(record[key]);
        return out;
    }
    return value;
}
export class CandidateSandbox {
    scratchRoot;
    now;
    constructor(deps = {}) {
        this.scratchRoot = deps.scratchRoot ?? tmpdir();
        this.now = deps.now ?? Date.now;
    }
    /**
     * Run the candidate in isolation: scratch dir → champion snapshot →
     * runner → champion re-check → cleanup. Cleanup and the mutation check
     * run even when the runner throws; the error is re-thrown afterwards.
     */
    async run(deps) {
        const started = this.now();
        const scratchDir = await mkdtemp(join(this.scratchRoot, "candidate-"));
        // Always digest the RESOLVED value — an async championState returning a
        // Promise must not be digested as "{}" (which would blind the mutation
        // check). Await before digesting.
        const digestOf = async (produce) => championDigest(await produce());
        const before = await digestOf(deps.championState);
        const violations = [];
        let result;
        let error;
        let threw = false;
        const ctx = {
            candidate: deps.candidate,
            scratchDir,
            readChampion: () => deps.championState(),
            writeScratch: async (relPath, content) => {
                if (relPath.includes("..") || relPath.startsWith("/") || /^[a-z]:[\\/]/i.test(relPath)) {
                    throw new Error(`sandbox: scratch path escapes the sandbox: ${relPath}`);
                }
                const target = join(scratchDir, relPath);
                await writeFile(target, content, "utf8");
                return target;
            },
        };
        try {
            result = await deps.runner(ctx);
        }
        catch (cause) {
            threw = true;
            error = cause;
            violations.push({ kind: "throw", detail: errorMessage(cause) });
        }
        try {
            const after = await digestOf(deps.championState);
            if (after !== before) {
                violations.push({ kind: "champion_mutation", detail: "champion state changed during the candidate run" });
            }
        }
        catch (cause) {
            violations.push({ kind: "champion_mutation", detail: `champion re-read failed: ${errorMessage(cause)}` });
        }
        await rm(scratchDir, { recursive: true, force: true });
        if (threw)
            throw error;
        return { result, violations, elapsedMs: this.now() - started, threw: false };
    }
}
function errorMessage(e) {
    return e instanceof Error ? e.message : String(e);
}
//# sourceMappingURL=sandbox.js.map