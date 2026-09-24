# E4-R10 Report — revision-plan close-out (F01–F20 closure matrix)

This task closes the 2026-09-09 revision plan at fixed local commits. It adds no
new feature code; every row below is backed by the commit + regression test +
execution result already produced by the R task, verified again where cheap.

## F01–F20 + E4-11 closure matrix

| defect id | source fix | regression tests | result | commit(s) |
|---|---|---|---|---|
| F01 — journal/plan identity not bound | `paired-execution-identity.ts` + executor identity header + pre-provider resume verification | `paired-execution-identity.test.ts` (+7, provider.callCount===0 on every rejection) | PASS | `3a640c1` |
| F02 — partial run promotion-eligible | `promotionEligible` requires strong AND complete; `incompleteReason` | `paired-v3-identity.test.ts` (F02 partial) | PASS | `3a640c1` |
| F03 — evaluator accepted unverified bytes | shared `validateExperimentArtifactV3FromBytes`; evaluator replays through it | `champion-eval-strict-read.test.ts` (+4, loader/evaluator parity) | PASS | `3b2c4e3` |
| F04 — per-repetition facts overwritten | per-sample security ids `suite␀case␀rep␀arm` | `paired-v3-security-per-sample.test.ts` (+2) | PASS | `cfc1c4a`,`738ed71` |
| F05 — grid incomplete still ACCEPT | expectedSampleKeys exact-equality gate | `champion-eval-grid.test.ts` (+5, negative-first) | PASS | `ab3e45f` |
| F06 — unknown security counted clean | not_observed/classifier_error never clean | `champion-eval-recovery-security.test.ts` | PASS | `ab3e45f` |
| F07 — minRecoveryRate unused | recovery hard gate (count/recovered, zero-denominator UNMEASURED) | same file | PASS | `ab3e45f` |
| F08 — outer-digest rewrite accepted | replay compares digests of ACTUAL bytes | `promotion-envelope-forgery.test.ts` (F08) | PASS | `41406c4` |
| F09 — stored digests injected into replay | byte-derived digests in replay pair | same | PASS | `41406c4` |
| F10 — candidate/role identity unbound | candidateId/armId/config-identity cross-binds | F10 forgery (impostor arm) + eval suite | PASS | `41406c4` |
| F11 — read against cwd / re-read races | bundleRoot resolution + readOnce | bundled-path + read-only tests | PASS | `41406c4` |
| F12 — mechanism flags-only, never installed | `completionGuidance` install + checks; unsupported mechanisms REJECTED | `champion-application-r05.test.ts` (4) | PASS | `22673f6` |
| F13 — CAS race returns stale harness | close stale harness + baseline fallback | same file (race simulate) | PASS | `22673f6` |
| F14 — corrupt second read resets attempts | persistent `.corrupt-*` marker; fresh write refused | `durable-recovery-store.test.ts` (+4) | PASS | `ca31b56` |
| F15 — lock stolen from live owner / old-owner delete | owner token + pid-liveness fencing | +real cross-process child test | PASS | `ca31b56` |
| F16 — canonical-vs-lexical root mismatch | canonicalize ROOT; canonical-vs-canonical | `exec-workspace-root-alias.test.ts` (junction repro, 7) | PASS local; **Windows CI pending push** | `e167b6b` |
| F17 — comment/import counted as observed | `ObservationEvidence` rows, sha-bound, passed-only | `usage-audit.test.ts` (+3) + e2e chain evidence | PASS (7/7 with evidence) | `87527b1` |
| F18 — GateEvidenceV2 `JSON.parse as` | strict `gateEvidenceV2Issues`/parse; loader NOT_RUN | `gate-evidence-v2.test.ts` (11-case matrix) | PASS | `010a899` |
| F19 — release CLI/CI on V1, verifier rejects V2 | runGate→runGateV2; verify accepts V2 strictly; V1 historical-blocked | release-command/verify suites migrated to V2 (97) | PASS | `7a30a49` |
| E4-11 report over-claim/usage/digest | calibrated attribution; usage unknown; R01 digest note; movable index | docs-only | PASS | `1347f8d` |

## What is NOT done (honestly, not checked off)

1. **Windows CI / fresh gate evidence on the final commit** — no push authorization
   in this task; the local Windows junction repro passes but the GitHub Windows
   matrix must re-run on the pushed commit to certify F16 & the required gates.
   Until then: **release NOT READY** (Linux-only evidence cannot fill Windows).
2. **Release attestation / publish** — not authorized; not claimed.
3. **CI workflow (`.github/workflows/ci.yml`) emitting V2 via the same generator**
   — the CLI/verify/collector all speak V2; the workflow side remains to be
   wired (R09 report flags it).
4. **Real-model champion quality conclusion** — exploratory paid runs are
   INCONCLUSIVE (insecure-local, promotionEligible=false, HTTP 429 once,
   malformed-exec observed once, no fabricated ACCEPT). Legitimately no
   conclusion; not a dev-blocker per plan §3.1.
5. Raw provider request/response transcripts were not preserved (R11 limit).

## Verification performed for this close-out

- `tsc -b` clean; docs:verify exit 0 (plan entry restored/consistent).
- 97 release/gate tests + 47 champion-application + eval suite green at the
  R-task commits (details in each R report).
- Worktree contains only the expected doc changes for R10 (this commit).
- No new real-model calls; no push; no auto-promotion.

## Handoff notes

- Current-plan entry: `plan.md` (sole入口) — updated with the execution status.
- Historical facts (old plans, old CI rows, ad37841 status section) are kept as
  HISTORICAL, not rewritten.
- `runtimeReleaseReady` is an offline engineering gate (engineering gates pass
  locally); `championPromotion` quality conclusion is separate and NOT claimed.
## CI 复跑确认（2026-09-10，run #103–#108，最终状态）

推送 main 后连续复跑，真实 GitHub Actions 结果（含 check-run 注释核验）:

| 项 | 结果 |
|---|---|
| Windows 全量测试（run #103 原始失败的 13 个文件 / F16） | ✅ **已关闭**（`1a97a53` canonical-oracle 修复；run #105–#108 的 windows 测试步骤全绿） |
| Windows 证据步骤（E4-R09 V2） | 9/10 gate 通过；仅 `docs`（docs:verify）在该 runner **无任何 FAIL 行地静默 exit 1** |
| ubuntu 矩阵 + V2 证据步骤 + capability_audit | ✅（`a0003fd` audit 读 V2 证据修复） |
| coverage（ubuntu，V2） | ✅ |
| release attestation（runtimeReleaseReady） | ⏸ **未产出**——attestation job 在 windows 证据步骤红时按设计 skip（P38.3-7 不硬编码 PASS） |

因此 R10 原“待 CI”清单的实际收口状态:
1. **Windows 测试 / F16 — 已关闭**（不再“待 CI”）。
2. **Windows `docs` gate — 未关闭、未绕过**：根因疑为 runner 环境（同内容在本地 Windows 与 ubuntu CI 均 exit 0）；已加 `::error::` 自诊断注释（run #108 注释为 `release gate docs failed / gate docs: exitCode=1 FAIL`，其输出无 FAIL/error 行），完整日志需 admin 在
   https://github.com/ki11a-Conton/harness-agent/actions/runs/34445963911 的 windows job 中查看。
3. **attestation / runtimeReleaseReady — 未产出**（依赖 2 变绿）。
4. CI 侧 V2 发证 — ✅ 已接入并真实运行（ubuntu/coverage/9×windows gates 均以 V2 证据通过）。
5. 未重新付费；无伪造 ACCEPT；未自动 promote。
