/**
 * P2-9: experiment config loader. Supports JSON and a minimal YAML subset
 * (key:value scalars, - item lists, # comments). Zero external dependencies.
 */
const DEFAULT_RUNS = 3;
/** Parse a JSON or YAML config file into an ExperimentConfig. */
export async function loadExperimentConfig(path) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path, "utf8");
    if (path.endsWith(".json")) {
        return experimentConfigFromObject(JSON.parse(text));
    }
    if (path.endsWith(".yaml") || path.endsWith(".yml")) {
        return experimentConfigFromObject(parseYaml(text));
    }
    throw new Error(`unsupported config format: ${path} (use .json, .yaml, or .yml)`);
}
/** Build an ExperimentConfig from a plain object with validation. */
export function experimentConfigFromObject(obj) {
    const errors = validateExperimentConfigObject(obj);
    if (errors.length > 0) {
        throw new Error(`experiment config validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    }
    const variants = obj.variants.map((v) => {
        const vObj = v;
        return {
            name: String(vObj.name),
            mechanism: String(vObj.mechanism),
            overrides: vObj.overrides ?? {},
        };
    });
    return {
        id: String(obj.id),
        description: obj.description !== undefined ? String(obj.description) : undefined,
        variants,
        baseline: obj.baseline !== undefined ? String(obj.baseline) : variants[0].name,
        benchmarkSuite: obj.benchmarkSuite !== undefined ? String(obj.benchmarkSuite) : undefined,
        runs: obj.runs !== undefined ? Number(obj.runs) : DEFAULT_RUNS,
        seeds: obj.seeds !== undefined ? obj.seeds : undefined,
        models: obj.models !== undefined ? obj.models : undefined,
        modelCapabilities: obj.modelCapabilities !== undefined
            ? obj.modelCapabilities
            : undefined,
    };
}
/** Validate the raw object; returns error messages (empty = valid). */
export function validateExperimentConfigObject(obj) {
    const errors = [];
    if (obj.id === undefined || String(obj.id).trim() === "")
        errors.push("id is required");
    if (!Array.isArray(obj.variants) || obj.variants.length === 0) {
        errors.push("variants must be a non-empty array");
    }
    else {
        const names = new Set();
        for (let i = 0; i < obj.variants.length; i++) {
            const v = obj.variants[i];
            if (v === null || typeof v !== "object") {
                errors.push(`variants[${i}] must be an object`);
                continue;
            }
            if (v.name === undefined || String(v.name).trim() === "") {
                errors.push(`variants[${i}].name is required`);
            }
            else {
                const name = String(v.name);
                if (names.has(name))
                    errors.push(`duplicate variant name: "${name}"`);
                names.add(name);
            }
            if (v.mechanism === undefined || String(v.mechanism).trim() === "") {
                errors.push(`variants[${i}].mechanism is required`);
            }
        }
        const baseline = obj.baseline !== undefined ? String(obj.baseline) : undefined;
        if (baseline !== undefined && !names.has(baseline)) {
            errors.push(`baseline "${baseline}" does not match any variant name`);
        }
    }
    if (obj.models !== undefined) {
        const models = obj.models;
        if (!Array.isArray(models) || models.length === 0) {
            errors.push("models must be a non-empty array when provided");
        }
        else {
            const seen = new Set();
            for (let i = 0; i < models.length; i++) {
                const m = String(models[i]);
                if (m === "")
                    errors.push(`models[${i}] must be a non-empty name`);
                if (seen.has(m))
                    errors.push(`duplicate model: "${m}"`);
                seen.add(m);
            }
        }
    }
    if (obj.modelCapabilities !== undefined) {
        const caps = obj.modelCapabilities;
        for (const [name, value] of Object.entries(caps)) {
            if (value !== "strong" && value !== "weak") {
                errors.push(`modelCapabilities["${name}"] must be "strong" or "weak"`);
            }
        }
    }
    return errors;
}
/** Minimal YAML subset parser: key:value scalars, - item lists, # comments. */
export function parseYaml(text) {
    const out = {};
    let listKey;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#"))
            continue;
        if (line.startsWith("- ")) {
            if (listKey === undefined)
                throw new Error(`yaml: list item without a key: ${line}`);
            const list = out[listKey];
            if (Array.isArray(list)) {
                list.push(stripQuotes(line.slice(2).trim()));
                continue;
            }
            throw new Error(`yaml: list item under non-list key ${listKey}: ${line}`);
        }
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (match === null)
            throw new Error(`yaml: unsupported line: ${line}`);
        const key = match[1];
        const value = match[2] ?? "";
        listKey = key;
        const trimmed = stripQuotes(value.trim());
        out[key] = value.trim() === "" ? "" : trimmed;
        if (key === "variants") {
            out[key] = value.trim() === "" ? [] : [trimmed];
            listKey = key;
        }
    }
    return out;
}
function stripQuotes(value) {
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        return value.slice(1, -1);
    }
    return value;
}
//# sourceMappingURL=experiment-config.js.map