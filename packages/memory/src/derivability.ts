import type { DerivationVerdict } from "@ar/contracts";

/**
 * P17-1 derivability rule: facts that can be re-derived from the repository /
 * git history / AGENTS.md / config must NOT be stored as long-term memory —
 * they are cheap to re-obtain and re-derivation never goes stale. Memory is
 * reserved for what CANNOT be re-derived:
 *
 *   - user preferences / personal constraints
 *   - non-obvious project decisions (why a choice was made, not what it was)
 *   - failure lessons / root causes
 *   - environment characteristics (toolchain quirks, CI specifics)
 *   - underivable constraints (timing, external availability, hidden state)
 *
 * The classifier is rule-based and deterministic (never LLM): content that
 * smells like re-derivable state (paths, commands, git/dependency facts,
 * AGENTS.md-style instructions) is marked derivable with a reason; explicit
 * preference / decision / lesson / environment markers are non-derivable.
 */

/** Signals that the content is re-derivable state (repo/git/config-facts). */
const DERIVABLE_MARKERS: ReadonlyArray<RegExp> = [
  /\.md\b|AGENTS\.md|README|CONTRIBUTING/i, // repo instruction files
  /`(?:git|npm|pnpm|yarn|cargo|pip|mvn|go)\b[^`]*`/i, // command facts
  /\b(?:path|directory|file)\s+(?:is|at)\s+[`'"]?[\w./~-]+/i, // path facts
  /\b(?:depends?|dependency|package|lockfile|config)\b/i, // dependency facts
  /\bworkspace\s+(?:contains?|has|includes?)\b/i, // repo structure facts
];

/** Signals that the content is a NON-derivable, memory-worthy fact. */
const NON_DERIVABLE_MARKERS: ReadonlyArray<RegExp> = [
  /(?:prefer|prefers?|likes?|liked|wants?|wanted|choose|chose|decision|decided)\b/i,
  /(?:do not|don't|never|avoid|prefer not|must not)\b/i,
  /(?:lesson|learned|mistake|root cause|failed because|breakage)\b/i,
  /(?:environment|ci|toolchain|compiler|sandbox|network proxy|offline)\b/i,
  /(?:constraint|requirement|must|required)\b/i,
];

/** P17-1: deterministic derivability verdict for a memory candidate. */
export function assessDerivability(content: string): DerivationVerdict {
  // A content that is at once a repo-fact AND a user preference is a user
  // preference (memory-worthy): check non-derivable markers FIRST so
  // "the user prefers npm over pnpm" is not classified as derivable.
  for (const marker of NON_DERIVABLE_MARKERS) {
    if (marker.test(content)) {
      return {
        verdict: "non-derivable",
        reason: `expresses a ${describeMarker(marker)} — a preference/decision/lesson that cannot be re-derived`,
      };
    }
  }
  for (const marker of DERIVABLE_MARKERS) {
    if (marker.test(content)) {
      return {
        verdict: "derivable",
        reason: `re-derivable from repo/git/config (${describeMarker(marker)})`,
      };
    }
  }
  // No marker: default conservative — treat as non-derivable (do not drop
  // legitimately useful memories on a classifier miss; the promotion gate
  // still enforces importance/novelty).
  return {
    verdict: "non-derivable",
    reason: "no re-derivable-state signal detected",
  };
}

function describeMarker(marker: RegExp): string {
  return marker.source.replace(/\\/g, "");
}

/** P17-1: should a candidate be accepted for long-term memory given its
 *  derivability verdict? Derivable facts are rejected by default. */
export function isMemoryWorthy(verdict: DerivationVerdict): boolean {
  return verdict.verdict === "non-derivable";
}
