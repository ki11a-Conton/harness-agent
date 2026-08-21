import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newWorkingState } from "@ar/contracts";
import { discoverCommands, mergeIntoWorkingState, parseCiRuns, summarize, } from "./command-discovery.js";
let ws = "";
function write(file, content) {
    const abs = join(ws, file);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")) || ws, { recursive: true });
    writeFileSync(abs, content, "utf8");
}
beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "ar-cmd-"));
    write("package.json", JSON.stringify({
        name: "root",
        scripts: { test: "vitest run", "test:unit": "vitest run unit", build: "tsc -b", lint: "eslint .", typecheck: "tsc --noEmit" },
    }));
    write("packages/app/package.json", JSON.stringify({ name: "app", scripts: { test: "jest" } }));
    write("packages/util/package.json", JSON.stringify({ name: "util", scripts: { "test:unit": "vitest run util" } }));
    write("node_modules/skip/package.json", JSON.stringify({ name: "skip", scripts: { test: "echo skip" } }));
    write("pyproject.toml", "[project]\nname = \"demo\"\n");
    write("Cargo.toml", "[package]\nname = \"core\"\n");
    write("Makefile", "test:\n\tnpm test\n\nbuild:\n\tnpm run build\n\nlint:\n\tnpx eslint .\n");
    write("AGENTS.md", "Run tests with `yarn test` before committing.\nUse `npm run build` to build.\n");
    write(".github/workflows/ci.yml", "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n");
});
afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
});
describe("P2-31 discoverCommands sources", () => {
    it("discovers high-confidence commands from package.json (root + workspaces)", async () => {
        const res = await discoverCommands(ws);
        const pkgs = res.discovered.filter((d) => d.source === "package.json");
        // test + test:unit from root, build, lint, typecheck
        expect(pkgs.some((d) => d.kind === "test" && d.command === "vitest run" && d.confidence === "high")).toBe(true);
        expect(pkgs.some((d) => d.kind === "build" && d.command === "tsc -b")).toBe(true);
        expect(pkgs.some((d) => d.kind === "lint" && d.command === "eslint .")).toBe(true);
        expect(pkgs.some((d) => d.kind === "typecheck" && d.command === "tsc --noEmit")).toBe(true);
        // workspace manifests included
        expect(pkgs.some((d) => d.file === "packages/app/package.json" && d.command === "jest")).toBe(true);
        expect(pkgs.some((d) => d.file === "packages/util/package.json")).toBe(true);
        // node_modules skipped
        expect(pkgs.some((d) => d.file.includes("node_modules"))).toBe(false);
    });
    it("discovers pyproject / Cargo.toml defaults", async () => {
        const res = await discoverCommands(ws);
        expect(res.discovered.some((d) => d.kind === "test" && d.command === "pytest" && d.source === "pyproject")).toBe(true);
        expect(res.discovered.some((d) => d.kind === "test" && d.command === "cargo test" && d.source === "Cargo.toml")).toBe(true);
    });
    it("discovers Makefile targets with their recipes", async () => {
        const res = await discoverCommands(ws);
        const mk = res.discovered.filter((d) => d.source === "Makefile");
        expect(mk.some((d) => d.kind === "test" && d.command === "npm test")).toBe(true);
        expect(mk.some((d) => d.kind === "build" && d.command === "npm run build")).toBe(true);
        expect(mk.some((d) => d.kind === "lint")).toBe(true);
    });
    it("discovers test command from CI run steps", async () => {
        const res = await discoverCommands(ws);
        const ci = res.discovered.filter((d) => d.source === "CI");
        expect(ci.some((d) => d.kind === "test" && d.command === "npm test")).toBe(true);
    });
    it("discovers low-confidence commands from AGENTS.md guidance", async () => {
        const res = await discoverCommands(ws);
        const ag = res.discovered.filter((d) => d.source === "AGENTS.md");
        expect(ag.some((d) => d.kind === "test" && d.confidence === "low" && d.command.includes("yarn test"))).toBe(true);
    });
    it("records the source files it checked", async () => {
        const res = await discoverCommands(ws);
        for (const f of ["package.json", "packages/app/package.json", "pyproject.toml", "Cargo.toml", "Makefile", "AGENTS.md", ".github/workflows/ci.yml"]) {
            expect(res.sourceFilesChecked).toContain(f);
        }
    });
});
describe("P2-31 summarize picks strongest per kind", () => {
    it("prefers high-confidence and package.json sources", async () => {
        const res = await discoverCommands(ws);
        const summary = summarize(res.discovered);
        expect(summary.test).toBe("vitest run"); // root package.json high-confidence
        expect(summary.build).toBe("tsc -b");
        expect(summary.lint).toBe("eslint .");
        expect(summary.typecheck).toBe("tsc --noEmit");
    });
});
describe("P2-31 mergeIntoWorkingState writes importantFacts", () => {
    it("records discovered commands + sources into WorkingState", async () => {
        const res = await discoverCommands(ws);
        const state = newWorkingState("run tests");
        mergeIntoWorkingState(state, res);
        expect(state.importantFacts.some((f) => f === "discovered test command: vitest run (".concat(res.root, ")"))).toBe(true);
        expect(state.importantFacts.some((f) => f === "discovered build command: tsc -b (".concat(res.root, ")"))).toBe(true);
        expect(state.importantFacts.some((f) => f.startsWith("command discovery sources:"))).toBe(true);
    });
    it("is idempotent (does not duplicate on merge twice)", async () => {
        const res = await discoverCommands(ws);
        const state = newWorkingState("run tests");
        mergeIntoWorkingState(state, res);
        const countBefore = state.importantFacts.length;
        mergeIntoWorkingState(state, res);
        expect(state.importantFacts.length).toBe(countBefore);
    });
});
describe("P2-30+ CI multi-line YAML completeness", () => {
    const kinds = (r) => r.map((d) => `${d.kind}:${d.command}`);
    it("parses a literal `|` block of multiple run lines", () => {
        const y = "jobs:\n  test:\n    steps:\n      - run: |\n          npm test\n          npm run typecheck\n";
        const r = parseCiRuns(y, "ci.yml");
        expect(kinds(r)).toContain("test:npm test");
        expect(kinds(r)).toContain("typecheck:npm run typecheck");
    });
    it("handles `|-` chomping and an env: key before run", () => {
        const y = "steps:\n  - name: lint\n    env:\n      CI: 'true'\n    run: |-\n      npm run lint\n";
        const r = parseCiRuns(y, "ci.yml");
        expect(kinds(r)).toContain("lint:npm run lint");
    });
    it("joins a folded `>` block into a single command before segmenting", () => {
        const y = "steps:\n  - run: >\n      npm test &&\n      npm run build\n";
        const r = parseCiRuns(y, "ci.yml");
        expect(kinds(r)).toContain("test:npm test");
        expect(kinds(r)).toContain("build:npm run build");
    });
    it("skips comment lines inside a block and stops at the next step", () => {
        const y = "steps:\n  - run: |\n      npm test\n      # just a comment\n  - run: echo deploy\n";
        const r = parseCiRuns(y, "ci.yml");
        expect(kinds(r)).toContain("test:npm test");
        expect(kinds(r).some((k) => k.includes("echo deploy"))).toBe(false); // no keyword → dropped
    });
    it("stops the block at a document marker and later keys", () => {
        const y = "steps:\n  - run: |\n      npm test\n---\non: [push]\n";
        const r = parseCiRuns(y, "ci.yml");
        expect(kinds(r)).toContain("test:npm test");
    });
});
describe("P2-30+ workspace-scoped command discovery", () => {
    let mono = "";
    beforeAll(() => {
        mono = mkdtempSync(join(tmpdir(), "ar-cmd-mono-"));
        const w = (file, content) => {
            const abs = join(mono, file);
            mkdirSync(abs.slice(0, abs.lastIndexOf("/")) || mono, { recursive: true });
            writeFileSync(abs, content, "utf8");
        };
        w("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
        w("package.json", JSON.stringify({ name: "root" }));
        w("packages/app/package.json", JSON.stringify({ name: "app", scripts: { test: "jest" } }));
        w("packages/other/package.json", JSON.stringify({ name: "other", scripts: { test: "mocha" } }));
        // A manifest OUTSIDE the declared workspace glob must NOT be a boundary.
        w("vendor/package.json", JSON.stringify({ name: "vendor", scripts: { test: "echo vendor" } }));
    });
    afterAll(() => rmSync(mono, { recursive: true, force: true }));
    it("only discovers scripts for workspace members, excluding out-of-glob manifests", async () => {
        const res = await discoverCommands(mono);
        const pkgs = res.discovered.filter((d) => d.source === "package.json");
        expect(pkgs.some((d) => d.file === "packages/app/package.json" && d.command === "jest")).toBe(true);
        expect(pkgs.some((d) => d.file === "packages/other/package.json" && d.command === "mocha")).toBe(true);
        expect(pkgs.some((d) => d.file.includes("vendor"))).toBe(false);
    });
});
//# sourceMappingURL=command-discovery.test.js.map