/**
 * P14-1 — Pure path containment primitive
 *
 * Shared, deterministic, I/O-free path semantics for the capability boundary
 * AND the sandbox manager.  This module is the single source of truth for:
 *
 *   - separator normalisation  (backslash → slash)
 *   - lexical `.` / `..` resolution (no I/O — uses `path.posix` / `path.win32`)
 *   - boundary-aware containment  (sibling roots are never inside)
 *   - case-insensitive folding
 *
 * The contract: "is P inside root?" is answered by this module alone, using
 * ALREADY-CANONICALISED inputs (realpath-resolved from the I/O layer before
 * calling here).  This makes the answer deterministic and independent of the
 * filesystem state at the moment of the check.
 */
import { posix, win32 } from "node:path";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type PathKind = "posix-absolute" | "windows-drive" | "unc" | "relative";

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[/\\]/;
const UNC_RE = /^[/\\]{2}/;

export function classifyPath(p: string): PathKind {
  if (UNC_RE.test(p)) return "unc";
  if (WINDOWS_DRIVE_RE.test(p)) return "windows-drive";
  if (p.startsWith("/")) return "posix-absolute";
  return "relative";
}

// ---------------------------------------------------------------------------
// Lexical normalisation (pure, no I/O)
// ---------------------------------------------------------------------------

/**
 * Normalise path separators to forward slashes, collapse duplicate slashes,
 * and strip trailing slash (except for the root `/`).  A leading double slash
 * (UNC marker, `//server/share`) is preserved.
 */
export function normaliseSeparators(p: string): string {
  const isUnc = p.replace(/\\/g, "/").startsWith("//");
  let s = p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  if (isUnc && !s.startsWith("//")) s = `/${s}`;
  return s;
}

/**
 * Pure lexical resolution of `.` and `..` path segments WITHOUT touching the
 * filesystem.  Uses `path.posix.resolve` / `path.win32.resolve` which are
 * pure string operations on every platform.
 *
 * - Absolute POSIX paths (`/a/b`) → resolved via `posix.resolve`
 * - Windows drive paths (`C:\a\b`) → resolved via `win32.resolve`
 * - UNC paths (`\\server\share\a`) → resolved via `win32.resolve`
 * - Relative paths → segments are resolved lexically (no cwd available),
 *   `..` that would go above the first segment is clamped.
 *
 * The result is forward-slash separated with no trailing slash.
 */
export function lexicalNormalize(p: string): string {
  const kind = classifyPath(p);
  if (kind === "relative") {
    return resolveRelative(p);
  }
  let resolved: string;
  if (kind === "windows-drive" || kind === "unc") {
    // win32.resolve expects backslashes or forward slashes (both work)
    resolved = win32.resolve(p.replace(/\//g, "\\"));
  } else {
    resolved = posix.resolve(p);
  }
  return normaliseSeparators(resolved);
}

/** Pure relative-path `.`/`..` resolution (no cwd). */
function resolveRelative(p: string): string {
  const segments = p.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

// ---------------------------------------------------------------------------
// Boundary-aware containment
// ---------------------------------------------------------------------------

/**
 * Pure boundary-aware containment check.
 *
 * BOTH inputs MUST already be canonical (absolute, normalised, realpath- or
 * lexical-resolved).  This function does NOT resolve `.`/`..` or normalise
 * separators — those steps are the caller's responsibility because they may
 * require I/O (realpath) before calling here.
 *
 * A candidate is inside a root when:
 *   - it equals the root, OR
 *   - its path is `root + "/" + <anything>` (the boundary is enforced by the
 *     trailing slash, so `/tmp/ws-2` is NOT inside `/tmp/ws`).
 *
 * When `caseInsensitive` is true, both sides are lowercased before comparison
 * (intended for macOS / Windows file systems).
 */
export function isPathWithin(
  candidate: string,
  root: string,
  caseInsensitive: boolean,
): boolean {
  const fold = (s: string): string => (caseInsensitive ? s.toLowerCase() : s);
  const c = fold(candidate);
  const r = fold(root);
  if (c === r) return true;
  // r is already canonical with no trailing slash (except "/" for root)
  return c.startsWith(r.endsWith("/") ? r : r + "/");
}