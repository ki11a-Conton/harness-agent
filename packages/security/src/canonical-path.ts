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

/** P36-6 (INV-P36-006): typed canonicalization failure. */
export interface CanonicalizationError {
  ok: false;
  code: "permission" | "symlink_loop" | "io" | "depth" | "invalid" | "unknown";
  path: string;
  message: string;
}

export class CanonicalizationFailed extends Error {
  readonly ok = false as const;
  readonly code: CanonicalizationError["code"];
  readonly path: string;
  constructor(code: CanonicalizationError["code"], path: string, detail: string) {
    super(`canonicalization failed: ${code} for ${path}: ${detail}`);
    this.name = "CanonicalizationFailed";
    this.code = code;
    this.path = path;
  }
}

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
 *
 * P36-6 (INV-P36-006): only ENOENT/ENOTDIR fall back to the ancestor
 * heuristic.  EACCES, EPERM, ELOOP, EIO, and other errors throw a typed
 * CanonicalizationFailed — path containment decisions are denied, never
 * silently bypassed.
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
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    // P36-6: only ENOENT/ENOTDIR are eligible for the ancestor fallback.
    if (nodeErr.code === "ENOENT" || nodeErr.code === "ENOTDIR") {
      return canonicalAncestorAndTail(normalized);
    }
    // All other errors fail closed.
    throw classifyCanonicalError(nodeErr, normalized);
  }
}

/** P36-6: classify a non-ENOENT realpath error into a typed failure. */
function classifyCanonicalError(err: NodeJS.ErrnoException, path: string): CanonicalizationFailed {
  switch (err.code) {
    case "EACCES":
    case "EPERM":
      return new CanonicalizationFailed("permission", path, err.message);
    case "ELOOP":
      return new CanonicalizationFailed("symlink_loop", path, err.message);
    case "EIO":
      return new CanonicalizationFailed("io", path, err.message);
    default:
      return new CanonicalizationFailed("unknown", path, err.message);
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
      // P14-1 regression fix: the POSIX root ancestor is "/" — a naive
      // `${ancestor}/${tail}` join produces "//tail", which lexicalNormalize
      // classifies as a UNC marker (leading "//") and preserves as a double
      // slash. The canonical form then never matches containment roots, so
      // every non-existent path whose deepest existing ancestor is the
      // filesystem root was misreported as an escalation on POSIX. Join with
      // an empty base for the root instead.
      const base = ancestor === "/" ? "" : ancestor;
      // Resolve the tail lexically against the canonical ancestor so that any
      // `..` in the not-yet-existing portion can never climb past the
      // canonical ancestor (which may itself be a symlink-resolved path).
      return lexicalNormalize(`${base}/${tail}`);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      // P36-6: only missing-path errors let us keep walking up.  Any other
      // error (EACCES/EPERM/ELOOP/EIO/…) is an ambiguous canonicalization and
      // must fail closed.
      if (nodeErr.code !== "ENOENT" && nodeErr.code !== "ENOTDIR") {
        throw classifyCanonicalError(nodeErr, p);
      }
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
  // P37-10 (INV-P37-011): ancestor depth exhaustion FAILS CLOSED — never
  // return a potentially non-canonical path (a containment bypass risk).
  throw new CanonicalizationFailed(
    "depth",
    p,
    "ancestor resolution exceeded maximum depth",
  );
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