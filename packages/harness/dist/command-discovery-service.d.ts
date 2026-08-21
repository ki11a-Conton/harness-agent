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
export declare class CommandDiscoveryService {
    private readonly dataDir?;
    private readonly now;
    private readonly hintsByRoot;
    constructor(deps?: CommandDiscoveryServiceDeps);
    /** Discover once per workspace root; subsequent calls are cache hits. */
    maybeDiscover(cwd: string): Promise<CommandHints | undefined>;
    /** P7-6: fire on the first code-changing turn (filesChanged non-empty). */
    onCodeChange(cwd: string, filesChanged: readonly string[]): Promise<CommandHints | undefined>;
    hints(cwd: string): CommandHints | undefined;
    /** Format hints for injection into importantFacts (working state). */
    toImportantFacts(hints: CommandHints): string[];
    private persist;
    /** Load hints persisted by an earlier process (startup warm-up). */
    loadPersisted(): Promise<void>;
}
//# sourceMappingURL=command-discovery-service.d.ts.map