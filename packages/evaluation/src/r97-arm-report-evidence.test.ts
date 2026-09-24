/**
 * E4-R99-A (plan T3 / findings N4, N5) — REAL RESULTS, STRICT CLASSIFICATION.
 *
 * MEASURED DEFECTS (plan §0.2):
 *
 *   N5 "classifyReport 找不到 task_id 时使用 results[0]，并把 success=true 直接报告为
 *      verifierPassed；finally 删除原报告；resultHash 仅摘要化描述文本"
 *
 *   N4 "isDone 只判断状态；不验证 resultHash/inputDigest；driver 汇总只看本次新增结果"
 *
 * The §0.3 probe that makes N5 concrete:
 *
 *   "不匹配报告 | 只有 different-case，success=true、…" — a report whose ONLY row
 *   belongs to a DIFFERENT case was accepted as this case's verdict.
 *
 * THE CONTRACT (plan §T3 怎么验收):
 *
 *   "错案例、空报告、重复 task_id、旧 attempt 报告、不匹配 suite/build 均拒绝."
 *   "文件写入 fixture：'只说 done' 验证失败，真正工具写入才通过；预期拒绝类案例按其
 *    自己的 judge 合同评分."
 *   "修改/删除任意已关联原始报告或 resultHash，恢复及独立 validator 都非零退出."
 *   "worker 结束后原报告仍存在；validator 读的是本次 driver 的产物."
 *
 * Plan §T3 怎么做 3 is the subtle one and this file pins it exactly:
 *
 *   "不同 suite 可能以预期拒绝或预期失败为成功，不能一刀切要求所有 benchmark success 的
 *    verification_passed=true；但 verifiedPasses 必须确有 verifier 证据，名称与含义一致."
 *
 * So a PASS is NOT "success === true". A pass is "the report's own verdict says the
 * case met ITS contract", and the evidence for that differs by suite. What is
 * NEVER acceptable is calling something a verified pass when the report contains
 * no verification evidence at all.
 *
 * No provider is constructed and no network call is made in this file.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const WORKER = pathToFileURL(join(REPO, "scripts", "e4", "r97-arm-worker.mjs")).href;

interface Classified {
  passed: boolean;
  category: string | null;
  detail: string;
}

const mod = (await import(WORKER)) as {
  classifyReport: (report: unknown, caseId: string) => Classified;
  reportRowFor: (report: unknown, caseId: string) => Record<string, unknown> | null;
};

const CASE_ID = "r98-tool-write-request";
const OTHER_CASE_ID = "r98-tool-write-second";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A report row that is a clean, fully-evidenced pass for `taskId`. */
function passingRow(taskId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: taskId,
    suite: "regression",
    judge_version: "1.0.0",
    success: true,
    actual_status: "completed",
    verification_passed: true,
    verification_failures: 0,
    model_calls: 2,
    tool_calls: 1,
    termination_reason: "verified_complete",
    ...over,
  };
}

describe("R99-A C1: only the REQUESTED case may be accepted", () => {
  it("REFUSES a report whose only row belongs to a DIFFERENT case", () => {
    // §0.3: "不匹配报告 | 只有 different-case，success=true …" was ACCEPTED,
    // because `find(...) ?? results[0]` fell back to whatever row existed. A
    // verdict about another case is not evidence about this one.
    const verdict = mod.classifyReport({ results: [passingRow(OTHER_CASE_ID)] }, CASE_ID);
    expect(verdict.passed).toBe(false);
    expect(verdict.category).toBe("infrastructure");
    expect(verdict.detail).toContain(CASE_ID);
  });

  it("REFUSES a report with several rows when NONE is the requested case", () => {
    const verdict = mod.classifyReport(
      { results: [passingRow("alpha"), passingRow("beta"), passingRow("gamma")] },
      CASE_ID,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.category).toBe("infrastructure");
  });

  it("ACCEPTS the requested case among unrelated rows", () => {
    const verdict = mod.classifyReport({ results: [passingRow("alpha"), passingRow(CASE_ID)] }, CASE_ID);
    expect(verdict.passed).toBe(true);
    expect(verdict.category).toBeNull();
  });

  it("REFUSES an empty report — a missing measurement is never a pass", () => {
    const verdict = mod.classifyReport({ results: [] }, CASE_ID);
    expect(verdict.passed).toBe(false);
    expect(verdict.category).toBe("infrastructure");
    expect(verdict.detail).toContain(CASE_ID);
  });

  it("REFUSES a report with no `results` array at all", () => {
    for (const bad of [null, undefined, {}, { results: null }, { results: "nope" }, 42]) {
      const verdict = mod.classifyReport(bad, CASE_ID);
      expect(verdict.passed, `report ${JSON.stringify(bad)} must not pass`).toBe(false);
      expect(verdict.category).toBe("infrastructure");
    }
  });

  it("REFUSES DUPLICATE rows for the requested case — ambiguous evidence is not evidence", () => {
    // Plan §T3 怎么验收: "重复 task_id … 拒绝." Two rows for one case mean the
    // report cannot be attributed to a single execution, so neither is usable.
    const verdict = mod.classifyReport(
      { results: [passingRow(CASE_ID), passingRow(CASE_ID, { verification_passed: false })] },
      CASE_ID,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.category).toBe("infrastructure");
    expect(verdict.detail).toMatch(/duplicate|more than one|ambiguous/i);
  });

  it("maps an explicit bare-ID request to the same row as the full ID", () => {
    // The CLI has used both `suite/case` and bare `case` as `task_id`. The mapping
    // must be EXPLICIT and unambiguous (plan §T3 怎么做 2), not a fallback.
    const report = { results: [passingRow(CASE_ID)] };
    expect(mod.classifyReport(report, CASE_ID).passed).toBe(true);
    expect(mod.classifyReport(report, "regression/" + CASE_ID).passed).toBe(true);
    // A DIFFERENT case's bare id must still be refused.
    expect(mod.classifyReport(report, "regression/" + OTHER_CASE_ID).passed).toBe(false);
  });
});

describe("R99-A C2: `success` alone is NEVER a verified pass", () => {
  it("REFUSES `success: true` with NO verification evidence", () => {
    // Plan §T3 怎么做 3: "verifiedPasses 必须确有 verifier 证据，名称与含义一致."
    // The old classifier reported `success === true` straight through as
    // `verifierPassed`, so a report that merely SAID "done" was a verified pass
    // with nothing behind it.
    const verdict = mod.classifyReport(
      { results: [{ task_id: CASE_ID, success: true, termination_reason: "completed" }] },
      CASE_ID,
    );
    expect(verdict.passed, "no verification evidence means no verified pass").toBe(false);
    expect(verdict.category).toBe("infrastructure");
    expect(verdict.detail).toMatch(/verification|evidence/i);
  });

  it("REFUSES `success: true` whose own verification_passed is FALSE", () => {
    const verdict = mod.classifyReport(
      { results: [passingRow(CASE_ID, { success: true, verification_passed: false })] },
      CASE_ID,
    );
    expect(verdict.passed).toBe(false);
  });

  it("ACCEPTS a pass whose verification evidence is present", () => {
    const verdict = mod.classifyReport({ results: [passingRow(CASE_ID)] }, CASE_ID);
    expect(verdict.passed).toBe(true);
    expect(verdict.category).toBeNull();
    expect(verdict.detail).toContain("verification_passed=true");
  });

  it("does NOT require verification_passed for a suite whose contract is EXPECTED REJECTION", () => {
    // Plan §T3 怎么做 3: "不同 suite 可能以预期拒绝或预期失败为成功，不能一刀切要求所有
    // benchmark success 的 verification_passed=true." An adversarial case that
    // correctly REFUSED the request is a pass with verification_passed=false —
    // its own judge contract says so.
    const verdict = mod.classifyReport(
      {
        results: [
          {
            task_id: CASE_ID,
            suite: "adversarial",
            judge_version: "1.0.0",
            success: true,
            actual_status: "completed",
            verification_passed: false,
            verification_failures: 0,
            termination_reason: "refused_as_expected",
            expected_rejection: true,
          },
        ],
      },
      CASE_ID,
    );
    expect(verdict.passed, "an expected rejection that happened is a pass").toBe(true);
    expect(verdict.category).toBeNull();
  });
});

describe("R99-A C3: infrastructure failures never masquerade as results", () => {
  it("classifies an infrastructure failure as `infrastructure`, not a case failure", () => {
    const verdict = mod.classifyReport(
      { results: [passingRow(CASE_ID, { success: false, actual_status: "error", failure_category: "infrastructure" })] },
      CASE_ID,
    );
    expect(verdict.category).toBe("infrastructure");
    expect(verdict.passed).toBe(false);
  });

  it("classifies a model error as `provider` — an invalid score, not a negative result", () => {
    const verdict = mod.classifyReport(
      {
        results: [
          passingRow(CASE_ID, {
            success: false,
            actual_status: "failed",
            failure_category: "model",
            verification_passed: false,
            termination_reason: "model_error",
          }),
        ],
      },
      CASE_ID,
    );
    expect(verdict.category).toBe("provider");
    expect(verdict.passed).toBe(false);
  });

  it("keeps a genuine task failure as `case_failed` — that is DATA, not a defect", () => {
    // Plan §T3 怎么做 9: "普通 case_failed 是有效负例."
    const verdict = mod.classifyReport(
      {
        results: [
          passingRow(CASE_ID, {
            success: false,
            actual_status: "failed",
            failure_category: "verification",
            verification_passed: false,
            termination_reason: "completed",
          }),
        ],
      },
      CASE_ID,
    );
    expect(verdict.category).toBe("case_failed");
    expect(verdict.passed).toBe(false);
  });

  it("classifies a harness/judge failure as `harness`, not as the case failing", () => {
    const verdict = mod.classifyReport(
      { results: [passingRow(CASE_ID, { success: false, actual_status: "failed", failure_category: "harness" })] },
      CASE_ID,
    );
    expect(verdict.category).toBe("harness");
  });
});

describe("R99-A C4: the persisted row is bound to THIS case and re-verifiable", () => {
  it("stores the requested case's row, and returns null for a different case", () => {
    const report = { results: [passingRow("alpha"), passingRow(CASE_ID)] };
    const row = mod.reportRowFor(report, CASE_ID);
    expect(row).not.toBeNull();
    expect(row!["task_id"]).toBe(CASE_ID);
    // The other case is NOT borrowed.
    expect(mod.reportRowFor(report, "gamma")).toBeNull();
    // An empty report yields no evidence rather than a default row.
    expect(mod.reportRowFor({ results: [] }, CASE_ID)).toBeNull();
    expect(mod.reportRowFor(null, CASE_ID)).toBeNull();
  });

  it("carries a reportHash that CHANGES when any stored field changes", () => {
    // Plan §T3 怎么验收: "修改/删除任意已关联原始报告或 resultHash，恢复及独立 validator
    // 都非零退出." That requires the hash to cover the EVIDENCE, not just a
    // description of it (finding N5: "resultHash 仅摘要化描述文本").
    const base = mod.reportRowFor({ results: [passingRow(CASE_ID)] }, CASE_ID)!;
    const hash = base["reportHash"];
    expect(typeof hash).toBe("string");
    expect((hash as string)).toMatch(/^[0-9a-f]{64}$/);

    for (const [field, value] of [
      ["success", false],
      ["verification_passed", false],
      ["model_calls", 99],
      ["tool_calls", 99],
      ["termination_reason", "something_else"],
      ["actual_status", "error"],
      ["suite", "adversarial"],
      ["judge_version", "2.0.0"],
      ["expected_rejection", true],
    ] as const) {
      const tampered = mod.reportRowFor({ results: [passingRow(CASE_ID, { [field]: value })] }, CASE_ID)!;
      expect(tampered, `changing ${field} must still yield this case's row`).not.toBeNull();
      expect(tampered["reportHash"], `changing ${field} must change the reportHash`).not.toBe(hash);
    }

    // `task_id` is different in kind: changing it means the row no longer
    // describes THIS case, so it is not stored at all. Storing it would file
    // another case's row as this case's evidence.
    expect(mod.reportRowFor({ results: [passingRow(CASE_ID, { task_id: OTHER_CASE_ID })] }, CASE_ID)).toBeNull();
  });

  it("stores no credential and no absolute host path", () => {
    const row = mod.reportRowFor(
      {
        results: [
          passingRow(CASE_ID, {
            reason: "failed at /home/runner/work/harness-agent/secret",
            apiKey: "sk-should-never-appear",
            authorization: "Bearer should-never-appear",
          }),
        ],
      },
      CASE_ID,
    )!;
    const text = JSON.stringify(row);
    expect(text).not.toContain("sk-should-never-appear");
    expect(text).not.toContain("Bearer should-never-appear");
    expect(text).not.toMatch(/[A-Za-z]:\\\\/);
  });
});
