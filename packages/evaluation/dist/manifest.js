import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { DEFAULT_JUDGE_VERSION } from "./baseline.js";
/** Suite definition version. P0-6 adds the integrity layer (manifest, failure
 *  classification, ordered execution) on top of the Phase 6.5 four-suite split;
 *  bump when the suite definitions or their judging semantics change. */
export const BENCHMARK_SUITE_VERSION = "2.1.0";
/** Best-effort git identity probe. Any failure (no git, not a repo, timeout)
 *  yields `null` — never a fabricated sha. */
export async function buildRunManifest(opts) {
    const gitInfo = opts.gitInfo ?? (await detectGitInfo());
    return {
        gitSha: gitInfo.sha,
        dirty: gitInfo.dirty,
        model: opts.model,
        provider: opts.provider,
        temperature: opts.temperature ?? null,
        suiteVersion: opts.suiteVersion ?? BENCHMARK_SUITE_VERSION,
        judgeVersion: opts.judgeVersion ?? DEFAULT_JUDGE_VERSION,
        runtimeConfigHash: opts.runtimeConfigHash,
        timestamp: opts.timestamp ?? new Date(opts.now?.() ?? Date.now()).toISOString(),
        platform: process.platform,
        nodeVersion: process.version,
    };
}
/**
 * sha256 over a stable serialization of the runtime config. The serialization
 * is key-ordered and value-stable, so the same logical config always hashes
 * the same regardless of key insertion order. Any change to the harness wiring
 * (permissions, sandbox policy, budget, tool set, limits, …) changes the hash,
 * which is exactly the reproducibility signal the manifest needs.
 */
export function computeRuntimeConfigHash(config) {
    return createHash("sha256").update(stableStringify(config)).digest("hex");
}
/** Deterministic key-ordered serialization (Q-5 stable serialization). */
export function stableStringify(value) {
    if (value === undefined)
        return "undefined";
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    if (typeof value === "object" && value !== null) {
        const record = value;
        const keys = Object.keys(record).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
async function detectGitInfo() {
    let sha = "";
    let status = "";
    try {
        sha = await runGit(["rev-parse", "HEAD"]);
        status = await runGit(["status", "--porcelain"]);
    }
    catch {
        return { sha: null, dirty: null };
    }
    if (sha === "")
        return { sha: null, dirty: null };
    return { sha: sha.trim(), dirty: status.trim() !== "" };
}
function runGit(args) {
    return new Promise((resolve) => {
        execFile("git", args, { cwd: process.cwd(), timeout: 5_000, windowsHide: true }, (err, stdout) => {
            resolve(err !== null ? "" : String(stdout));
        });
    });
}
//# sourceMappingURL=manifest.js.map