import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverCommands, summarize } from "@ar/tools";
export class CommandDiscoveryService {
    dataDir;
    now;
    hintsByRoot = new Map();
    constructor(deps = {}) {
        this.dataDir = deps.dataDir;
        this.now = deps.now ?? Date.now;
    }
    /** Discover once per workspace root; subsequent calls are cache hits. */
    async maybeDiscover(cwd) {
        const cached = this.hintsByRoot.get(cwd);
        if (cached !== undefined)
            return cached;
        let result;
        try {
            result = await discoverCommands(cwd);
        }
        catch {
            return undefined; // non-repo cwd / unreadable → no hints
        }
        if (result.discovered.length === 0)
            return undefined;
        const hints = {
            cwd,
            commands: summarize(result.discovered),
            summary: summarize(result.discovered),
            discoveredAt: this.now(),
        };
        this.hintsByRoot.set(cwd, hints);
        await this.persist(hints).catch(() => { });
        return hints;
    }
    /** P7-6: fire on the first code-changing turn (filesChanged non-empty). */
    async onCodeChange(cwd, filesChanged) {
        if (filesChanged.length === 0 || this.hintsByRoot.has(cwd))
            return this.hintsByRoot.get(cwd);
        return this.maybeDiscover(cwd);
    }
    hints(cwd) {
        return this.hintsByRoot.get(cwd);
    }
    /** Format hints for injection into importantFacts (working state). */
    toImportantFacts(hints) {
        const facts = [];
        const { test, typecheck, build } = hints.summary;
        if (test !== undefined)
            facts.push(`test command: ${test}`);
        if (typecheck !== undefined)
            facts.push(`typecheck: ${typecheck}`);
        if (build !== undefined)
            facts.push(`build: ${build}`);
        return facts;
    }
    async persist(hints) {
        if (this.dataDir === undefined)
            return;
        const file = join(this.dataDir, "command-hints.jsonl");
        await mkdir(this.dataDir, { recursive: true });
        await writeFile(file, JSON.stringify(hints) + "\n", { encoding: "utf8", flag: "a" });
    }
    /** Load hints persisted by an earlier process (startup warm-up). */
    async loadPersisted() {
        if (this.dataDir === undefined)
            return;
        let content;
        try {
            content = await readFile(join(this.dataDir, "command-hints.jsonl"), "utf8");
        }
        catch {
            return;
        }
        for (const line of content.split("\n")) {
            if (line.trim() === "")
                continue;
            try {
                const hints = JSON.parse(line);
                this.hintsByRoot.set(hints.cwd, hints);
            }
            catch {
                // corrupt line: skip
            }
        }
    }
}
//# sourceMappingURL=command-discovery-service.js.map