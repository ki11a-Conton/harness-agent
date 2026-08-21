import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];
function dependencyNames(pkg) {
    const names = new Set();
    for (const field of DEP_FIELDS) {
        const value = pkg[field];
        if (typeof value !== "object" || value === null)
            continue;
        for (const key of Object.keys(value))
            names.add(key);
    }
    return [...names].sort();
}
async function hasTestFiles(dir) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return false;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (await hasTestFiles(join(dir, entry.name)))
                return true;
        }
        else if (entry.name.endsWith(".test.ts")) {
            return true;
        }
    }
    return false;
}
/**
 * Scan every direct subdirectory of `packagesRoot` that contains a parseable
 * package.json with a non-empty string name. Non-package entries (files,
 * dirs without a manifest, unparseable manifests) are skipped. A missing or
 * unreadable root yields an empty inventory — never a throw. Results are
 * sorted by name for determinism.
 */
export async function scanWorkspace(deps) {
    let entries;
    try {
        entries = await readdir(deps.packagesRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const components = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const dir = join(deps.packagesRoot, entry.name);
        let raw;
        try {
            raw = await readFile(join(dir, "package.json"), "utf8");
        }
        catch {
            continue;
        }
        let pkg;
        try {
            pkg = JSON.parse(raw);
        }
        catch {
            continue;
        }
        if (typeof pkg !== "object" || pkg === null)
            continue;
        const manifest = pkg;
        const name = typeof manifest.name === "string" ? manifest.name : undefined;
        if (name === undefined || name.length === 0)
            continue;
        const version = typeof manifest.version === "string" ? manifest.version : "";
        components.push({
            name,
            path: dir,
            version,
            deps: dependencyNames(manifest),
            hasTests: await hasTestFiles(join(dir, "src")),
        });
    }
    return components.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
/** §134 summary rollup over an inventory. `dependencyEdges` = Σ deps.length. */
export function summarize(inventory) {
    let withTests = 0;
    let dependencyEdges = 0;
    const packagesWithoutTests = [];
    for (const component of inventory) {
        dependencyEdges += component.deps.length;
        if (component.hasTests) {
            withTests += 1;
        }
        else {
            packagesWithoutTests.push(component.name);
        }
    }
    return {
        total: inventory.length,
        withTests,
        dependencyEdges,
        packagesWithoutTests,
    };
}
//# sourceMappingURL=inventory.js.map