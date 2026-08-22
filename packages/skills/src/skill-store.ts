import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Skill, SkillId } from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import { detectPromptInjection, detectSecrets } from "@ar/security";
import { skillDenialCode, type SkillSecurityDenial } from "./skill-security.js";

/** Single JSONL file holding every skill record (SKILL-EVO-001). */
export const SKILLS_FILE_NAME = "skills.jsonl";

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

function isNodeError(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
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
export class JsonlSkillStore implements SkillStoreLike {
  private readonly dataDir: string;
  private readonly onSecurityDenied?: JsonlSkillStoreOptions["onSecurityDenied"];

  constructor(opts: JsonlSkillStoreOptions) {
    this.dataDir = opts.dataDir;
    this.onSecurityDenied = opts.onSecurityDenied;
  }

  /** Issue 6/6b: check a skill's body and description for injection or secrets. */
  private static checkUnsafe(skill: Skill): { message: string; event: SkillSecurityDenial } | null {
    const texts = [skill.body, skill.manifest?.description].filter(
      (t): t is string => typeof t === "string" && t !== "",
    );
    for (const text of texts) {
      const injection = detectPromptInjection(text);
      if (injection.hasInjection) {
        return { message: `injection detected (${injection.reasons.join(", ")})`, event: { detection: "injection", reasons: injection.reasons, content: text, path: skill.id, source: "skill-store" } };
      }
      const secret = detectSecrets(text);
      if (secret.hasSecret) {
        return { message: `secret detected (${secret.secrets.join(", ")})`, event: { detection: "secret", reasons: secret.secrets, content: text, path: skill.id, source: "skill-store" } };
      }
    }
    return null;
  }

  private filePath(): string {
    return join(this.dataDir, SKILLS_FILE_NAME);
  }

  private async readAll(): Promise<Skill[]> {
    const path = this.filePath();
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `skill store read failed: ${path}`, {
          cause: err,
        }),
      );
    }
    const skills: Skill[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const rec = JSON.parse(line) as unknown;
        if (typeof rec !== "object" || rec === null) continue;
        const skill = rec as Partial<Skill>;
        if (
          typeof skill.id !== "string" ||
          typeof skill.path !== "string" ||
          typeof skill.manifest?.name !== "string"
        ) {
          continue;
        }
        skills.push(skill as Skill);
      } catch (err) {
        // P14-6: corrupt line — skipped (best-effort recovery) but reported,
        // never silent.
        process.stderr.write(`[degraded] skill-store.corrupt-line: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return skills;
  }

  /** Atomic rewrite of the whole file: temp file + rename in the same dir. */
  private async rewrite(skills: Skill[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const target = this.filePath();
    const tmp = `${target}.tmp`;
    const body = skills.map((skill) => JSON.stringify(skill)).join("\n");
    const content = skills.length === 0 ? "" : `${body}\n`;
    try {
      await writeFile(tmp, content, "utf8");
      await rename(tmp, target);
    } catch (cause) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `skill store write failed: ${target}`, {
          cause,
        }),
      );
    }
  }

  /** Upsert: replaces the record with the same id, otherwise appends. */
  async save(skill: Skill): Promise<void> {
    const reason = JsonlSkillStore.checkUnsafe(skill);
    if (reason !== null) {
      this.onSecurityDenied?.(reason.event);
      throw new AgentError(errorInfo(skillDenialCode(reason.event.detection), `skill save blocked: ${reason.message}`));
    }
    const all = await this.readAll();
    const index = all.findIndex((s) => s.id === skill.id);
    if (index >= 0) all[index] = skill;
    else all.push(skill);
    await this.rewrite(all);
  }

  /** Replaces an existing record; unknown id fails explicitly. */
  async update(skill: Skill): Promise<void> {
    const reason = JsonlSkillStore.checkUnsafe(skill);
    if (reason !== null) {
      this.onSecurityDenied?.(reason.event);
      throw new AgentError(errorInfo(skillDenialCode(reason.event.detection), `skill update blocked: ${reason.message}`));
    }
    const all = await this.readAll();
    const index = all.findIndex((s) => s.id === skill.id);
    if (index < 0) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `cannot update unknown skill ${skill.id}`),
      );
    }
    all[index] = skill;
    await this.rewrite(all);
  }

  /** Every record (any status), newest appended last. */
  async list(): Promise<Skill[]> {
    return this.readAll();
  }

  async get(id: SkillId): Promise<Skill | undefined> {
    const all = await this.readAll();
    return all.find((s) => s.id === id);
  }
}
