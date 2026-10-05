# Provider stream audit (read-only)

Baseline: `f71b444eec6b4024039716a1a0a01bade22c90b0`; Node `v24.19.0`.
`openai.ts` SHA256 `2c909c6c7c0ed377b52e5b26665e991a104c84cd1cad733287576a115d0bd780`.
`openai.js` SHA256 `1aa9acd6f9e49f5a417009ad10047bddfbbd9ff6e47c2ffcd337f606b9d476aa`.
No tracked source/test files were edited by this audit. Both repro commands exit 0 and record `actualFailure: true`; this means the observation succeeded, not that correctness acceptance passed.

## Confirmed defects

1. **Requested usage is discarded in standard trailing usage layout.** `packages/model/src/openai.ts:605-610` sends `completed` and stops reading as soon as a normal `finish_reason` arrives. The real HTTP fixture responds with text, `finish_reason:stop`, a separate `choices:[]` usage chunk `(137 input / 23 output)`, then `[DONE]`. The request really carries `stream_options.include_usage:true`. Actual provider events contain no usage and the completed result has no usage. Expected exactly one usage event and the same final usage. This affects measured accounting (contracts `model.ts:48-69`, runtime `model-call-controller.ts:530-540`) independently of model quality. Existing tests only cover usage on/before the normal finish frame.
2. **Stream owner fails to cancel/release its reader.** `openai.ts:643-645` only removes the abort listener. A consumer breaking after the first `text_delta` leaves a real `ReadableStream` locked and invokes its cancellation callback zero times. Expected cancellation once and unlocked stream. This also affects early finish and abnormal termination paths.
3. **Cancellation can be ignored if the next frame is already buffered.** The complete response body contains text followed by a normal stop. Aborting in the consumer after `text_delta` yields final `stop` instead of `cancelled`, because `openai.ts:617-640` consults abort only when awaiting another read.
4. **Real fetch cancellation may escape as an uncaught AbortError.** A real loopback HTTP response emits a first text frame then stays open. Aborting after the text makes native fetch's reader throw `AbortError`. The provider emits only started/text_delta and throws, with no cancelled completion. Its reader loop has no rejection handling. Mock-only existing cancellation tests do not cause the body reader to reject on caller abort.

Evidence: `provider-baseline-v2.json` (real HTTP usage and stream ownership), `cancellation-baseline-v2.json` (buffered and real HTTP cancellation). Initial baseline JSON files are retained unchanged.

## Recommended minimal production boundary

Restrict production change to the native model provider; do not change Core contracts, tools, permission/sandbox routing, recovery or model strategy.

- Store the first normal reason as an output boundary. If that very frame carries usage, complete immediately as before. A prior partial snapshot alone must not trigger early completion; it can be replaced by the requested trailing final snapshot.
- Otherwise consume only metadata after that boundary. Ignore later content/reasoning/tool deltas, including ones accompanying a footer usage frame. A valid usage footer can finalize without waiting for DONE because normal finish evidence already exists. DONE or natural EOF after the stored normal reason can also finalize without usage, preserving compatible servers and the existing termination contract. No normal reason + DONE/EOF must remain protocol failure. A first abnormal finish reason must still fail immediately.
- Check the effective signal before processing every buffered frame and after yielding events. Capture reader rejection; caller abort must produce exactly one cancelled completion, deadline or non-abort read error must produce a non-retryable model error and never certify tool execution. The footer-wait phase has the same rules. It must not issue another HTTP request.
- In `finally`, best-effort cancel and release the reader on all owned-body exits, including consumer return/throw. Cleanup rejection must not replace the original completion/error. Keep cancellation bounded by fetch's normal cancellation semantics.

## Suggested acceptance controls

Separate footer for stop and tool_calls, split network/chunk framing and UTF-8, same-frame usage immediate finish, partial snapshot replaced by final footer, footer-free DONE/EOF normal completion, absent normal reason remains fail-closed, ignored late output/tool mutation, abnormal reason immediate failure, buffered caller abort, native HTTP caller abort, footer caller abort, footer timeout, non-abort reader rejection, consumer early return, cleanup rejection preservation, and exact usage in actual Runtime `model.completed` / usage reporting for a two-request tool turn. All fixtures use loopback or test streams; no model-quality claim.
