import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * P2-8: mechanism registry tooling. Manifests live in research/mechanisms/
 * as YAML; this module validates them (structure + id uniqueness) so the
 * registry stays consistent. Minimal YAML subset parser (scalar keys,
 * list items, comments) — no external dependency.
 */

export const MECHANISM_STATUS = [
  "candidate",
  "proposed",
  "evaluating",
  "accepted",
  "rejected",
  "shipped",
] as const;

export const MECHANISM_CATEGORIES = [
  "prompting",
  "memory",
  "planning",
  "tool_use",
  "learning",
  "scheduling",
  "error_recovery",
  "context_management",
  "evaluation",
  "security",
  "other",
] as const;

export const MECHANISM_CATEGORY_SET = MECHANISM_CATEGORIES as readonly string[];

/**
 * Q-20: provenance discipline. Every mechanism must declare how its code
 * relates to a reference agent's source so we never silently copy a long code
 * block.
 *
 * - `original`: no external reference; designed from first principles here.
 * - `inspired`: concept/design informed by a reference agent's report/source,
 *   but the implementation is original code written for this repo.
 * - `reimplemented`: re-implements a reference feature independently (clean
 *   room) out of the same public contract; no lines copied.
 * - `derived`: carries over non-trivial code/structures from a reference
 *   source — REQUIRES `attribution` naming exactly what and from where.
 */
export const MECHANISM_PROVENANCE = [
  "original",
  "inspired",
  "reimplemented",
  "derived",
] as const;

export const MECHANISM_PROVENANCE_SET = MECHANISM_PROVENANCE as readonly string[];

export const MECHANISM_REQUIRED_FIELDS = [
  "id",
  "source_agent",
  "source_report",
  "provenance",
  "category",
  "problem",
  "preconditions",
  "expected_benefit",
  "risks",
  "implementation_scope",
  "evaluation_cases",
  "status",
] as const;

export interface ManifestIssue {
  path: string;
  errors: string[];
}

/** Minimal YAML subset parser: `key: value` lines, `- item` lists, `#` comments. */
export function parseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let listKey: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("- ")) {
      if (listKey === undefined) throw new Error(`yaml: list item without a key: ${line}`);
      const list = out[listKey];
      if (Array.isArray(list)) {
        list.push(stripQuotes(line.slice(2).trim()));
        continue;
      }
      throw new Error(`yaml: list item under non-list key ${listKey}: ${line}`);
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match === null) throw new Error(`yaml: unsupported line: ${line}`);
    const key = match[1]!;
    const value = match[2] ?? "";
    listKey = key;
    const trimmed = stripQuotes(value.trim());
    out[key] = value.trim() === "" ? "" : trimmed;
    if (key === "evaluation_cases") {
      out[key] = value.trim() === "" ? [] : [trimmed];
      listKey = key;
    }
  }
  return out;
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Validate one parsed manifest object. */
export function validateMechanismManifest(record: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const field of MECHANISM_REQUIRED_FIELDS) {
    const value = record[field];
    if (value === undefined || value === "") errors.push(`missing required field: ${field}`);
  }
  if (record.id !== undefined && String(record.id).trim() === "") {
    errors.push("id must be non-empty");
  }
  if (record.status !== undefined && !(MECHANISM_STATUS as readonly string[]).includes(String(record.status))) {
    errors.push(`status must be one of: ${MECHANISM_STATUS.join(", ")}`);
  }
  if (record.category !== undefined && !MECHANISM_CATEGORY_SET.includes(String(record.category))) {
    errors.push(`category must be one of: ${MECHANISM_CATEGORIES.join(", ")}`);
  }
  if (record.provenance !== undefined && !MECHANISM_PROVENANCE_SET.includes(String(record.provenance))) {
    errors.push(`provenance must be one of: ${MECHANISM_PROVENANCE.join(", ")}`);
  }
  if (record.provenance === "derived" && (record.attribution === undefined || record.attribution === "")) {
    errors.push("provenance=derived requires attribution naming exactly what was carried over and from where");
  }
  if (record.evaluation_cases !== undefined && !Array.isArray(record.evaluation_cases)) {
    errors.push("evaluation_cases must be a list");
  }
  return errors;
}

/** Validate every manifest in a directory (template files start with _). */
export async function validateMechanismsDir(dir: string): Promise<{
  manifests: Array<{ id: string; file: string }>;
  issues: ManifestIssue[];
}> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".yaml") && !n.startsWith("_"));
  const manifests: Array<{ id: string; file: string }> = [];
  const issues: ManifestIssue[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const text = await readFile(file, "utf8");
    let record: Record<string, unknown>;
    try {
      record = parseYaml(text);
    } catch (cause) {
      issues.push({ path: name, errors: [`yaml parse failed: ${String(cause)}`] });
      continue;
    }
    const errors = validateMechanismManifest(record);
    if (errors.length > 0) {
      issues.push({ path: name, errors });
    } else {
      manifests.push({ id: String(record.id), file: name });
    }
  }
  const seen = new Map<string, string>();
  for (const manifest of manifests) {
    const prior = seen.get(manifest.id);
    if (prior !== undefined) {
      issues.push({
        path: manifest.file,
        errors: [`duplicate id "${manifest.id}" (also used by ${prior})`],
      });
    }
    seen.set(manifest.id, manifest.file);
  }
  return { manifests, issues };
}

/** CLI handler for `agent mechanisms <path>`. */
export async function mechanismsCmd(args: string[]): Promise<{ exitCode: number; lines: string[] }> {
  const [target] = args;
  if (target === undefined) {
    return { exitCode: 1, lines: ["usage: agent mechanisms <path>", "", "Validates mechanism manifests (YAML) in a directory or a single file."] };
  }
  try {
    const stat = await import("node:fs").then((fs) => fs.promises.stat(target));
    if (stat.isDirectory()) {
      const { issues } = await validateMechanismsDir(target);
      if (issues.length === 0) return { exitCode: 0, lines: ["all manifests valid"] };
      return {
        exitCode: 1,
        lines: issues.flatMap((i) => [`${i.path}:`, ...i.errors.map((e) => `  - ${e}`)]),
      };
    }
    const text = await import("node:fs/promises").then((fs) => fs.readFile(target, "utf8"));
    const record = parseYaml(text);
    const errors = validateMechanismManifest(record);
    if (errors.length === 0) return { exitCode: 0, lines: ["manifest valid"] };
    return { exitCode: 1, lines: errors };
  } catch (cause) {
    return { exitCode: 1, lines: [`error: ${String(cause)}`] };
  }
}