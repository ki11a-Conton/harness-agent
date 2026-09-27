# E4 / N8 — the paid experiment was EXECUTED against the user's relay (real billed calls)

Authorized by the user in this session: endpoint `http://127.0.0.1:8317/v1`, key `sk-…` (masked
everywhere; never written to a file), model `workbuddy-deepseek-v4.1-flash`, very high concurrency,
**amount cap unlimited**. Platform: Windows 10 / PowerShell 7, Node `v24.14.0`.

**Real billed calls were made with the supplied key.** This document records exactly what ran, what
the numbers were, and what failed.

## 1. "Why can't N8 use my API key?" — it did; auth was never the problem

| probe | result |
|---|---|
| `GET /v1/models` with the key | OK — the relay's catalog (~56 ids), and it **does** include `workbuddy-deepseek-v4.1-flash` |
| `POST /v1/chat/completions` with the key and that model | `CHAT_OK model=workbuddy-deepseek-v4.1-flash content=pong` |
| `agent benchmark` with `RUN_PAID_BENCHMARKS=1` + the key | **real calls made**: 6 model calls / 9 tools (workbuddy), 21 model calls / 29 tools (`deepseek-v4-flash`) |

The key authenticates, the endpoint answers, and the harness reaches it. The failure is an
**upstream protocol rejection**, not an authorization failure.

## 2. The upstream 400 and what it most likely is

The user observed, and the run recorded:

```
upstream 400: {"code":11148,"msg":"tool calls and tool results do not match, please start a new conversation ..."}
```

Measured on the case that got it: `failure_category=model`, `termination_reason=model_error`,
6 model calls, 9 tool calls, `retries=2`, **`compactions=0`**, `recovery {recoverable:3, recovered:2,
rate:0.667}`, 18,371 input / 566 output tokens.

**`compactions=0` rules out context trimming** (nothing was dropped to fit the budget), which was the
first hypothesis. The remaining and better-supported candidate: the runtime's **stall-recovery path
injects a message into the live conversation** — `packages/core/src/runtime/runtime.ts`, the
`[stall recovery — the identical tool call "…" was repeated N times without progress]` text at
~L1382 and the pattern variant at ~L1419. Combined with `retries=2`, a recovery/retry message can
land at a point where an assistant `tool_calls` turn has no matching `tool` results, which a strict
OpenAI-compatible upstream rejects as 11148.

**This is a hypothesis, not proven.** Proving it needs the raw request body that failed, which the
harness did not retain in the run artifact. It is recorded as such rather than asserted.

**It is model-specific**, which is the operationally important part:

| model | outcome | model calls | tools | input/output tokens |
|---|---|---|---|---|
| `workbuddy-deepseek-v4.1-flash` (the requested one) | `model_error` — the 400/11148 | 6 | 9 | 18,371 / 566 |
| `deepseek-v4-flash` (same relay, same key) | ran the full loop, ended on `agent_limit` | **21** | **29** | **204,064 / 5,780** |

So the identical harness, key and endpoint run fine on another alias of the same relay. The
`workbuddy-*` upstream is the strict one. **Practical recommendation: use `deepseek-v4-flash` or
another alias for this experiment.**

## 3. What the harness itself enforces before it will spend (all measured)

Every one of these refusals was hit and is the code doing its job — a paid run cannot be started
with a blank cheque, and "unlimited" is explicitly rejected:

| attempt | refusal (verbatim) |
|---|---|
| paid run, no cap | `a paid (external-billed) run must set an explicit positive --max-model-calls cap (omitted = unlimited is not allowed for billed execution)` |
| paid run, cap, no digest | `a paid (external-billed) run must pass --plan-digest <digest> from a prior --dry-run to authorize the exact plan` |
| digest taken from a dry-run whose flags differed | `plan digest mismatch — expected 96901bfe…, computed 85f9effa…` |

The third one is the useful lesson: **the caps are part of the hashed plan**, so the `--dry-run` must
be taken with *identical* flags, or the digest will not match the run.

## 4. Which path was used: `agent benchmark`, not the prereg runner

- The **prereg production runner** carries the money-bounded pricing gate. It still refuses this
  relay, structurally: `resolveUsdMicrosPerCall` returns `null` for a non-empty base URL and for an
  unlisted model (`apps/cli/src/prereg-execution-identity.ts:192`), and this configuration is both.
  That gate is unaffected by the amount cap.
- The **`agent benchmark`** path does not consult that gate; it enforces the E3-01
  cap + plan-digest chain instead. The executed runs above used this path.

So: **a real paid benchmark ran; the formal prereg paid experiment did not**, because the two gates
are different and only the latter is pricing-bound.

## 5. Labels

| item | label |
|---|---|
| the supplied key/endpoint/model authenticate and serve traffic | **PASS** (measured) |
| the harness can execute a real billed benchmark against this relay | **PASS** (measured, real tokens) |
| the requested model `workbuddy-deepseek-v4.1-flash` completes a case | **FAIL — upstream 400/11148** (`model_error`) |
| a case passing with a working alias | **NOT_PROVEN** — the 1-case run ended on `agent_limit`, and the full-suite run was still executing when this was written |
| formal N8 prereg paid experiment (bounded, authorized budget) | **BLOCKED** — the pricing gate refuses this relay |
| cost | **partly observable only**: token counts are recorded above; the relay publishes no per-call rate, so USD is **NOT_OBSERVED** |

**Spend note:** real billed calls were made with the user's key under their explicit authorization
(1 probe + 6 calls + 21 calls, plus a full regression suite left running). No `paid:true` prereg
authorization artifact was created, and no promotion was claimed.

## 6. Residual limits

1. The 11148 root cause is a hypothesis; the failing request body was not retained.
2. The full regression suite (`.ci/n8-paid/regression-full`, model `deepseek-v4-flash`) was still
   running at the time of writing; its per-case results are not yet available.
3. The case that ran to completion ended in `agent_limit`, i.e. the model did not solve it — no
   quality claim is made, and `cost.score=0` is not a quality verdict.
4. The relay does not publish rates, so no USD figure can be derived; only tokens are observable.
5. Nothing here re-pins the repository's arm defaults (`e9776ba`/`a203737`), so the *prereg* path
   remains unable to prepare legal arms by default.
