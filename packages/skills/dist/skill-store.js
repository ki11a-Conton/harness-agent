import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentError, errorInfo } from "@ar/contracts";
import { detectPromptInjection, detectSecrets } from "@ar/security";
import { skillDenialCode } from "./skill-security.js";
/** Single JSONL file holding every skill record (SKILL-EVO-001). */
export const SKILLS_FILE_NAME = "skills.jsonl";
function isNodeError(err, code) {
    return (err instanceof Error &&
        "code" in err &&
        err.code === code);
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
export class JsonlSkillStore {
    dataDir;
    onSecurityDenied;
    constructor(opts) {
        this.dataDir = opts.dataDir;
        this.onSecurityDenied = opts.onSecurityDenied;
    }
    /** Issue 6/6b: check a skill's body and description for injection or secrets. */
    static checkUnsafe(skill) {
        const texts = [skill.body, skill.manifest?.description].filter((t) => typeof t === "string" && t !== "");
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
    filePath() {
        return join(this.dataDir, SKILLS_FILE_NAME);
    }
    async readAll() {
        const path = this.filePath();
        let raw;
        try {
            raw = await readFile(path, "utf8");
        }
        catch (err) {
            if (isNodeError(err, "ENOENT"))
                return [];
            throw new AgentError(errorInfo("INTERNAL_ERROR", `skill store read failed: ${path}`, {
                cause: err,
            }));
        }
        const skills = [];
        for (const line of raw.split("\n")) {
            if (line.trim() === "")
                continue;
            try {
                const rec = JSON.parse(line);
                if (typeof rec !== "object" || rec === null)
                    continue;
                const skill = rec;
                if (typeof skill.id !== "string" ||
                    typeof skill.path !== "string" ||
                    typeof skill.manifest?.name !== "string") {
                    continue;
                }
                skills.push(skill);
            }
            catch {
                // corrupt line: skip, keep reading the rest (best-effort recovery)
            }
        }
        return skills;
    }
    /** Atomic rewrite of the whole file: temp file + rename in the same dir. */
    async rewrite(skills) {
        await mkdir(this.dataDir, { recursive: true });
        const target = this.filePath();
        const tmp = `${target}.tmp`;
        const body = skills.map((skill) => JSON.stringify(skill)).join("\n");
        const content = skills.length === 0 ? "" : `${body}\n`;
        try {
            await writeFile(tmp, content, "utf8");
            await rename(tmp, target);
        }
        catch (cause) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `skill store write failed: ${target}`, {
                cause,
            }));
        }
    }
    /** Upsert: replaces the record with the same id, otherwise appends. */
    async save(skill) {
        const reason = JsonlSkillStore.checkUnsafe(skill);
        if (reason !== null) {
            this.onSecurityDenied?.(reason.event);
            throw new AgentError(errorInfo(skillDenialCode(reason.event.detection), `skill save blocked: ${reason.message}`));
        }
        const all = await this.readAll();
        const index = all.findIndex((s) => s.id === skill.id);
        if (index >= 0)
            all[index] = skill;
        else
            all.push(skill);
        await this.rewrite(all);
    }
    /** Replaces an existing record; unknown id fails explicitly. */
    async update(skill) {
        const reason = JsonlSkillStore.checkUnsafe(skill);
        if (reason !== null) {
            this.onSecurityDenied?.(reason.event);
            throw new AgentError(errorInfo(skillDenialCode(reason.event.detection), `skill update blocked: ${reason.message}`));
        }
        const all = await this.readAll();
        const index = all.findIndex((s) => s.id === skill.id);
        if (index < 0) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `cannot update unknown skill ${skill.id}`));
        }
        all[index] = skill;
        await this.rewrite(all);
    }
    /** Every record (any status), newest appended last. */
    async list() {
        return this.readAll();
    }
    async get(id) {
        const all = await this.readAll();
        return all.find((s) => s.id === id);
    }
}
//# sourceMappingURL=skill-store.js.map