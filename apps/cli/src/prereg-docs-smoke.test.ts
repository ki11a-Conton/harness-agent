/**
 * N7 — the READ-ONLY documentation inputs are executable facts, not prose.
 * plan(20260926-175819).md §N7 (line 117), 怎么做 items 2 and 3.
 *
 * What this pins, offline and with NO provider key:
 *   - the committed approval template can NEVER be mistaken for a valid approval:
 *     it is `paid:false`, unsigned, and every value is a placeholder the loader
 *     refuses (a placeholder that parsed would be a paid-run footgun);
 *   - the committed read-only build input carries NO inline catalog/selection
 *     (the form `prereg build` refuses) and a REPO-RELATIVE root, so the
 *     documented commands are portable.
 *
 * It deliberately does NOT claim `prereg build` exits 0 from the committed file:
 * a legal config needs arm build-closure digests that only exist once two REAL
 * arm checkouts exist (N1, NOT_PROVEN). That gap is reported, not papered over.
 *
 * SAFETY: file reads and a pure parser call. Zero network, zero provider, zero
 * cost, no key.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAndValidateAuthorizationV2 } from "@ar/evaluation";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEMPLATE = join(REPO_ROOT, "docs", "evidence", "prereg-paid-approval.template.json");
const READONLY_CONFIG = join(REPO_ROOT, "docs", "evidence", "prereg-build.readonly.config.json");

describe("N7 — documented read-only inputs behave as documented", () => {
  it("[N7.1] the committed approval template is REFUSED as an authorization", () => {
    const text = readFileSync(TEMPLATE, "utf8");
    const parsed = JSON.parse(text) as { paid: unknown; approvalId: unknown };
    // The template is not a paid approval and is not signed.
    expect(parsed.paid).toBe(false);
    expect(String(parsed.approvalId)).toContain("<");
    // THE INVARIANT: as written, no loader may accept it. A template that parsed
    // into a valid admission would be a standing paid-run hazard.
    expect(() => parseAndValidateAuthorizationV2(text)).toThrow();
  }, 60_000);

  it("[N7.2] the approval template lands in the parser as a stable refusal code", () => {
    let code = "NO_THROW";
    try {
      parseAndValidateAuthorizationV2(readFileSync(TEMPLATE, "utf8"));
    } catch (err) {
      code = String((err as { code?: unknown }).code ?? "NO_CODE");
    }
    expect(code).not.toBe("NO_THROW");
    // Whatever the code, it is a refusal — never an admitted campaign.
    expect(code).not.toBe("ADMITTED");
  }, 60_000);

  it("[N7.3] the read-only build input has NO inline catalog/selection and a portable root", () => {
    const cfg = JSON.parse(readFileSync(READONLY_CONFIG, "utf8")) as Record<string, unknown> & {
      selectionEvidence?: { root?: unknown };
    };
    // The form the CLI refuses must not appear in the committed example.
    expect(cfg["catalog"]).toBeUndefined();
    expect(cfg["selection"]).toBeUndefined();
    expect(cfg["candidateId"]).toBe("tool_call_efficiency_v1");
    // Repo-relative: never an absolute Windows path or a POSIX absolute path.
    const root = cfg.selectionEvidence?.root;
    expect(typeof root).toBe("string");
    expect(String(root)).not.toMatch(/^[A-Za-z]:[\\/]/);
    expect(String(root)).not.toMatch(/^\//);
  }, 60_000);

  it("[N7.4] no documentation file links through a non-portable file:// URL", () => {
    // `file:///workspace/...` links resolved on the author's machine and nowhere
    // else. They were replaced with repo-relative links; this keeps them gone.
    const matrix = readFileSync(join(REPO_ROOT, "docs", "evidence", "prereg-next-gap-matrix.md"), "utf8");
    const report = readFileSync(join(REPO_ROOT, "docs", "evidence", "tool-call-efficiency-p1-p7-report.md"), "utf8");
    expect(matrix).not.toContain("file:///");
    expect(report).not.toContain("file:///");
  }, 60_000);
});
