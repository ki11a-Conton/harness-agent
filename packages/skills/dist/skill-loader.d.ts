import type { Skill, SkillId, SkillLoader, SkillLoaderOptions } from "@ar/contracts";
import { type SkillSecurityDenial } from "./skill-security.js";
import * as fsPromises from "node:fs/promises";
export interface FileSkillLoaderDeps {
    /** Injectable fs module for tests; defaults to node:fs/promises. */
    fs?: typeof fsPromises;
    /** Injectable clock; defaults to Date.now. */
    now?: () => number;
    /** Injectable SkillId generator; defaults to contracts newSkillId. */
    newSkillId?: () => SkillId;
    /** Optional callback fired when a skill body is denied (injection or secret). */
    onSecurityDenied?: (event: SkillSecurityDenial) => void;
}
/** Marker appended to a truncated body so callers can detect truncation. */
export declare function truncationMarker(bytes: number): string;
/**
 * SKILL-001: progressive skill loading — metadata visible, body on demand.
 *
 * discover() reads at most maxMetadataBytes per SKILL.md (fs.open + read on a
 * bounded prefix; the file is never read whole) and only parses frontmatter,
 * so it stays cheap even for huge skills. The body is read only by load().
 */
export declare class FileSkillLoader implements SkillLoader {
    private readonly fs;
    private readonly now;
    private readonly makeSkillId;
    private readonly onSecurityDenied?;
    constructor(deps?: FileSkillLoaderDeps);
    discover(opts: SkillLoaderOptions): Promise<Skill[]>;
    load(skill: Skill, opts?: Pick<SkillLoaderOptions, "maxBodyBytes">): Promise<Skill>;
    /** Recursively collects directories that contain a SKILL.md file. */
    private collectSkillDirs;
    /**
     * Reads only the first maxBytes bytes of the SKILL.md and builds the
     * metadata-only Skill. Unreadable files are skipped (best effort).
     */
    private readMetadata;
    /** fs.open + read of the leading maxBytes bytes only (never the whole file). */
    private readPrefix;
}
//# sourceMappingURL=skill-loader.d.ts.map