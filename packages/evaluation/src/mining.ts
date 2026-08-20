import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { VerificationSpec } from "@ar/contracts";
import { detectSecrets, redactSecrets } from "@ar/security";
import type { ForbiddenActions, EvalSuite } from "./eval-case.js";
import type { EvalStatus, FailureCategory } from "./runner.js";

/**
 * P2-11 Case Mining from Real Failures.
 *
 * A human-confirmed production-like failure may become a benchmark regression
 * case through a fixed pipeline:
 *
 *   production-like failure → sanitize → minimize fixture → create regression
 *   case → freeze judge
 *
 * Sanitization removes secrets, minimization shrinks the fixture to what the
 * task actually references, case-creation turns the result into an EvalCase
 * shape, and judge-fixing pins the judge version on the frozen case.
 *
 * Hard invariants (the plan forbids auto-saving a secret-bearing real
 * workspace as a benchmark as-is):
 *  - mineCandidate() throws when the failure is not `humanConfirmed`.
 *  - mineCandidate() throws when any secret survives redaction (including
 *    caller-supplied project-specific secret patterns) — a candidate must
 *    never embed a live credential.
 *  - freezeCase() throws when the fixture is still over the byte budget — a
 *    case whose fixture cannot be deterministically made small would fail
 *    inconsistent/guessing judges, so it is refused rather than truncated.
 *
 * Minimization only ever drops whole files (empty, duplicate, over-budget
 * trims); it never edits file contents beyond secret redaction, so it never
 * fabricates a reproduction.
 */

/** A real production-like failure waiting to be mined into a candidate case. */
export interface CapturedFailure {
  /** Unique source identifier (run id, incident ticket, …). */
  id: string;
  /** Raw request text that led to the failure (may contain secrets). */
  task: string;
  /** Real workspace snapshot: relative path → UTF-8 content (may contain secrets). */
  fixture: Record<string, string>;
  outcome?: {
    status: EvalStatus;
    terminationReason?: string;
    violations?: string[];
    failureCategory?: FailureCategory;
  };
  /** Hard gate: only human-confirmed failures may become benchmark cases. */
  humanConfirmed: boolean;
  /** Free-form classification tags (used for the default expected status). */
  tags?: string[];
}

export interface SanitizeReport {
  /** Every location that held a secret before redaction ("task" or a file path). */
  locations: string[];
  /** Secret family names detected across the failure (e.g. "openai-key"). */
  secretTypes: string[];
  /** Total secret spans replaced by redaction. */
  redactedSpans: number;
  /** Files removed entirely because they were pure secret material (a key
   *  file, a .env full of credentials) — the whole file, never a truncation. */
  fullyRemovedFiles: string[];
  /** Whether any secret matched before redaction. */
  sawSecret: boolean;
  /** Secret families that survive redaction (standard + custom patterns).
   *  Non-empty ⇒ mineCandidate() must refuse to build a candidate. */
  remainingSecret: string[];
}

export interface DropReason {
  path: string;
  reason: "empty-file" | "duplicate" | "over-budget-trim";
  /** For over-budget-trim: the size of the dropped file. */
  size?: number;
}

export interface MinimizeReport {
  inputFiles: number;
  outputFiles: number;
  inputBytes: number;
  outputBytes: number;
  maxBytes: number;
  dropped: DropReason[];
  /** True when the fixture is still over budget after deterministic trims —
   *  freezeCase() refuses so the case cannot be judged on a truncated fixture. */
  overBudget: boolean;
}

export interface CaseProvenance {
  sourceFailureId: string;
  minedAt: string;
  humanConfirmed: boolean;
  sourceStatus: EvalStatus | undefined;
  sanitization: SanitizeReport;
  minimization: MinimizeReport;
}

/** A mined, sanitized, minimized — but not yet frozen — regression candidate. */
export interface CandidateBenchmarkCase {
  id: string;
  suite: EvalSuite;
  task: string;
  fixture: Record<string, string>;
  expected: { status: "completed" | "failed" | "denied" };
  expectedTerminationReason?: string;
  forbidden?: ForbiddenActions;
  verification?: VerificationSpec[];
  tags?: string[];
  provenance: CaseProvenance;
}

/** A candidate whose judge version has been pinned; only a frozen case may be
 *  written to the benchmark layout. */
export interface FrozenBenchmarkCase extends CandidateBenchmarkCase {
  judgeVersion: string;
  provenance: CaseProvenance & { judgeVersion: string; frozen: true };
}

/** Raised for a pipeline gate violation (not human-confirmed, secret survives,
 *  fixture over budget). Human-readable rule in `rule`. */
export class CaseMiningError extends Error {
  readonly rule: "need-human-confirmation" | "secret-survives" | "fixture-over-budget";
  constructor(rule: CaseMiningError["rule"], message: string) {
    super(message);
    this.name = "CaseMiningError";
    this.rule = rule;
  }
}

export interface MinemineOptions {
  suite?: EvalSuite;
  /** Explicit expected status; when omitted, derived from tags (denial tags →
   *  "denied", otherwise "failed"). Never guessed to "completed". */
  expectedStatus?: "completed" | "failed" | "denied";
  expectedTerminationReason?: string;
  forbidden?: ForbiddenActions;
  verification?: VerificationSpec[];
  tags?: string[];
  /** Project-specific secret patterns to check AFTER standard redaction.
   *  A match here counts as a surviving secret ⇒ refusal. */
  customSecretPatterns?: RegExp[];
  /** Fixture byte budget for minimization (default MIN_FIXTURE_MAX_BYTES). */
  maxBytes?: number;
  /** Injectable timestamp for deterministic tests. */
  now?: () => number;
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

function fileSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function detectRemaining(content: string, custom: RegExp[]): string[] {
  const families = detectSecrets(content).secrets;
  for (const re of custom) {
    if (re.test(content)) families.push(`<custom:${String(re)}>`);
  }
  return families;
}

/**
 * Step 1 — sanitize. Redacts secrets in the task and every fixture file using
 * the runtime's own secret gate (single source of truth with the runtime),
 * then removes whole files that were pure secret material. Returns whether any
 * secret survived (project-specific patterns included).
 */
export function sanitizeFailure(
  task: string,
  fixture: Record<string, string>,
  customSecretPatterns: RegExp[] = [],
): { task: string; fixture: Record<string, string>; report: SanitizeReport } {
  const locations: string[] = [];
  const secretTypesDetected = new Set<string>();
  let redactedSpans = 0;
  const fullyRemovedFiles: string[] = [];
  let sawSecret = false;

  const scanAndRedact = (content: string, where: string): string => {
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

  const sanitizedFixture: Record<string, string> = {};
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
    } else {
      sanitizedFixture[rel] = out;
    }
  }

  // Re-check across the sanitized outputs for anything that survived.
  const remaining = new Set<string>();
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
export function minimizeFixture(
  fixture: Record<string, string>,
  maxBytes: number = MIN_FIXTURE_MAX_BYTES,
): { fixture: Record<string, string>; report: MinimizeReport } {
  const inputEntries = Object.entries(fixture);
  const dropped: DropReason[] = [];
  const kept: Record<string, string> = {};
  const seenContent = new Set<string>();

  const total = (r: Record<string, string>) =>
    Object.values(r).reduce((acc, c) => acc + fileSize(c), 0);

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
      const candidates = Object.entries(kept).sort(
        ([aPath, a], [bPath, b]) => fileSize(b) - fileSize(a) || aPath.localeCompare(bPath),
      );
      const largest = candidates[0];
      if (!largest) break;
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
export function defaultExpectedStatus(tags: string[] = []): "denied" | "failed" {
  const t = new Set(tags.map((tag) => tag.toLowerCase()));
  return DENIAL_TAG_HINTS.some((hint) => t.has(hint)) ? "denied" : "failed";
}

function derivedId(sourceId: string, task: string): string {
  const slug =
    sourceId
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
export function mineCandidate(
  failure: CapturedFailure,
  opts: MinemineOptions = {},
): CandidateBenchmarkCase {
  if (!failure.humanConfirmed) {
    throw new CaseMiningError(
      "need-human-confirmation",
      `failure "${failure.id}" is not human-confirmed; refusing to mine a benchmark case`,
    );
  }

  const custom = opts.customSecretPatterns ?? [];
  const { task, fixture, report } = sanitizeFailure(failure.task, failure.fixture, custom);
  if (report.remainingSecret.length > 0) {
    throw new CaseMiningError(
      "secret-survives",
      `failure "${failure.id}" still contains secret(s) [${report.remainingSecret.join(", ")}] after redaction; refusing to save it as-is`,
    );
  }

  const maxBytes = opts.maxBytes ?? MIN_FIXTURE_MAX_BYTES;
  const minimized = minimizeFixture(fixture, maxBytes);

  const tags = failure.tags ?? opts.tags ?? [];
  const expectedStatus = opts.expectedStatus ?? defaultExpectedStatus(tags);
  const tagsAll = Array.from(new Set([...(failure.tags ?? []), ...(opts.tags ?? [])]));

  const provenance: CaseProvenance = {
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
export function freezeCase(
  candidate: CandidateBenchmarkCase,
  judgeVersion: string,
): FrozenBenchmarkCase {
  if (candidate.provenance.sanitization.remainingSecret.length > 0) {
    throw new CaseMiningError(
      "secret-survives",
      `candidate "${candidate.id}" still contains surviving secret(s); cannot freeze`,
    );
  }
  if (candidate.provenance.minimization.overBudget) {
    throw new CaseMiningError(
      "fixture-over-budget",
      `candidate "${candidate.id}" fixture is over the ${candidate.provenance.minimization.maxBytes}-byte budget; minimize manually before freezing`,
    );
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
export async function writeFrozenCase(
  outDir: string,
  frozen: FrozenBenchmarkCase,
): Promise<string> {
  const caseDir = resolve(outDir, frozen.suite, frozen.id);

  const safeWrite = async (rel: string, content: string): Promise<void> => {
    if (isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === "..")) {
      throw new CaseMiningError(
        "fixture-over-budget",
        `refusing non-local fixture path in case "${frozen.id}": ${rel}`,
      );
    }
    const target = resolve(caseDir, rel);
    if (target !== caseDir && !target.startsWith(caseDir + sep)) {
      throw new CaseMiningError(
        "fixture-over-budget",
        `fixture path escapes case dir in "${frozen.id}": ${rel}`,
      );
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

  await safeWrite(
    "case.json",
    JSON.stringify(
      {
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
      },
      null,
      2,
    ) + "\n",
  );

  return caseDir;
}

/** Human-readable acceptance criteria for expected.md (never model wording). */
function buildExpectedMd(frozen: FrozenBenchmarkCase): string {
  const lines: string[] = [
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
    if (forb.sideEffects) lines.push("- any side-effecting tool call");
    if (forb.network) lines.push("- any network operation attempt");
    if (forb.commands?.length) lines.push(`- commands: ${forb.commands.join(", ")}`);
    if (forb.reads?.length) lines.push(`- reads: ${forb.reads.join(", ")}`);
  }
  if (frozen.tags?.length) lines.push("", `Tags: ${frozen.tags.join(", ")}`);
  return lines.join("\n");
}

function describeCheck(spec: VerificationSpec): string {
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