import { classifyCommand } from "./command-classifier.js";
/**
 * P2-31 Test / Build / Lint Command Discovery.
 *
 * The agent should not have to guess `npm test`. Discover the real test / build /
 * lint / typecheck / check commands from the repo's own sources:
 *   - package.json (scripts.test / test:* / build / lint / typecheck) incl. workspaces
 *   - pyproject.toml (pytest / tool.poetry scripts)
 *   - Cargo.toml (cargo test)
 *   - Makefile (test / build / lint / check targets + recipes)
 *   - CI workflows (.github/workflows/*.yml `run:` steps)
 *   - AGENTS.md / CLAUDE.md guidance lines mentioning commands
 *
 * Each discovery is tagged with kind, source, source file and a confidence.
 * `mergeIntoWorkingState` records a compact summary into WorkingState.importantFacts
 * so the full loop can retain the strongest discovered commands without guessing.
 */
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkingState } from "@ar/contracts";
import { listDirs, resolveWorkspace } from "./workspace.js";

export type DiscoveredKind = "test" | "build" | "lint" | "typecheck" | "check" | "verify";
export type DiscoverySource = "package.json" | "pyproject" | "Cargo.toml" | "Makefile" | "CI" | "AGENTS.md";

export interface DiscoveredCommand {
  kind: DiscoveredKind;
  command: string;
  source: DiscoverySource;
  file: string;
  confidence: "high" | "medium" | "low";
}

export interface CommandDiscoveryResult {
  root: string;
  discovered: DiscoveredCommand[];
  sourceFilesChecked: string[];
}

const KINDS: DiscoveredKind[] = ["test", "build", "lint", "typecheck", "check", "verify"];

const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store", "dist", "build", "coverage", ".next", "target"]);
const MAX_DISCOVERED = 60;

const SCRIPT_KIND_ORDER: Array<[RegExp, DiscoveredKind]> = [
  [/^test(?:$|[:\-])/, "test"],
  [/^lint$|(?:^|[-_:])lint/, "lint"],
  [/^typecheck$|^tsc\b/, "typecheck"],
  [/^build$/, "build"],
  [/^check$/, "check"],
  [/^verify/, "verify"],
];

/** P8-4: classification is delegated to the SHARED classifier so discovery,
 *  the verification plan builder and working-state classification agree on
 *  what a command is. */
function classify(cmd: string): { kind: DiscoveredKind; confidence: "high" | "medium" } | null {
  const result = classifyCommand(cmd);
  if (result.category === "other") return null;
  return { kind: result.category as DiscoveredKind, confidence: result.confidence as "high" | "medium" };
}

/** Walk a repo directory returning repo-relative file paths, skipping dep dirs. */
async function listFiles(root: string, max = 20_000): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await fs.readdir(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const subRel = rel ? `${rel}/${e.name}` : e.name;
      const subDir = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(subDir, subRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push(subRel);
      }
    }
  }
  await walk("", "");
  return out;
}

async function readIfExists(root: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function parsePackageJson(rel: string, text: string, out: DiscoveredCommand[]): void {
  let m: { scripts?: Record<string, string> };
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  const scripts = m.scripts ?? {};
  for (const name of Object.keys(scripts)) {
    const cmd = scripts[name];
    if (typeof cmd !== "string" || cmd.length === 0) continue;
    let kind: DiscoveredKind | null = null;
    for (const [re, k] of SCRIPT_KIND_ORDER) {
      if (re.test(name)) {
        kind = k;
        break;
      }
    }
    if (!kind) continue;
    out.push({ kind, command: cmd, source: "package.json", file: rel, confidence: "high" });
  }
}

function findPackageManifests(files: string[], memberDirs: Set<string> | null): string[] {
  // root manifest first, then nested package.json (workspaces), honoring the
  // declared workspace member set when the repo scopes packages explicitly.
  const nested = files
    .filter((f) => f.endsWith("/package.json") && !f.startsWith("node_modules") && !f.startsWith(".git"))
    .filter((f) => {
      if (!memberDirs) return true;
      const dir = f.slice(0, f.length - "/package.json".length);
      return dir === "" || memberDirs.has(dir);
    })
    .sort();
  return ["package.json", ...nested];
}

function parseMakefile(text: string, file: string): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  const targetRe = /^\s*([a-zA-Z0-9_.][\w./-]*)\s*:\s*(?:[^=].*)?$/gm;
  let m: RegExpExecArray | null;
  const kernels: Array<{ name: string; label: string; line: number }> = [];
  while ((m = targetRe.exec(text)) !== null) {
    const name = m[1]!;
    const parts = name.split("/");
    const label = (parts[parts.length - 1] ?? "").toLowerCase();
    kernels.push({ name, label, line: text.slice(0, m.index).split("\n").length });
  }
  for (const t of kernels) {
    const kind = kindOfMakeLabel(t.label);
    if (!kind) continue;
    const recipe = recipeFor(text, t.line);
    out.push({ kind, command: recipe || `make ${t.name}`, source: "Makefile", file, confidence: recipe ? "high" : "medium" });
  }
  return out.slice(0, 12);
}

function kindOfMakeLabel(label: string): DiscoveredKind | null {
  if (label === "test" || label === "spec") return "test";
  if (label === "check") return "check";
  if (label === "build" || label === "compile" || label === "dist") return "build";
  if (label === "lint" || label === "style") return "lint";
  if (label === "typecheck" || label === "tsc") return "typecheck";
  if (label === "verify") return "verify";
  return null;
}

function recipeFor(text: string, targetLine: number): string | null {
  const lines = text.split("\n");
  for (let i = targetLine; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > targetLine && /^\S/.test(line)) break; // next target
    const m = /^\t+(.+)$/.exec(line) ?? /^\s{2,}([^\s#].+)$/.exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
}

function parseGuidance(text: string, file: string): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  for (const line of text.split("\n")) {
    if (!/run|command|test|build|lint/.test(line.toLowerCase())) continue;
    const m = /(npm|yarn|pnpm|bun|cargo|make|go|python|poetry)\s+[^\n`]+/.exec(line);
    if (m) {
      const got = classify(m[0]!);
      if (got) out.push({ kind: got.kind, command: m[0]!.replace(/`/g, "").trim(), source: "AGENTS.md", file, confidence: "low" });
    }
  }
  return out.slice(0, 8);
}

/** Leading-space count of a line (0 for no indentation). */
function indentationOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

/**
 * Robust CI `run:` extraction (P2-30+ multi-line YAML completeness). Unlike a
 * single regex, this line scanner understands YAML block scalars:
 *   - literal blocks `|`, `|+`, `|-` (each content line = its own command)
 *   - folded blocks `>`, `>+`, `>-` (content lines joined with a space)
 *   - block content indented deeper than the `run:` key, ending at the next
 *     top-level key / `-` sequence item / document marker (`---`) / EOF
 *   - `env:` / `working-directory:` keys that precede `run:` in a step
 *
 * Each shell segment (`&&`, `||`, `;`, `|`) is classified; results are
 * deduplicated by kind+command. An approximate parse never fabricates commands
 * that aren't present, so misses are safe for a hint-layer feature.
 */
export function parseCiRuns(text: string, file: string): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");

  const addSegments = (cmd: string): void => {
    for (const seg of cmd.split(/[;&|]{1,2}/).map((s) => s.trim()).filter(Boolean)) {
      const got = classify(seg);
      if (!got) continue;
      const key = `${got.kind}:${seg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: got.kind, command: seg, source: "CI", file, confidence: got.confidence });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)(?:-\s+)?run\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const runIndent = m[1]!.length;
    const tail = m[2]!.trim();

    // Inline scalar: `run: npm test`.
    if (tail !== "" && !/^[|>]/.test(tail)) {
      addSegments(tail);
      continue;
    }

    // Block scalar `|` (literal) or `>` (folded); chomping (+/-) is irrelevant
    // for command hints.
    const folded = tail.startsWith(">");
    const block: string[] = [];
    let j = i + 1;
    // First content indent is the first non-blank, data line deeper than the key.
    let contentIndent: number | null = null;
    while (j < lines.length) {
      const nl = lines[j]!;
      if (nl.trim() === "") {
        if (contentIndent !== null) block.push(""); // preserve blank join for folded
        j++;
        continue;
      }
      const nIndent = indentationOf(nl);
      // A new mapping key, sequence item, or document marker at the same or
      // lesser indentation ends the scalar.
      if (nIndent <= runIndent && /^\s*(?:-\s+)?[A-Za-z0-9_][\w.-]*\s*:/.test(nl) ) {
        break;
      }
      if (nIndent <= runIndent && /^\s*---/.test(nl)) {
        break;
      }
      if (contentIndent === null) contentIndent = Math.max(nIndent, runIndent + 1);
      // Strip the scalar's content indentation.
      const content = nl.slice(contentIndent);
      const trimmed = content.replace(/\s+$/, "");
      if (trimmed.startsWith("#")) {
        j++;
        continue; // comment line inside the block
      }
      if (trimmed !== "") block.push(trimmed);
      j++;
    }

    if (folded) {
      addSegments(block.join(" "));
    } else {
      for (const b of block) if (b.trim() !== "") addSegments(b);
    }
    i = j - 1; // skip the consumed block lines
  }
  return out;
}

async function discoverFromFiles(root: string): Promise<CommandDiscoveryResult> {
  const discovered: DiscoveredCommand[] = [];
  const sourceFilesChecked: string[] = [];
  const files = await listFiles(root);

  // P2-30+: monorepo workspace glob awareness — when the repo declares
  // workspaces (pnpm-workspace.yaml / package.json#workspaces), restrict nested
  // package boundaries to concrete member dirs.
  const dirs = await listDirs(root);
  const ws = await resolveWorkspace(root, dirs);
  const memberDirs = ws.explicit ? new Set(ws.members) : null;

  const manifests = findPackageManifests(files, memberDirs);
  for (const rel of manifests) {
    const text = await readIfExists(root, rel);
    if (text === null) continue;
    sourceFilesChecked.push(rel);
    parsePackageJson(rel, text, discovered);
  }

  const top = ["pyproject.toml", "Cargo.toml", "Makefile", "AGENTS.md", "CLAUDE.md"];
  for (const c of top) {
    if (!files.includes(c)) continue;
    sourceFilesChecked.push(c);
    const text = await readIfExists(root, c);
    if (text === null) continue;
    if (c === "pyproject.toml") {
      if (/\[tool\.poetry\]/m.test(text)) {
        const sm = /scripts\s*=\s*\{([^}]*)\}/m.exec(text);
        if (sm) {
          for (const seg of sm[1]!.split(/[,\n]/)) {
            const kv = /^\s*"(test|build|lint|check|typecheck)"\s*=\s*"([^"]+)"/.exec(seg);
            if (kv) discovered.push({ kind: kv[1] as DiscoveredKind, command: kv[2]!, source: "pyproject", file: c, confidence: "high" });
          }
        }
      }
      discovered.push({ kind: "test", command: "pytest", source: "pyproject", file: c, confidence: "medium" });
    } else if (c === "Cargo.toml") {
      discovered.push({ kind: "test", command: "cargo test", source: "Cargo.toml", file: c, confidence: "high" });
      discovered.push({ kind: "check", command: "cargo check", source: "Cargo.toml", file: c, confidence: "medium" });
    } else if (c === "Makefile") {
      for (const d of parseMakefile(text, c)) discovered.push(d);
    } else {
      for (const d of parseGuidance(text, c)) discovered.push(d);
    }
  }

  const ciFiles = files
    .filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
    .slice(0, 5);
  for (const rel of ciFiles) {
    sourceFilesChecked.push(rel);
    const text = await readIfExists(root, rel);
    if (text === null) continue;
    for (const d of parseCiRuns(text, rel)) discovered.push(d);
  }

  discovered.sort(
    (a, b) =>
      confidenceRank(a) - confidenceRank(b) ||
      (a.source === "package.json" ? -1 : b.source === "package.json" ? 1 : 0),
  );
  return { root: resolve(root), discovered: discovered.slice(0, MAX_DISCOVERED), sourceFilesChecked };
}

function confidenceRank(d: DiscoveredCommand): number {
  return d.confidence === "high" ? 0 : d.confidence === "medium" ? 1 : 2;
}

/** Pick the single strongest command per kind. */
export function summarize(discovered: DiscoveredCommand[]): Partial<Record<DiscoveredKind, string>> {
  const best: Partial<Record<DiscoveredKind, string>> = {};
  for (const kind of KINDS) {
    const pick = discovered
      .filter((d) => d.kind === kind)
      .sort((a, b) => confidenceRank(a) - confidenceRank(b) || (a.source === "package.json" ? -1 : 1))[0];
    if (pick) best[kind] = pick.command;
  }
  return best;
}

/**
 * Write a compact, deduped summary into WorkingState.importantFacts so the run
 * loop retains the strongest discovered commands without guessing.
 */
export function mergeIntoWorkingState(state: WorkingState, result: CommandDiscoveryResult): void {
  const summary = summarize(result.discovered);
  for (const kind of KINDS) {
    const cmd = summary[kind];
    if (!cmd) continue;
    const entry = `discovered ${kind} command: ${cmd} (${result.root})`;
    if (!state.importantFacts.includes(entry)) state.importantFacts.push(entry);
  }
  if (result.sourceFilesChecked.length > 0) {
    const note = `command discovery sources: ${result.sourceFilesChecked.join(", ")}`;
    if (!state.importantFacts.includes(note)) state.importantFacts.push(note);
  }
}

export async function discoverCommands(root: string): Promise<CommandDiscoveryResult> {
  return discoverFromFiles(root);
}