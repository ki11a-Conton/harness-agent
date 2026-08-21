/**
 * P2-8: mechanism registry tooling. Manifests live in research/mechanisms/
 * as YAML; this module validates them (structure + id uniqueness) so the
 * registry stays consistent. Minimal YAML subset parser (scalar keys,
 * list items, comments) — no external dependency.
 */
export declare const MECHANISM_STATUS: readonly ["candidate", "proposed", "evaluating", "accepted", "rejected", "shipped"];
export declare const MECHANISM_CATEGORIES: readonly ["prompting", "memory", "planning", "tool_use", "learning", "scheduling", "error_recovery", "context_management", "evaluation", "security", "other"];
export declare const MECHANISM_CATEGORY_SET: readonly string[];
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
export declare const MECHANISM_PROVENANCE: readonly ["original", "inspired", "reimplemented", "derived"];
export declare const MECHANISM_PROVENANCE_SET: readonly string[];
export declare const MECHANISM_REQUIRED_FIELDS: readonly ["id", "source_agent", "source_report", "provenance", "category", "problem", "preconditions", "expected_benefit", "risks", "implementation_scope", "evaluation_cases", "status"];
export interface ManifestIssue {
    path: string;
    errors: string[];
}
/** Minimal YAML subset parser: `key: value` lines, `- item` lists, `#` comments. */
export declare function parseYaml(text: string): Record<string, unknown>;
/** Validate one parsed manifest object. */
export declare function validateMechanismManifest(record: Record<string, unknown>): string[];
/** Validate every manifest in a directory (template files start with _). */
export declare function validateMechanismsDir(dir: string): Promise<{
    manifests: Array<{
        id: string;
        file: string;
    }>;
    issues: ManifestIssue[];
}>;
/** CLI handler for `agent mechanisms <path>`. */
export declare function mechanismsCmd(args: string[]): Promise<{
    exitCode: number;
    lines: string[];
}>;
//# sourceMappingURL=mechanisms.d.ts.map