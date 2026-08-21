import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
const PREFIX = "harness-eval-";
const createdPaths = [];
function tmpRoot() {
    return resolve(tmpdir()) + sep;
}
function isUnderTmp(path) {
    return resolve(path).toLowerCase().startsWith(tmpRoot().toLowerCase());
}
/**
 * Create a temporary workspace for eval fixtures (test-only).
 *
 * Relative keys may contain ".." to place files OUTSIDE the workspace
 * (path-traversal fixtures, e.g. { "../escape.txt": "secret" }). Paths that
 * would escape `os.tmpdir()` are rejected so cleanup() stays safe. All created
 * paths are tracked and removed by cleanup().
 */
export async function makeTempWorkspace(files) {
    const root = await mkdtemp(tmpdir() + sep + PREFIX);
    createdPaths.push(root);
    for (const [rel, content] of Object.entries(files)) {
        const abs = resolve(root, rel);
        if (!isUnderTmp(abs)) {
            throw new Error(`fixture path escapes temp dir: ${abs}`);
        }
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        createdPaths.push(abs);
    }
    return root;
}
/** Remove every fixture workspace (and escaped file) created so far. Idempotent. */
export async function cleanup() {
    for (const path of createdPaths.splice(0)) {
        if (isUnderTmp(path)) {
            await rm(path, { recursive: true, force: true }).catch(() => { });
        }
    }
}
//# sourceMappingURL=fixtures.js.map