# Web UI browser acceptance

Run from a built checkout. Requires Python `playwright` and Chromium; the Python
runner defaults to `/usr/bin/chromium`, overridable via `--chromium` or `CHROMIUM`.
The runner creates a fresh output directory and starts/stops its own production
Harness + Gateway + WebServer. It imports built `dist` modules. Only its model
provider is scripted; no paid calls or model-quality/promotion claims are made.

```sh
corepack pnpm build
git status --porcelain
git rev-parse HEAD
python scripts/research/web-dsh-20261004/browser.py --mode candidate --require-clean --out .ci/web-dsh-20261004/browser-candidate
```

For the original UI baseline, copy the three assets from the declared Git SHA
to an ignored directory and pass it to `--static-dir`. This checks the two
declared defects and a passing HTML-as-text control. `BASELINE_REPRODUCED` means
the original consecutive-assistant and late-history cases both failed; it is
not a passing acceptance result.

```sh
mkdir -p .ci/web-dsh-20261004/baseline/public
git show dec7bd1237870f1d46aa063a7ba1a635e4c523c0:apps/web/public/app.js > .ci/web-dsh-20261004/baseline/public/app.js
git show dec7bd1237870f1d46aa063a7ba1a635e4c523c0:apps/web/public/index.html > .ci/web-dsh-20261004/baseline/public/index.html
git show dec7bd1237870f1d46aa063a7ba1a635e4c523c0:apps/web/public/style.css > .ci/web-dsh-20261004/baseline/public/style.css
python scripts/research/web-dsh-20261004/browser.py --mode baseline --static-dir .ci/web-dsh-20261004/baseline/public --out .ci/web-dsh-20261004/browser-baseline
```

`production-stack` cases install no browser transport overrides. Actual writes,
approval interventions, event sequences, durable records, verification events,
and cancelled turns come from the production runtime. The inspector is a
separate read-only loopback endpoint. `controlled-protocol` cases replace only
browser `fetch` and `EventSource` before initialization, then drive actual DOM
actions and delivered callbacks to impose otherwise nondeterministic ordering.
They never invoke application-private handlers. They are labelled individually
and cannot be represented as a production backend/real-model evaluation.

`production-network-control` exercises that same production backend and actual
Chromium EventSource through a transparent loopback HTTP proxy. A separate
loopback-only fault-control port destroys the real SSE socket for the active
sender and blocks reconnect attempts for at least 3.5 seconds; other HTTP
requests are forwarded unchanged. The runtime completes during that outage,
then browser reconnection must recover its persisted reply via actual history.
No SSE frames or application records are fabricated in this case. The read-only
inspector remains separate. The transport fault is always released in `finally`.

The first candidate run at `a9878031a8965e59881cb3f03982a3698651a3d9`
is retained as `FAILED`: its global text locator also matched the newly added
sidebar/header title, its collapse oracle ignored `visibility: hidden`, and
Playwright `set_offline` did not disconnect an already established SSE socket.
That third false assumption left the browser offline and caused dependent
failures. The corrected probe scopes message locators, verifies actual sidebar
visibility/main geometry, and controls real sockets through the separate proxy.
It does not rewrite those original observations or alter production UI code.

Outputs include the exact source SHA, source/dist/static/probe SHA256 hashes,
Chromium version, case observations, raw runtime snapshot, browser errors,
request log, screenshots, and a per-file artifact integrity index. Output is
kept under ignored `.ci` while developing and copied into the current evidence
directory only after the candidate is frozen and accepted.

`--require-clean` checks tracked source at fixture startup and checks the exact
Git SHA and all source/dist/static fingerprints again after graceful shutdown.
The runner records response status codes, requires every vendored sheet and
license/provenance resource to be local HTTP 200, asserts actual computed theme
colors and sidebar geometry/ARIA, and exercises history-before-live and
live-before-history replay orders. Verification failure is induced by the
actual approved `write_file` tool creating `fail-verification.flag`; the same
real child-process command then exits 7 and must prevent turn completion.

The first baseline execution's original artifact index was empty because an
absolute `/workspace` path component was mistaken for the fixture workspace.
Its original index and raw outputs are retained. A separate
`baseline-index-correction.json` hashes those original files and the immediately
preserved executed-probe snapshot; no baseline result is rewritten or rerun.

The fixture host explicitly authorizes its Node verification command with a
process permission pattern. File writes still require the real UI approval.
The loopback fault proxy is an explicit trusted Host/Origin of this fixture;
production request checks remain active.
