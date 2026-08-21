/**
 * P14-1 — Canonical path resolution (I/O layer).
 *
 * The one place filesystem-truth (realpath) enters path containment.  This
 * module canonicalises a raw target path into the form the pure containment
 * primitive (`@ar/contracts` `isPathWithin`) compares:
 *
 *   1. control-char / NUL rejection
 *   2. relative → absolute resolution against the working directory
 *   3. separator normalisation
 *   4. realpath of the FULL path when it exists (resolves symlinks/junctions
 *      and lets the OS apply `.`/`..` semantics against real directory inodes)
 *   5. for non-existent paths: realpath of the deepest existing ancestor +
 *      the remaining segments, then lexical `.`/`..` resolution of the tail
 *      against the canonical ancestor (so a not-yet-existing write target can
 *      never smuggle `..` past the boundary)
 *
 * Both SandboxManager and the capability guard call this module — one
 * canonicalisation semantic for every filesystem decision.
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isPathWithin, lexicalNormalize, normaliseSeparators } from "@ar/contracts";

export interface CanonicalizeOptions {
  /** Working directory used to resolve relative paths. */
  cwd: string;
}

/**
 * Canonicalise `target` for containment checks.  Throws on empty input and
 * NUL/control characters (never silently accepts a degenerate path).
 *
 * Returns a forward-slash separated, absolute, canonical path:
 *   - existing path        → realpath (symlinks/junctions resolved)
 *   - non-existent path    → realpath(deepest existing ancestor) + tail,
 *                            with `.`/`..` in the tail lexically resolved
 *                            against the canonical ancestor
 */
export function canonicalizePath(target: string, opts: CanonicalizeOptions): string {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`cannot canonicalize empty path`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(target)) {
    throw new Error(`cannot canonicalize path with control characters`);
  }

  const absolute = isAbsolute(target) ? target : resolve(opts.cwd, target);
  const normalized = normaliseSeparators(absolute);

  try {
    // Full realpath: existing path (also resolves symlinks and lets the OS
    // resolve `.`/`..` against real directory inodes).
    return normaliseSeparators(realpathSync(normalized));
  } catch {
    // Non-existent (at least not fully): canonical ancestor + lexically
    // resolved tail.
    return canonicalAncestorAndTail(normalized);
  }
}

/** Realpath the deepest existing ancestor of `p` (which is absolute and
 *  separator-normalised), then append the remaining non-existing segments and
 *  lexically resolve any `.`/`..` in them against the canonical ancestor. */
function canonicalAncestorAndTail(p: string): string {
  // Walk up: find the deepest ancestor that exists on disk.
  let current = p;
  const walked: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const ancestor = normaliseSeparators(realpathSync(current));
      // `current` is the canonicalised deepest existing ancestor; the segments
      // between it and the original path (reversed order in `walked`) are the
      // non-existing tail.
      const tail = walked.reverse().join("/");
      if (!tail) return ancestor;
      // Resolve the tail lexically against the canonical ancestor so that any
      // `..` in the not-yet-existing portion can never climb past the
      // canonical ancestor (which may itself be a symlink-resolved path).
      return lexicalNormalize(`${ancestor}/${tail}`);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // At the filesystem root and nothing exists — return the root.
        return current;
      }
      // Use "/" explicitly — the path is already separator-normalised.
      const slashIdx = current.lastIndexOf("/");
      walked.push(slashIdx >= 0 ? current.slice(slashIdx + 1) : current);
      current = parent;
    }
  }
  // Safety net — walk above the cap: return the (possibly non-canonical) path.
  return current;
}

/**
 * Convenience: canonicalise a path and check it is within a canonical root
 * using the shared pure containment primitive.  Keeps the two canonicalisation
 * sides (target and root) on the same code path.
 */
export function isPathCanonicallyWithin(
  target: string,
  root: string,
  cwd: string,
  caseInsensitive: boolean,
): boolean {
  const t = canonicalizePath(target, { cwd });
  const r = canonicalizePath(root, { cwd });
  return isPathWithin(t, r, caseInsensitive);
}