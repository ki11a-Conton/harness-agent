/**
 * P33-8 — Repository-owned WORKFLOW.md.
 *
 * A minimal contract inspired by Symphony: an optional YAML front matter
 * (tracker kind, polling interval, agent concurrency, workspace root) plus a
 * body that is used as the worker prompt template.
 *
 * The front-matter parser is intentionally tiny and DOCUMENTED — it accepts
 * only flat `key: value` / `key: [a, b]` lines (no nested YAML). This is a
 * deliberate, documented alternative to pulling in a full YAML dependency
 * (plan.md P33-8 allows that; we choose the documented alternative). Unknown
 * keys are ignored for forward compatibility; invalid KNOWN keys fail with a
 * typed error (never a silent pseudo-YAML fallback).
 */

export type WorkflowConfig = {
  /** Tracker kind (e.g. "fake"). Unknown kinds are ignored by the orchestrator. */
  readonly tracker?: string;
  /** Polling interval for the reconcile loop (ms). Default 30000. */
  readonly pollingIntervalMs?: number;
  /** Max concurrent workers. Default 4. */
  readonly maxConcurrent?: number;
  /** Workspace root directory (relative to the repo root unless absolute). */
  readonly workspaceRoot?: string;
  /** Body after the front matter — the worker prompt template. */
  readonly prompt: string;
};

export class WorkflowParseError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`WORKFLOW.md front matter: ${message}`);
    this.name = "WorkflowParseError";
    this.field = field;
  }
}

const FRONT_MATTER_RE = /^---\s*$/;
const KEY_VALUE_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;

/**
 * Parse WORKFLOW.md content:
 *   - optional `---` delimited YAML-ish front matter (flat only);
 *   - the remainder (after `---`) is the prompt template.
 * Invalid known fields throw WorkflowParseError; unknown fields are ignored.
 */
export function parseWorkflow(markdown: string): WorkflowConfig {
  const lines = markdown.split(/\r?\n/);
  if (lines.length === 0 || !FRONT_MATTER_RE.test(lines[0]!)) {
    // No front matter: whole document is the prompt.
    return { prompt: markdown.trimEnd() };
  }

  let i = 1;
  const fields: Record<string, string> = {};
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (FRONT_MATTER_RE.test(line)) break;
    if (line.trim() === "" || line.startsWith("#")) continue;
    const m = KEY_VALUE_RE.exec(line);
    if (m === null) {
      throw new WorkflowParseError("syntax", `invalid line ${i + 1}: ${line}`);
    }
    fields[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  if (i >= lines.length) {
    throw new WorkflowParseError("syntax", "unterminated front matter (missing closing ---)");
  }

  const body = lines.slice(i + 1).join("\n").trimStart();
  return {
    tracker: fields.tracker,
    ...(fields.polling !== undefined && fields.polling !== ""
      ? { pollingIntervalMs: requireInt("polling", fields.polling) }
      : {}),
    ...(fields.max_concurrent !== undefined && fields.max_concurrent !== ""
      ? { maxConcurrent: requireInt("max_concurrent", fields.max_concurrent) }
      : {}),
    ...(fields.workspace !== undefined && fields.workspace !== ""
      ? { workspaceRoot: fields.workspace }
      : {}),
    prompt: body,
  };
}

function asInt(value: string): { ok: true; value: number } | { ok: false } {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

function requireInt(field: string, value: string): number {
  const parsed = asInt(value);
  if (!parsed.ok) throw new WorkflowParseError(field, `expected a non-negative integer, got "${value}"`);
  return parsed.value;
}