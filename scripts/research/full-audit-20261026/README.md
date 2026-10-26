# Reproducing the full functional audit

Build each checkout with `pnpm typecheck`. These drivers import its production
`dist` modules, use temporary actual workspaces, and make no paid model calls.
Use a separate output file/directory for each revision; keep the baseline red
receipts. Run from the checkout containing these drivers:

```sh
node scripts/research/full-audit-20261026/env-remote.mjs /path/to/checkout /tmp/env-result.json
node scripts/research/full-audit-20261026/model-error-body.mjs /path/to/checkout /tmp/model-result.json
node scripts/research/full-audit-20261026/managed-restart.mjs /path/to/checkout /tmp/restart-result.json
node scripts/research/full-audit-20261026/coding-status.mjs /path/to/checkout /tmp/status-result.json
node scripts/research/full-audit-20261026/search-separator.mjs /path/to/checkout
node scripts/research/full-audit-20261026/search-completeness.mjs --repo /path/to/checkout --expect fixed
```

Expected fixed outcomes: remote credentials absent in the second model request;
cancelled/timeout rather than HTTP error; clean journal and a successful command
after reopening; managed command included exactly once in status; slash and
backslash search agree; unavailable scope fails and summaries expose incomplete
enumeration. On the old revision, use `--expect baseline` for completeness.

The glob driver **must have an external process watchdog**: the old matcher
blocks its own event loop, so its timers cannot safely enforce a timeout.
It uses a real file, ToolOrchestrator and DeterministicPermissionEngine:

```sh
timeout --signal=KILL 5s node scripts/research/full-audit-20261026/glob.mjs /path/to/checkout search
timeout --signal=KILL 5s node scripts/research/full-audit-20261026/glob.mjs /path/to/checkout permission
```

For F1 run `packages/tools/src/read-file-growth.regressions.test.ts`: the real
opened file is grown by another writer after a genuine stat or native read;
no fake size or fake content establishes the result. Existing resource tests
continue to check closure/cancellation/denials. New targeted suites are ordinary
full-suite members, without new test exclusions.

The existing daily Web browser driver covers desktop/mobile/narrow native
interactions. `managed-commands-20261025/browser.mjs` additionally checks the
production status RPC after an ordinary UI-launched long command and its real
TaskVerifier. It does not inject the unmounted legacy coding panel, replace
responses, force clicks or directly mutate session state through RPC.
