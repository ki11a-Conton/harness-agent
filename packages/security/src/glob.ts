/**
 * Gitignore-style glob matching used by permission rules and sandbox checks.
 * Supported: `**` (any segments, optional), `*` (within a segment), `?` (one char).
 * Patterns are matched against normalized `/`-separated paths.
 */

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function globToRegex(pattern: string): RegExp {
  const p = normalizePath(pattern);
  const chars = p.split("");
  let re = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "*") {
      if (chars[i + 1] === "*") {
        i += 1;
        if (chars[i + 1] === "/") {
          // `**/` may match zero segments (also matches plain filenames)
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "/") {
      re += "/";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(pattern: string, target: string): boolean {
  const p = normalizePath(pattern);
  const t = normalizePath(target);
  if (matchNormalizedGlob(p, t)) return true;
  // A pattern with no directory separator may also match the basename.
  if (!p.includes("/")) {
    const separator = t.lastIndexOf("/");
    return separator >= 0 && matchNormalizedGlob(p, t.slice(separator + 1));
  }
  return false;
}

/**
 * Match the same language as globToRegex without regex backtracking. Repeated
 * stars followed by a missing suffix otherwise block both tool cancellation
 * and permission evaluation. Each row records reachable target offsets after
 * one pattern token: O(pattern.length * target.length) time, O(target.length)
 * space. Keep globToRegex available for callers that need the RegExp itself.
 */
function matchNormalizedGlob(pattern: string, target: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === target;
  // Every literal and '?' needs one code unit. Reject impossible long patterns
  // before allocating or walking a DP row for each token. A '**/' is optional.
  let minimumLength = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
      }
    } else if (++minimumLength > target.length) return false;
  }
  let previous = new Uint8Array(target.length + 1);
  let current = new Uint8Array(target.length + 1);
  previous[0] = 1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    current.fill(0);
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        let optionalSlash = pattern[i + 1] === "/";
        if (optionalSlash) i++;
        // Adjacent dot-star tokens have the same character alphabet. '**/'
        // composed with itself is still '**/'; if either token is '**', their
        // composition is '**'. Fold long runs without one DP row per star.
        while (pattern[i + 1] === "*" && pattern[i + 2] === "*") {
          i += 2;
          const nextSlash = pattern[i + 1] === "/";
          if (nextSlash) i++;
          optionalSlash = optionalSlash && nextSlash;
        }
        if (optionalSlash) {
          // `(?:.*/)?`: empty, or a dot-compatible prefix ending in '/'.
          // The prefix state must survive intervening non-slash characters.
          let prefix = false;
          for (let j = 0; j <= target.length; j++) {
            current[j] = previous[j]!;
            if (j > 0) {
              const ch = target[j - 1]!;
              prefix = isDotCharacter(ch) && (prefix || previous[j - 1] === 1);
              if (ch === "/" && prefix) current[j] = 1;
            }
          }
        } else {
          for (let j = 0; j <= target.length; j++) {
            current[j] = previous[j] || (j > 0 && isDotCharacter(target[j - 1]!) ? current[j - 1]! : 0);
          }
        }
      } else {
        for (let j = 0; j <= target.length; j++) {
          current[j] = previous[j] || (j > 0 && target[j - 1] !== "/" ? current[j - 1]! : 0);
        }
      }
    } else {
      for (let j = 1; j <= target.length; j++) {
        if (previous[j - 1] && (c === "?" ? target[j - 1] !== "/" : target[j - 1] === c)) current[j] = 1;
      }
    }
    [previous, current] = [current, previous];
  }
  return previous[target.length] === 1;
}

// JavaScript '.' without the s/u flags excludes these four UTF-16 code units;
// [^/] and '?' deliberately still accept them, as in the compatibility regex.
function isDotCharacter(char: string): boolean {
  return char !== "\n" && char !== "\r" && char !== "\u2028" && char !== "\u2029";
}
