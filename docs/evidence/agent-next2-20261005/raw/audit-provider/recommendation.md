# Provider retry wait baseline audit

Baseline: `320cf3e0bd87d714d17d95709e10c0ddf56d9c5d`; tracked working tree was clean before and after. Production `packages/model/dist/openai.js` was imported, and all transport was a real `127.0.0.1` HTTP server using native fetch, AbortController, AbortSignal.timeout/any and getEventListeners. Instrumentation delegated every add/remove to the original native signal method, retained the native function reference and recorded its stack. No tracked files were changed; no paid provider calls occurred.

## Reproduced defects

1. HTTP 429 plus `Retry-After: 1` and whole-call timeout 50 ms finished only after **1007.43 ms**, although timeout was correctly classified after the unnecessary wait. Only one physical HTTP request reached the server; the attempted retry sees the already-expired effective signal.
2. Calling caller `abort()` while consuming the yielded retry event, before generator resumes into backoff, finished only after **1005.24 ms**. The already-aborted signal never delivers a second abort event. One physical HTTP request reached the server, and final cancellation classification was correct but delayed.
3. Normal timer expiry leaves the backoff abort listener attached. Native 429 retry success and socket-destroy network retry success each retained exactly one backoff callback after completion; its registration stack originates in compiled production backoff, and no explicit removal occurred. At the retry-event cancellation boundary the listener likewise remains retained because it was attached after abort. Abort occurring while the wait is active removes the once listener natively and does finish promptly (44.91 ms control).

Controls: direct streaming success preserves usage `{inputTokens:7,outputTokens:2}`; 429 and network failures recover with exactly two physical requests and one retry each; HTTP 401 emits one error with zero retries; active-wait cancellation is prompt; no success or tool-call events are emitted after delayed deadline or cancellation. Seven scenarios made nine physical HTTP requests. Original stdout, stderr, JSON events, configurations, measured times, ownership stacks and raw request bodies are adjacent artifacts.

## Minimal proposed change

- Pass the existing effective caller + whole-call timeout signal to both pre-stream retry waits. Never construct a per-attempt replacement timeout or extend the whole-call deadline.
- In backoff, return immediately when already aborted; install a named abort callback and use one settlement path for timer expiry and abort. That settlement path clears the timer, removes that callback and resolves once. Recheck `signal.aborted` immediately after installation.
- Preserve existing maxProviderRetries accounting, retry event taxonomy, Retry-After lower bound and jitter. Preserve streaming-phase no-retry behavior. A timeout remains `provider.kind: timeout` and does not become caller cancellation.
- Do not change HTTP diagnostics/body capping based on this audit; that requires a separate measured defect and redaction analysis.

## Acceptance

- Real loopback Retry-After 1 second with 50 ms whole-call deadline must terminate well below the one-second server delay (generous 500 ms bound for a production loopback probe; fake-timer unit assertion should verify exact elapsed budget). Final timeout classification and one physical request remain as baseline.
- Caller cancellation at the yielded retry event must settle promptly below 500 ms, with final cancelled and one physical request. Caller cancellation during the installed wait retains the already-passing behavior.
- Native backoff registrations must have zero retained listeners on successful timer expiry and on cancellation/timeout, including an already-aborted signal and repeated requests reusing a caller controller. Cancellation must also clear the timer; repeated registration/settlement must not double resolve or emit duplicate terminal events.
- Native 429 and network recovery, non-transient 401 zero retry, exhausted retry budget, Retry-After preservation when deadline disabled, caller and timeout precedence, no retries after streaming starts and normal measured usage remain passing.
- This is a deterministic Runtime correctness/ownership defect under AGENTS.md freeze exceptions, rather than a model-quality strategy change. No orchestrator, permission, sandbox or default strategy changes are required.
