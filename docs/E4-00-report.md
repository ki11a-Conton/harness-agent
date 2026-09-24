# E4-00 Report

## Outcome
- Status: DONE
- Source SHA before: `ad37841dbcbfa1d3553e699ab482c1246a549f48` (reviewed baseline / branch start)
- Source SHA after: this commit (branch `e4-production-closure`)
- Provider calls: **0** (fully offline)

## What changed
- Production files:
  - `packages/tools/src/process/sandbox-executor.ts` — `selfTestInTempDir()` relocates the capability self-test probe base + policy writable dir to a unique `os.tmpdir()` dir with `finally` cleanup; `selfTestForBackend` and `capabilityProbe` now use it (blocker #12).
  - `apps/cli/src/docs-verify.ts` — new `current plan entry (E4-00)` check: `plan.md` exists, declares itself current, and references an existing detailed spec.
- Test files:
  - `packages/tools/src/process/sandbox-executor.test.ts` — +4 tests (temp base under tmpdir not cwd; cleanup on success; cleanup on throw; non-strong `capabilityProbe` clean; **no-dirty-worktree** gate adds no untracked files).
  - `apps/cli/src/docs-verify.test.ts` — +3 tests (entry unmarked → fail; spec missing → fail; valid → pass) and fixture seeds a valid plan entry.
- Docs/evidence files:
  - `plan.md` — replaced the historical E3 plan with the unique CURRENT E4 plan entry (task index, status, shared constraints); marks E3 plan + baseline HISTORICAL.
  - `plan(20260907-004430).md` — tracked as the authoritative E4 spec.
  - `docs/E4-STATUS.md` — per-command gate truth, per-E3-task re-judgment, 12 blockers.
  - `e3-review-baseline.json` — note clarified as a HISTORICAL snapshot (matches e2-handoff convention).

## Why this closes the task
- 生产入口：`capabilityProbe` / `selfTestForBackend` / `decideBenchmarkConfinement`（真实 CLI preflight 调用）现在全部经 `selfTestInTempDir`，探测残留只进临时目录并被清理。
- 数据来源：docs:verify 的 plan-entry 检查读取真实 `plan.md` 与其引用的 spec 文件字节。
- 信任边界：状态页记录评审基线 SHA 保证可追溯；严格 `sourceSha==HEAD` 门禁证据由 E4-10 的 GateEvidenceV2 生成器负责（docs:verify 本就禁止规范段放易变 SHA，避免自指陷阱）。
- 失败语义：self-test 抛错时 `finally` 仍清理；docs:verify 对缺失/未标记/引用失效的 plan 入口 fail-closed。

## Tests
| Command | Exit code | Result | Notes |
|---|---:|---|---|
| `npx tsc -b` | 0 | PASS | full repo |
| `vitest run packages/tools/src/process/sandbox-executor.test.ts` | 0 | PASS | 33 tests |
| `vitest run apps/cli/src/docs-verify.test.ts` | 0 | PASS | 14 tests |
| `node apps/cli/dist/main.js docs:verify` | 0 | PASS | all checks incl. current plan entry |
| `pnpm test` | 0 | PASS | full suite (see below) |

## Required negative reproductions
| Reproduction | Before | After |
|---|---|---|
| capability self-test leaves `.e3-09-self-test` in repo root | polluted | temp dir, cleaned; no repo residue |
| self-test throws mid-run | residue left | `finally` removes temp dir |
| plan.md not marked current | (no check existed) | docs:verify FAILS CLOSED |
| plan.md references missing spec | — | docs:verify FAILS CLOSED |
| gate run adds untracked files | possible | no-dirty-worktree test asserts none added |

## Worktree
- `git status --short`: empty after each commit.
- Temporary files cleaned: yes (mkdtemp + finally rm; test fixtures use tmpdir).

## Remaining risks
- The no-dirty-worktree test compares untracked sets around a short window; a parallel worker writing to the repo root during that window could theoretically cause a false positive (mitigated: all tests write to tmpdir, not repo root).
- Strict `sourceSha == git rev-parse HEAD` gate evidence is intentionally deferred to E4-10 (GateEvidenceV2 generator); E4-00 records the reviewed baseline SHA for traceability instead.
