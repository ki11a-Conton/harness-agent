import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { detectSecrets, redactSecrets } from "@ar/security";
/** Raised for a pipeline gate violation (not human-confirmed, secret survives,
 *  fixture over budget). Human-readable rule in `rule`. */
export class CaseMiningError extends Error {
    rule;
    constructor(rule, message) {
        super(message);
        this.name = "CaseMiningError";
        this.rule = rule;
    }
}
export const MIN_FIXTURE_MAX_BYTES = 256 * 1024;
/** Tags that indicate the failure was a security/denial incident, so the mined
 *  case should assert denial rather than completion. */
const DENIAL_TAG_HINTS = [
    "denial",
    "denied",
    "injection",
    "security",
    "network",
    "exfil",
    "path-traversal",
    "poison",
    "sandbox",
    "permission",
];
function fileSize(content) {
    return Buffer.byteLength(content, "utf8");
}
function detectRemaining(content, custom) {
    const families = detectSecrets(content).secrets;
    for (const re of custom) {
        if (re.test(content))
            families.push(`<custom:${String(re)}>`);
    }
    return families;
}
/**
 * Step 1 — sanitize. Redacts secrets in the task and every fixture file using
 * the runtime's own secret gate (single source of truth with the runtime),
 * then removes whole files that were pure secret material. Returns whether any
 * secret survived (project-specific patterns included).
 */
export function sanitizeFailure(task, fixture, customSecretPatterns = []) {
    const locations = [];
    const secretTypesDetected = new Set();
    let redactedSpans = 0;
    const fullyRemovedFiles = [];
    let sawSecret = false;
    const scanAndRedact = (content, where) => {
        const pre = detectSecrets(content);
        if (pre.hasSecret) {
            sawSecret = true;
            pre.secrets.forEach((s) => secretTypesDetected.add(s));
            locations.push(where);
        }
        const { content: out, redacted } = redactSecrets(content);
        if (redacted > 0) {
            locations.push(where);
            redactedSpans += redacted;
        }
        return out;
    };
    const sanitizedTask = scanAndRedact(task, "task");
    const sanitizedFixture = {};
    for (const [rel, raw] of Object.entries(fixture)) {
        const out = scanAndRedact(raw, rel);
        // A file is removed entirely only when it was PURE secret material (a bare
        // key or a credential dump): redaction replaced ≥1 span and the remainder
        // is nothing but "[redacted]" placeholders and whitespace. A file that has
        // surrounding structure (e.g. ".env" with a KEY= label) is kept with its
        // secret redacted, so the structural reproduction survives.
        const placeholderOnly = out.replace(/\[redacted\]/g, "").trim() === "";
        if (raw !== out && placeholderOnly) {
            fullyRemovedFiles.push(rel);
        }
        else {
            sanitizedFixture[rel] = out;
        }
    }
    // Re-check across the sanitized outputs for anything that survived.
    const remaining = new Set();
    for (const c of [sanitizedTask, ...Object.values(sanitizedFixture)]) {
        detectRemaining(c, customSecretPatterns).forEach((s) => remaining.add(s));
    }
    return {
        task: sanitizedTask,
        fixture: sanitizedFixture,
        report: {
            locations: Array.from(new Set(locations)),
            secretTypes: Array.from(secretTypesDetected),
            redactedSpans,
            fullyRemovedFiles,
            sawSecret,
            remainingSecret: Array.from(remaining),
        },
    };
}
/**
 * Step 2 — minimize fixture. Deterministic whole-file dropping only:
 *  - empty files are dropped,
 *  - files whose content is an exact duplicate of an earlier kept file are dropped,
 *  - if still over budget, the largest not-yet-kept files are trimmed until the
 *    budget is met; if the budget cannot be met by dropping whole files, the
 *    fixture is flagged `overBudget` and freezeCase() refuses.
 * No file content is ever edited in place (other than the earlier secret
 * redaction), so the reproduction is never fabricated.
 */
export function minimizeFixture(fixture, maxBytes = MIN_FIXTURE_MAX_BYTES) {
    const inputEntries = Object.entries(fixture);
    const dropped = [];
    const kept = {};
    const seenContent = new Set();
    const total = (r) => Object.values(r).reduce((acc, c) => acc + fileSize(c), 0);
    for (const [rel, content] of inputEntries) {
        if (content.trim() === "") {
            dropped.push({ path: rel, reason: "empty-file" });
            continue;
        }
        if (seenContent.has(content)) {
            dropped.push({ path: rel, reason: "duplicate" });
            continue;
        }
        seenContent.add(content);
        kept[rel] = content;
    }
    // Trim largest whole files while over budget (deterministic order: sort
    // by size desc, then by path asc for stability). Never drop the last file —
    // a fixture with one file still over budget is flagged `overBudget` for a
    // human to slim, never silently emptied.
    if (maxBytes > 0) {
        while (total(kept) > maxBytes && Object.keys(kept).length > 1) {
            const candidates = Object.entries(kept).sort(([aPath, a], [bPath, b]) => fileSize(b) - fileSize(a) || aPath.localeCompare(bPath));
            const largest = candidates[0];
            if (!largest)
                break;
            delete kept[largest[0]];
            dropped.push({ path: largest[0], reason: "over-budget-trim", size: fileSize(largest[1]) });
        }
    }
    return {
        fixture: kept,
        report: {
            inputFiles: inputEntries.length,
            outputFiles: Object.keys(kept).length,
            inputBytes: total(fixture),
            outputBytes: total(kept),
            maxBytes,
            dropped,
            overBudget: maxBytes > 0 && total(kept) > maxBytes,
        },
    };
}
/** Default expected status for a mined failure: denial tags → "denied",
 *  otherwise "failed". Never auto-selects "completed". */
export function defaultExpectedStatus(tags = []) {
    const t = new Set(tags.map((tag) => tag.toLowerCase()));
    return DENIAL_TAG_HINTS.some((hint) => t.has(hint)) ? "denied" : "failed";
}
function derivedId(sourceId, task) {
    const slug = sourceId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "case";
    const hash = createHash("sha256").update(task).digest("hex").slice(0, 8);
    return `mine-${slug}-${hash}`;
}
/**
 * Steps 1–3 — produce a candidate regression case from a real failure.
 *
 * Gates:
 *  - failure.humanConfirmed must be true (CaseMiningError "need-human-confirmation").
 *  - no secret may survive redaction, standard or custom (CaseMiningError
 *    "secret-survives") — this is the plan's prohibition on auto-saving a
 *    secret-bearing real workspace.
 * An over-budget fixture is allowed to reach the candidate (it is flagged in
 * provenance) but freezeCase() will refuse to pin a judge on it.
 */
export function mineCandidate(failure, opts = {}) {
    if (!failure.humanConfirmed) {
        throw new CaseMiningError("need-human-confirmation", `failure "${failure.id}" is not human-confirmed; refusing to mine a benchmark case`);
    }
    const custom = opts.customSecretPatterns ?? [];
    const { task, fixture, report } = sanitizeFailure(failure.task, failure.fixture, custom);
    if (report.remainingSecret.length > 0) {
        throw new CaseMiningError("secret-survives", `failure "${failure.id}" still contains secret(s) [${report.remainingSecret.join(", ")}] after redaction; refusing to save it as-is`);
    }
    const maxBytes = opts.maxBytes ?? MIN_FIXTURE_MAX_BYTES;
    const minimized = minimizeFixture(fixture, maxBytes);
    const tags = failure.tags ?? opts.tags ?? [];
    const expectedStatus = opts.expectedStatus ?? defaultExpectedStatus(tags);
    const tagsAll = Array.from(new Set([...(failure.tags ?? []), ...(opts.tags ?? [])]));
    const provenance = {
        sourceFailureId: failure.id,
        minedAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
        humanConfirmed: failure.humanConfirmed,
        sourceStatus: failure.outcome?.status,
        sanitization: report,
        minimization: minimized.report,
    };
    return {
        id: derivedId(failure.id, task),
        suite: opts.suite ?? "regression",
        task,
        fixture: minimized.fixture,
        expected: { status: expectedStatus },
        ...(opts.expectedTerminationReason !== undefined
            ? { expectedTerminationReason: opts.expectedTerminationReason }
            : {}),
        ...(opts.forbidden !== undefined ? { forbidden: opts.forbidden } : {}),
        ...(opts.verification !== undefined ? { verification: opts.verification } : {}),
        tags: tagsAll.length > 0 ? tagsAll : undefined,
        provenance,
    };
}
/**
 * Step 4 — freeze the judge on a candidate. Refuses when a secret still
 * survives, or when the fixture is over budget (a candidate that automation
 * could not make judgeable cannot have a judge pinned without fabrication).
 */
export function freezeCase(candidate, judgeVersion) {
    if (candidate.provenance.sanitization.remainingSecret.length > 0) {
        throw new CaseMiningError("secret-survives", `candidate "${candidate.id}" still contains surviving secret(s); cannot freeze`);
    }
    if (candidate.provenance.minimization.overBudget) {
        throw new CaseMiningError("fixture-over-budget", `candidate "${candidate.id}" fixture is over the ${candidate.provenance.minimization.maxBytes}-byte budget; minimize manually before freezing`);
    }
    return {
        ...candidate,
        judgeVersion,
        provenance: { ...candidate.provenance, judgeVersion, frozen: true },
    };
}
/**
 * Write a frozen case into the benchmark layout consumed by benchmarks/README.md:
 *
 *   <outDir>/<suite>/<case-id>/request.md     (sanitized task)
 *   <outDir>/<suite>/<case-id>/expected.md    (human-readable acceptance)
 *   <outDir>/<suite>/<case-id>/case.json      (machine-readable EvalCase + provenance)
 *   <outDir>/<suite>/<case-id>/fixture/<rel>  (sanitized + minimized files)
 *
 * Path safety: fixture keys must stay inside the case dir (no absolute, no
 * escaping via ".."). A path that would escape is refused, not silently mapped.
 * Returns the case directory that was written.
 */
export async function writeFrozenCase(outDir, frozen) {
    const caseDir = resolve(outDir, frozen.suite, frozen.id);
    const safeWrite = async (rel, content) => {
        if (isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === "..")) {
            throw new CaseMiningError("fixture-over-budget", `refusing non-local fixture path in case "${frozen.id}": ${rel}`);
        }
        const target = resolve(caseDir, rel);
        if (target !== caseDir && !target.startsWith(caseDir + sep)) {
            throw new CaseMiningError("fixture-over-budget", `fixture path escapes case dir in "${frozen.id}": ${rel}`);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
    };
    await mkdir(caseDir, { recursive: true });
    await safeWrite("request.md", frozen.task.replace(/\n$/, "") + "\n");
    await safeWrite("expected.md", buildExpectedMd(frozen) + "\n");
    for (const [rel, content] of Object.entries(frozen.fixture)) {
        await safeWrite(`fixture/${rel}`, content);
    }
    await safeWrite("case.json", JSON.stringify({
        case: {
            id: frozen.id,
            suite: frozen.suite,
            task: frozen.task,
            expected: frozen.expected,
            expectedTerminationReason: frozen.expectedTerminationReason,
            forbidden: frozen.forbidden,
            verification: frozen.verification,
            tags: frozen.tags,
            judgeVersion: frozen.judgeVersion,
            fixture: frozen.fixture,
        },
        provenance: frozen.provenance,
    }, null, 2) + "\n");
    return caseDir;
}
/** Human-readable acceptance criteria for expected.md (never model wording). */
function buildExpectedMd(frozen) {
    const lines = [
        `# ${frozen.id}`,
        "",
        `Status: ${frozen.expected.status}`,
    ];
    if (frozen.expectedTerminationReason) {
        lines.push(`Termination: ${frozen.expectedTerminationReason}`);
    }
    if (frozen.verification && frozen.verification.length > 0) {
        lines.push("", "Verification:");
        for (const v of frozen.verification) {
            const desc = v.description || describeCheck(v);
            lines.push(`- ${desc}`);
        }
    }
    const forb = frozen.forbidden;
    if (forb) {
        lines.push("", "Forbidden:");
        if (forb.sideEffects)
            lines.push("- any side-effecting tool call");
        if (forb.network)
            lines.push("- any network operation attempt");
        if (forb.commands?.length)
            lines.push(`- commands: ${forb.commands.join(", ")}`);
        if (forb.reads?.length)
            lines.push(`- reads: ${forb.reads.join(", ")}`);
    }
    if (frozen.tags?.length)
        lines.push("", `Tags: ${frozen.tags.join(", ")}`);
    return lines.join("\n");
}
function describeCheck(spec) {
    switch (spec.kind) {
        case "command":
            return `run \`${spec.command}${spec.args?.length ? " " + spec.args.join(" ") : ""}\``;
        case "artifact":
            return `assert artifact ${spec.path}${spec.mustChange ? " changed" : ""}`;
        case "requirement":
            return `requirement: ${spec.statement}`;
        case "diff":
            return `diff constraints on ${spec.expectedPaths?.join(", ") ?? "(all changed)"}`;
    }
}
//# sourceMappingURL=mining.js.map