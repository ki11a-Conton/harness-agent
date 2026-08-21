/**
 * §134 component inventory: which packages exist, what they depend on, and
 * whether they carry tests. Read-only — inventory is the input to harness
 * evolution proposals, never mutated here.
 */
export interface ComponentInventory {
    /** package name from package.json (e.g. "@ar/contracts"). */
    name: string;
    /** absolute path of the package directory. */
    path: string;
    /** version from package.json; "" when the manifest declares none. */
    version: string;
    /** sorted unique dependency names across dependencies/devDependencies/peerDependencies. */
    deps: string[];
    /** true when src/**\/*.test.ts exists (recursive). */
    hasTests: boolean;
}
export interface InventorySummary {
    total: number;
    withTests: number;
    dependencyEdges: number;
    packagesWithoutTests: string[];
}
/**
 * Scan every direct subdirectory of `packagesRoot` that contains a parseable
 * package.json with a non-empty string name. Non-package entries (files,
 * dirs without a manifest, unparseable manifests) are skipped. A missing or
 * unreadable root yields an empty inventory — never a throw. Results are
 * sorted by name for determinism.
 */
export declare function scanWorkspace(deps: {
    packagesRoot: string;
}): Promise<ComponentInventory[]>;
/** §134 summary rollup over an inventory. `dependencyEdges` = Σ deps.length. */
export declare function summarize(inventory: ComponentInventory[]): InventorySummary;
//# sourceMappingURL=inventory.d.ts.map