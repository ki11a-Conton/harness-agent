# E4 / N8 — conditional paid experiment: read-only handover

Plan: `plan(20260926-175819).md` §N8 (line 132); 提示词 at 134; 怎么做 at 138; 验收 at 140.
Platform: Windows 10 / PowerShell 7, Node `v24.14.0`.
Status of this document: **the approval-before package. No paid model request was made.**

## 1. Status

| Field | Value |
|---|---|
| `paidExperimentRun` | **NOT_RUN** |
| `championPromotion` | **NOT_RUN** |
| external/paid requests made in this round | **0** |
| `paid:true` authorization created | **NO** |
| refusal reached | **`PAID_NOT_AUTHORIZED`** |

Three independent reasons, each sufficient, in the plan's own terms:

1. **The authorization is incomplete on the plan's own checklist.** Line 134 requires the user to name,
   for *this one run*: the **model · endpoint · amount · SHA · time window**. The authorization received
   names the model, the endpoint and the key — but **no amount cap and no time window**, and it binds no
   SHA. The plan says to stop at `PAID_NOT_AUTHORIZED` when any of those is missing.
2. **The plan's N8 role forbids execution.** Line 134: "不执行任何付费模型请求，不创建 `paid:true` 授权".
   Line 138: if authorization is later obtained it "需另外开启独立任务重新核对…运行仍需手工启动…
   **禁止本计划自动启动**" — a separate independent task, manually started. This session is that plan's
   execution, so auto-starting here is exactly what N8 prohibits.
3. **The endpoint cannot be priced, so the gate refuses it before any provider call** (§3). This is
   measured, not assumed — and it means a signed approval alone would not make the run proceed.

## 2. The authorization as received

Recorded here masked; **the secret is not written to any repository file or artifact.**

| Field | Value as given |
|---|---|
| endpoint | `http://127.0.0.1:8317/v1` |
| key | `sk-…` — received in the session; **masked here and stored in no repository file** |
| model | `workbuddy-deepseek-v4.1-flash` |
| concurrency | "允许很高并发" (no numeric cap given) |
| amount cap | **not specified** |
| time window | **not specified** |
| SHA bound | **not specified** |

**Rotate this key.** It was sent in a chat message, so it is now outside your control boundary. Nothing in
this repository stores it, and no artifact produced this round contains it.

## 3. Measured: this endpoint is a loopback proxy, so its price is UNKNOWN

`http://127.0.0.1:8317/v1` is a **loopback** address. The harness derives the per-call price from the LIVE
endpoint, never from the artifact, and refuses to claim a billing fact it cannot establish:

| Measured (real build, this round) | Value |
|---|---|
| `endpointIsLoopbackAddress("http://127.0.0.1:8317/v1")` | **`true`** |
| `resolveUsdMicrosPerCall("openai", { modelId: "workbuddy-deepseek-v4.1-flash", endpointBaseUrl: "http://127.0.0.1:8317/v1" })` | **`null`** (unknown) |
| `resolveUsdMicrosPerCall("openai", { modelId: "gpt-4o-mini" })` (first-party) | `2500000` (µUSD/call) |
| pricing snapshot model coverage | `["gpt-4o-mini"]` only |
| snapshot version / validity | `pricing-snapshot-v2`, still valid |
| TCP 127.0.0.1:8317 listening locally | `true` (informational; **no model request was sent**) |
| pricing-gate suite | `15 passed (15)` |

Consequence: the money-bounded admission resolves `usdMicrosPerCall = null` and **refuses as
`PRICING_UNKNOWN` before any provider is created** — a refusal with **0** physical requests. This is the
same rule verified in `tool-call-efficiency-formal-gaps.test.ts` ("an unknown observed price is refused as
PRICING_UNKNOWN"). It exists because a proxy/gateway's markup is not the first-party snapshot's to claim;
guessing it would be inventing a billing fact.

So the practical situation is: **a local relay endpoint cannot be authorised by price.** To run against it
at all, one of these must happen first (see §6).

## 4. The approval-before package

Everything below is ready; the blank fields are the ones only you can fill.

| Element | State |
|---|---|
| prereg artifact for the new SHA | needs `prereg build` over a legal arm pair — N1's legal pair (`1f3df072`/HEAD) exists but the repository **defaults are still the ABI-less `e9776ba`/`a203737`**, so a `candidateSourceSha` binding is not yet pinnable from the committed defaults |
| two arm digests | measured this round for the legal pair: `998cfba2…` (baseline) / `6bdb2ce0…` (candidate); **not** the defaults |
| sample set + random order | committed frozen selection; `schedule.repetitions` / `orderSeed` must be fixed for the paid run |
| price snapshot source | `provider published rate card (list price, highest tier)`, version `pricing-snapshot-v2`, invalid after 2030-01-01; **covers only `gpt-4o-mini` on the first-party endpoint** |
| budget dimensions | `maxModelCalls`, `maxToolCalls`, `maxDurationMs`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxUsdMicros` |
| worst-case cost estimate | `maxModelCalls × usdMicrosPerCall` — for this endpoint `usdMicrosPerCall` is **`null`, so the worst case is UNBOUNDED/UNKNOWN**, which is exactly why the gate refuses; for the first-party `gpt-4o-mini` it would be `maxModelCalls × 2_500_000 µUSD` |
| isolation capability | `egressIsolationCapability()` reports `available:false, backend:"none"` — the harness does **not** claim a network sandbox for the worker (N5); an untrusted checkout is refused pre-start with `EGRESS_ISOLATION_UNAVAILABLE` |
| expected CI command output | `scripts/e4/ci-readiness.mjs` produces `ci-readiness.json` with the five separated levels |
| approval template | `docs/evidence/prereg-paid-approval.template.json` — `paid:false`, unsigned, refused by the loader (smoke-tested) |

**No file that could take effect accidentally is provided.** Per line 140 there is no default `paid:true`
approval anywhere in the repository; the only file is the `paid:false` template whose placeholders the
loader refuses.

## 5. What invalidates this package

Per line 136, any change to: the **new commit**, the **model**, the **rate**, the **dataset**, the
**build**, or the **isolation** capability. In particular the legal arm pair is not yet the configured
default, so a paid run bound to today's defaults would bind an ABI-less pair.

## 6. What I need to proceed (in a separate, explicitly authorised task)

Pick one pricing route and supply the two missing authorization fields:

1. **Pricing route — either**
   - (a) run through the **first-party endpoint** (no `OPENAI_BASE_URL`), where `gpt-4o-mini` resolves to a
     real bound and the money gate can admit; or
   - (b) keep the local relay and **extend the pricing snapshot** to cover it: an explicit per-call bound,
     a traceable rate source, and an invalidation timestamp. That is a deliberate, reviewable change to a
     price claim — I will not invent a number for a proxy whose markup I cannot observe.
2. **Amount cap** — an absolute ceiling (`maxUsdMicros` and/or `maxModelCalls`). "High concurrency" is a
   concurrency allowance, not a spend ceiling; without a ceiling the worst case is unbounded.
3. **Time window** — `issuedAtMs`/`expiresAtMs`.
4. **SHA to bind** — and a decision on re-pinning the legal arm pair as the default (N1's outstanding
   item), since the approval must name the two arm digests that will actually run.

Then the separate task must, per line 138: re-verify the current rates, the authorization window, an
**empty `budget-dir`**, and the no-replay rules; the run stays **manually started**.

## 7. Honest scope

- The 124 synthetic-fixture closed-loop runs reported `INCONCLUSIVE`; that **must not** be rewritten as a
  model-quality result or a promotion conclusion (line 136). It is a protocol/plumbing result.
- `realTwoVersionExperimentRan=false` and `promotable=false` remain the correct scope fields until a real
  paid dual-arm experiment actually runs.
- Nothing in this document is a claim that the model works, or that any champion should move.

## 8. Reproduction (all zero-cost, zero-network)

```powershell
node -e "(async()=>{const m=await import('./apps/cli/dist/prereg-execution-identity.js');console.log(m.resolveUsdMicrosPerCall('openai',{modelId:'workbuddy-deepseek-v4.1-flash',endpointBaseUrl:'http://127.0.0.1:8317/v1'}))})()"
# -> null  (PRICING_UNKNOWN; the money-bounded gate refuses before any provider call)

pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-formal-gaps.test.ts   # exit 0, 15 passed
pnpm exec vitest run apps/cli/src/prereg-docs-smoke.test.ts                            # exit 0, 4 passed
```
