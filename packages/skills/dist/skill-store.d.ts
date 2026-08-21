import type { Skill, SkillId } from "@ar/contracts";
import { type SkillSecurityDenial } from "./skill-security.js";
/** Single JSONL file holding every skill record (SKILL-EVO-001). */
export declare const SKILLS_FILE_NAME = "skills.jsonl";
/**
 * Persistence surface used by SkillEvolver (§70 promote/rollback).
 *
 * `save` is the minimum contract; `update` and `list` are optional
 * capabilities that rollback uses to deprecate failed candidate versions
 * when the store can express it. A minimal store without them still works
 * (restore works, deprecation is skipped).
 */
export interface SkillStoreLike {
    /** Create or replace the record with the same id (upsert). */
    save(s: Skill): Promise<void>;
    /** Replace an existing record; unknown ids fail. */
    update?(s: Skill): Promise<void>;
    /** Every record (any status), for candidate discovery. */
    list?(): Promise<Skill[]>;
}
export interface JsonlSkillStoreOptions {
    /** Directory holding skills.jsonl; created on first write. */
    dataDir: string;
    /** Optional callback fired when a save/update is denied (injection or secret). */
    onSecurityDenied?: (event: SkillSecurityDenial) => void;
}
/**
 * SKILL-EVO-001: JSONL file backend for SkillStoreLike (dataDir/skills.jsonl,
 * one Skill per line).
 *
 * - `save` is an upsert keyed by Skill.id, so promoting a candidate replaces
 *   the record with the same id and leaves records with other ids (older
 *   versions) untouched.
 * - Mutations are atomic: the whole file is rewritten via a temp file +
 *   rename, so a crash never leaves a half-written line (same discipline as
 *   JsonlMemoryStore). Single-writer assumption.
 * - A corrupt line is skipped on read (best-effort recovery); it never fails
 *   the store wholesale.
 */
export declare class JsonlSkillStore implements SkillStoreLike {
    private readonly dataDir;
    private readonly onSecurityDenied?;
    constructor(opts: JsonlSkillStoreOptions);
    /** Issue 6/6b: check a skill's body and description for injection or secrets. */
    private static checkUnsafe;
    private filePath;
    private readAll;
    /** Atomic rewrite of the whole file: temp file + rename in the same dir. */
    private rewrite;
    /** Upsert: replaces the record with the same id, otherwise appends. */
    save(skill: Skill): Promise<void>;
    /** Replaces an existing record; unknown id fails explicitly. */
    update(skill: Skill): Promise<void>;
    /** Every record (any status), newest appended last. */
    list(): Promise<Skill[]>;
    get(id: SkillId): Promise<Skill | undefined>;
}
//# sourceMappingURL=skill-store.d.ts.map