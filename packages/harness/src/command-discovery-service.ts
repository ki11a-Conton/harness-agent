import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeErrorCode } from "@ar/contracts";
import { discoverCommands, summarize } from "@ar/tools";

/**
 * P7-6: lazy command discovery for code-changing turns. The agent does not
 * have to remember to call discover_commands; the host discovers once per
 * workspace the first time a turn modifies files, and persists the hints
 * (test / typecheck / build commands) for context injection and verification
 * plan building (P8-1). Never runs when there is nothing to discover against.
 */
export interface CommandHints {
  /** Workspace root the hints describe. */
  cwd: string;
  /** command → how to run it (e.g. "test" → "pnpm test"). */
  commands: Record<string, string>;
  /** Summary lines suitable for importantFacts / context injection. */
  summary: Partial<Record<string, string>>;
  discoveredAt: number;
}

export interface CommandDiscoveryServiceDeps {
  dataDir?: string;
  now?: () => number;
}

export class CommandDiscoveryService {
  private readonly dataDir?: string;
  private readonly now: () => number;
  private readonly hintsByRoot = new Map<string, CommandHints>();

  constructor(deps: CommandDiscoveryServiceDeps = {}) {
    this.dataDir = deps.dataDir;
    this.now = deps.now ?? Date.now;
  }

  /** Discover once per workspace root; subsequent calls are cache hits. */
  async maybeDiscover(cwd: string): Promise<CommandHints | undefined> {
    const cached = this.hintsByRoot.get(cwd);
    if (cached !== undefined) return cached;
    let result;
    try {
      result = await discoverCommands(cwd);
    } catch {
      return undefined; // non-repo cwd / unreadable → no hints
    }
    if (result.discovered.length === 0) return undefined;
    const hints: CommandHints = {
      cwd,
      commands: summarize(result.discovered) as Record<string, string>,
      summary: summarize(result.discovered),
      discoveredAt: this.now(),
    };
    this.hintsByRoot.set(cwd, hints);
    // P14-6: persistence is best-effort — a failure is reported, never silent.
    await this.persist(hints).catch((err) =>
      process.stderr.write(`[degraded] command-discovery.persist: ${err instanceof Error ? err.message : String(err)}\n`),
    );
    return hints;
  }

  /** P7-6: fire on the first code-changing turn (filesChanged non-empty). */
  async onCodeChange(cwd: string, filesChanged: readonly string[]): Promise<CommandHints | undefined> {
    if (filesChanged.length === 0 || this.hintsByRoot.has(cwd)) return this.hintsByRoot.get(cwd);
    return this.maybeDiscover(cwd);
  }

  hints(cwd: string): CommandHints | undefined {
    return this.hintsByRoot.get(cwd);
  }

  /** Format hints for injection into importantFacts (working state). */
  toImportantFacts(hints: CommandHints): string[] {
    const facts: string[] = [];
    const { test, typecheck, build } = hints.summary;
    if (test !== undefined) facts.push(`test command: ${test}`);
    if (typecheck !== undefined) facts.push(`typecheck: ${typecheck}`);
    if (build !== undefined) facts.push(`build: ${build}`);
    return facts;
  }

  private async persist(hints: CommandHints): Promise<void> {
    if (this.dataDir === undefined) return;
    const file = join(this.dataDir, "command-hints.jsonl");
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(file, JSON.stringify(hints) + "\n", { encoding: "utf8", flag: "a" });
  }

  /** Load hints persisted by an earlier process (startup warm-up). */
  async loadPersisted(): Promise<void> {
    if (this.dataDir === undefined) return;
    let content: string;
    try {
      content = await readFile(join(this.dataDir, "command-hints.jsonl"), "utf8");
    } catch (err) {
      // P14-6: first-run ENOENT is expected — other read failures propagate.
      if (!isNodeErrorCode(err, "ENOENT")) throw err;
      return;
    }
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const hints = JSON.parse(line) as CommandHints;
        this.hintsByRoot.set(hints.cwd, hints);
      } catch (err) {
        // P14-6: corrupt line — skipped but reported, never silent.
        process.stderr.write(`[degraded] command-discovery.corrupt-line: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
}
