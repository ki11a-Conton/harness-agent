import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

function dependencyNames(pkg: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const field of DEP_FIELDS) {
    const value = pkg[field];
    if (typeof value !== "object" || value === null) continue;
    for (const key of Object.keys(value as Record<string, unknown>)) names.add(key);
  }
  return [...names].sort();
}

async function hasTestFiles(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (await hasTestFiles(join(dir, entry.name))) return true;
    } else if (entry.name.endsWith(".test.ts")) {
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
export async function scanWorkspace(deps: {
  packagesRoot: string;
}): Promise<ComponentInventory[]> {
  let entries;
  try {
    entries = await readdir(deps.packagesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const components: ComponentInventory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(deps.packagesRoot, entry.name);
    let raw: string;
    try {
      raw = await readFile(join(dir, "package.json"), "utf8");
    } catch {
      continue;
    }
    let pkg: unknown;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof pkg !== "object" || pkg === null) continue;
    const manifest = pkg as Record<string, unknown>;
    const name = typeof manifest.name === "string" ? manifest.name : undefined;
    if (name === undefined || name.length === 0) continue;
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
export function summarize(inventory: ComponentInventory[]): InventorySummary {
  let withTests = 0;
  let dependencyEdges = 0;
  const packagesWithoutTests: string[] = [];
  for (const component of inventory) {
    dependencyEdges += component.deps.length;
    if (component.hasTests) {
      withTests += 1;
    } else {
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
