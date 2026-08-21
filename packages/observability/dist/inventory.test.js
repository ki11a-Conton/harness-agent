import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanWorkspace, summarize } from "./inventory.js";
const PACKAGES_ROOT = join(process.cwd(), "packages");
const tempRoots = [];
afterEach(async () => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        await rm(root, { recursive: true, force: true });
    }
});
async function makeTempRoot() {
    const root = await mkdtemp(join(tmpdir(), "harness-inventory-"));
    tempRoots.push(root);
    return root;
}
async function makePackage(root, name, manifest, testFile) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.2.3", ...manifest }), "utf8");
    if (testFile !== undefined) {
        const file = join(dir, testFile);
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "import { it } from 'vitest'; it('x', () => {});\n", "utf8");
    }
}
describe("scanWorkspace", () => {
    it("scans the real packages/ directory: non-empty, well-shaped entries", async () => {
        const inventory = await scanWorkspace({ packagesRoot: PACKAGES_ROOT });
        expect(inventory.length).toBeGreaterThan(0);
        for (const component of inventory) {
            expect(typeof component.name).toBe("string");
            expect(component.name.length).toBeGreaterThan(0);
            expect(typeof component.path).toBe("string");
            expect(typeof component.version).toBe("string");
            expect(Array.isArray(component.deps)).toBe(true);
            for (const dep of component.deps)
                expect(typeof dep).toBe("string");
            expect(typeof component.hasTests).toBe("boolean");
        }
    });
    it("finds @ar/contracts with version, deps and tests", async () => {
        const inventory = await scanWorkspace({ packagesRoot: PACKAGES_ROOT });
        const contracts = inventory.find((c) => c.name === "@ar/contracts");
        expect(contracts).toBeDefined();
        expect(contracts.version).toBe("0.1.0");
        expect(contracts.path).toBe(join(PACKAGES_ROOT, "contracts"));
        expect(contracts.hasTests).toBe(true);
        expect(contracts.deps).toContain("zod");
    });
    it("is deterministic: two scans produce identical inventories", async () => {
        const first = await scanWorkspace({ packagesRoot: PACKAGES_ROOT });
        const second = await scanWorkspace({ packagesRoot: PACKAGES_ROOT });
        expect(second).toEqual(first);
    });
    it("returns an empty inventory for a non-existent root", async () => {
        const inventory = await scanWorkspace({
            packagesRoot: join(PACKAGES_ROOT, "does-not-exist"),
        });
        expect(inventory).toEqual([]);
    });
    it("skips stray files, manifest-less dirs, and merges dep fields, sorted by name", async () => {
        const root = await makeTempRoot();
        await writeFile(join(root, "stray-file.json"), "{}", "utf8");
        await mkdir(join(root, "no-manifest"), { recursive: true });
        await makePackage(root, "z-lib", {
            dependencies: { "dep-b": "^1.0.0", "dep-a": "^2.0.0" },
            devDependencies: { "dep-a": "^2.1.0", "dep-c": "^3.0.0" },
        }, "src/z.test.ts");
        await makePackage(root, "a-lib", {}, "src/nested/util.test.ts");
        await makePackage(root, "m-lib", {}, undefined);
        const inventory = await scanWorkspace({ packagesRoot: root });
        expect(inventory.map((c) => c.name)).toEqual(["a-lib", "m-lib", "z-lib"]);
        const a = inventory.find((c) => c.name === "a-lib");
        expect(a.hasTests).toBe(true);
        expect(a.version).toBe("1.2.3");
        expect(a.path).toBe(join(root, "a-lib"));
        const z = inventory.find((c) => c.name === "z-lib");
        expect(z.hasTests).toBe(true);
        expect(z.deps).toEqual(["dep-a", "dep-b", "dep-c"]);
        const m = inventory.find((c) => c.name === "m-lib");
        expect(m.hasTests).toBe(false);
        expect(m.deps).toEqual([]);
    });
    it("skips packages with an unparseable package.json", async () => {
        const root = await makeTempRoot();
        await mkdir(join(root, "broken"), { recursive: true });
        await writeFile(join(root, "broken", "package.json"), "{ not json", "utf8");
        const inventory = await scanWorkspace({ packagesRoot: root });
        expect(inventory).toEqual([]);
    });
});
describe("summarize", () => {
    it("rolls up the real scan consistently", async () => {
        const inventory = await scanWorkspace({ packagesRoot: PACKAGES_ROOT });
        const summary = summarize(inventory);
        expect(summary.total).toBe(inventory.length);
        expect(summary.withTests).toBe(inventory.filter((c) => c.hasTests).length);
        expect(summary.dependencyEdges).toBe(inventory.reduce((sum, c) => sum + c.deps.length, 0));
        expect(summary.packagesWithoutTests).toEqual(inventory.filter((c) => !c.hasTests).map((c) => c.name));
        expect(summary.packagesWithoutTests).not.toContain("@ar/contracts");
    });
    it("handles an empty inventory with honest zeros", () => {
        const empty = [];
        const summary = summarize(empty);
        expect(summary).toEqual({
            total: 0,
            withTests: 0,
            dependencyEdges: 0,
            packagesWithoutTests: [],
        });
    });
});
//# sourceMappingURL=inventory.test.js.map