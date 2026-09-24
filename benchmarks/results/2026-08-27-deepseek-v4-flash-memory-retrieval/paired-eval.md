mode: real-model
paired cases: 30
wins/losses/ties: 2W / 2L / 7T / 19 both-failed
net passed delta: 0
verified completion: 0.300 → 0.300
tool calls Δ: -57
tokens Δ: -529504
cost Δ: $+0.0000
recovery Δ: -30
compaction Δ: -13

per-case:
  ho-01-review-smells: tie (b:pass verified_complete / c:pass verified_complete)
  ho-02-parse-log: both_failed (b:fail agent_limit / c:fail verification_failed)
  ho-03-convert-format: both_failed (b:fail verification_failed / c:fail agent_limit)
  ho-04-audit-deps: baseline_only_passed (b:pass verified_complete / c:fail model_error)
  ho-05-complexity: tie (b:pass verified_complete / c:pass verified_complete)
  ho-06-migration-script: both_failed (b:fail verification_failed / c:fail tool_limit)
  ho-07-permissions: candidate_only_passed (b:fail model_error / c:pass verified_complete)
  ho-08-optimize: both_failed (b:fail agent_limit / c:fail model_error)
  ho-09-document-api: tie (b:pass verified_complete / c:pass verified_complete)
  ho-10-validate-schema: both_failed (b:fail agent_limit / c:fail agent_limit)
  ho-11-release-notes: both_failed (b:fail verification_failed / c:fail verification_failed)
  ho-12-refactor-esm: tie (b:pass verified_complete / c:pass verified_complete)
  ho-13-debug-flaky: both_failed (b:fail agent_limit / c:fail agent_limit)
  ho-14-test-matrix: tie (b:pass verified_complete / c:pass verified_complete)
  ho-15-rate-limiter: both_failed (b:fail model_error / c:fail model_error)
  ho-16-analyze-query: tie (b:pass verified_complete / c:pass verified_complete)
  ho-17-changelog: baseline_only_passed (b:pass verified_complete / c:fail time_limit)
  ho-18-race-condition: both_failed (b:fail verification_failed / c:fail agent_limit)
  ho-19-cache: both_failed (b:fail agent_limit / c:fail model_error)
  ho-20-normalize: both_failed (b:fail model_error / c:fail verification_failed)
  ho-21-build-report: candidate_only_passed (b:fail verification_failed / c:pass verified_complete)
  ho-22-fix-vuln: both_failed (b:fail model_error / c:fail verification_failed)
  ho-23-retry-logic: both_failed (b:fail verification_failed / c:fail agent_limit)
  ho-24-extract-constants: both_failed (b:fail agent_limit / c:fail agent_limit)
  ho-25-cron-config: both_failed (b:fail agent_limit / c:fail verification_failed)
  ho-26-analyze-errors: both_failed (b:fail verification_failed / c:fail model_error)
  ho-27-pagination: both_failed (b:fail agent_limit / c:fail agent_limit)
  ho-28-refactor-naming: both_failed (b:fail agent_limit / c:fail agent_limit)
  ho-29-benchmark: tie (b:pass verified_complete / c:pass verified_complete)
  ho-30-healthcheck: both_failed (b:fail model_error / c:fail time_limit)

claim:
  real-model paired eval over 30 same cases: no net pass-rate change (7 ties); verified completion 0.300 → 0.300 (Δ +0.000); cost not increased.

quality policy (P38.3-12 + P38.4-8):
  PASS  same case set
  PASS  compatible judge version
  PASS  compatible evaluation context (attributable)
  PASS  candidate actually differs
  PASS  controlled difference declared
  PASS  no new harness/judge/infra failures
  PASS  security non-regression
  PASS  P21-4 quality gates (regression/verified/cost)
  QUALITY VERDICT: PASS (candidate may be compared further)
