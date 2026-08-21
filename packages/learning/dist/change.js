import { createHash } from "node:crypto";
/** Stable JSON (sorted keys) — the canonical serialization for hashing. */
export function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
/** P10-2: deterministic config fingerprint — freezes a harness profile for
 *  the duration of an evaluation (champion vs challenger must share or differ
 *  only by the candidate patch, and both must be pinned). */
export function configHash(config) {
    return createHash("sha256").update(stableStringify(config)).digest("hex").slice(0, 16);
}
/** P10-6: platform-sensitivity of a candidate patch. Patches touching paths,
 *  filesystem, process or store behavior must pass BOTH Linux and Windows CI
 *  before promotion; pure-prompt/tool-preference patches are platform-neutral.
 *  The gate returns the platforms the patch is sensitive to (empty = neutral). */
export function platformSensitivity(patch) {
    const kind = patchTypeOf(patch);
    if (kind === "policy" || kind === "memory") {
        return { sensitive: true, platforms: ["linux", "windows"] };
    }
    return { sensitive: false, platforms: [] };
}
function patchTypeOf(patch) {
    if ("rule" in patch)
        return "prompt_rule";
    if ("action" in patch && "resource" in patch)
        return "policy";
    if ("skillName" in patch)
        return "skill";
    if ("content" in patch)
        return "memory";
    return "tool_preference";
}
//# sourceMappingURL=change.js.map