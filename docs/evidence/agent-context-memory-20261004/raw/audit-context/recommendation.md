# Default AGENTS budget and effective instruction identity audit

Observed 2026-10-04 at `17aa6c7471faf8bdec020b45bfe7b9bb45470131`; production built classes and real Harness sessions, fixed offline provider, zero paid calls. Source hashes and actual output are in `report.json`. No tracked source/test files changed by this audit.

## Confirmed defects

| Fixture | Declared cap | Returned content | Bytes returned by production readFile |
| --- | ---: | ---: | ---: |
| zero | 0 | 31 | 12 |
| one-byte cap | 1 | 31 | 12 |
| Chinese / emoji | 4 | 42 | 16 |
| ASCII one-line | 100 | 1,028 | 1,000 |
| Chinese / emoji one-line | 99 | 1,028 | 1,000 |
| multi-line | 100 | 122 | 800 |
| exact UTF-8 cap (control) | 13 | 13 | 13 |
| 16 MiB one-line | 50,000 | 16,777,248 | 16,777,216 |
| 16 MiB multi-line | 50,000 | 50,026 | 16,777,312 |

These are application-returned read bytes, not OS page-cache/disk-I/O measurements. Discovery unconditionally retains the first whole line and appends the marker outside the cap. Full `readFile` makes allocation/read cost depend on file size rather than context budget. NaN budgets silently disable truncation; negative budgets still return oversized content. The actual cwd AGENTS symlink to a fixture outside cwd is followed and its 28-byte body returned, despite CTX-001's explicit no-follow contract.

Real default Harness runs two turns after changing the same document path. Allowed control bodies are visible 2/2 and instruction fingerprints change, as expected. Injection-denied and budget-dropped bodies are visible 0/2 in each group, but fingerprints still change: `ContextController` hashes `built.discovered` even when project blocks never reach the model. Both turns complete; durable security denials and budget drops corroborate non-admission. The opt-in path-scoped adapter already filters discovered to the admitted project paths, proving a Harness-only repair point exists.

## Minimal implementation proposal

1. Keep default ancestor walk, mutually exclusive scopes, nested skip list, sorting and `maxDocuments` ordering unchanged. Validate finite non-negative budgets before I/O and floor fractional bytes. Replace whole-file read with one no-follow regular-file handle, compare the opened revision against lstat and recheck after capture, bound captured bytes to `min(sourceSize, maxBytes + 4)` and close in finally. Skip unsafe, unreadable, malformed or unstable document; never abort discovery for one document failure.
2. Render a UTF-8 prefix within a hard byte cap. Reserve marker bytes inside the cap. Prefer a complete line when available; when the first line itself exceeds the cap, retain a valid code-point prefix. If a tiny cap cannot hold the marker, omit the marker and retain `truncated: true` as the authoritative warning. Preserve `sizeBytes` as original source size. Use strict UTF-8 validation or a byte-counted decoded result to prevent malformed bytes expanding replacement characters beyond the cap; the existing path-scoped helper's valid-UTF-8 assumptions should not be copied blindly.
3. In Harness composition, reuse the opt-in adapter's admission-only identity convention for the default pipeline through a small wrapper/subclass. Filter its returned `discovered` view by final admitted project blocks and use each final block's exact bounded content. Raw `ContextPipeline.discovered` remains its existing debugging contract; denial telemetry remains available. No Core snapshot interface, permission/sandbox/verification, default strategy selection or promotion changes.

## Acceptance matrix

- Old hierarchy/default-order tests must continue passing unchanged except prior truncation assertions that conflict with the hard cap.
- Caps 0, 1, 4, marker-minus-1, marker, 30, 99, 100, exact size and 50,000; ASCII/multi-line/Chinese/emoji; every returned body `byteLength <= floor(cap)`, no split UTF-8, source size correct, truncation flag correct.
- 16 MiB single/multi-line production files: application bytes captured `<= cap + 4`, no whole-file `readFile`, output `<= cap`, regular small/exact-cap file contents preserved.
- Invalid NaN/infinity/negative cap fails explicitly; valid zero document cap returns no documents.
- cwd and ancestor AGENTS file symlinks omitted; nested directory/file links omitted; regular control docs still included. Race/changed revision omitted without failing unrelated document reads; no cross-process no-follow guarantee is claimed without a corresponding primitive.
- Production default Harness: denied injection and budget document edits do not change effective instruction fingerprint while admitted document edits do; request bodies and durable `model.started`/denial/drop events retained.
- Concurrency and two sessions preserve separate request-local document worlds. Existing path-scoped opt-in adapter acceptance still passes and its activation/default ordering remains unchanged.
- Relevant context/Harness/security/snapshot tests, root typecheck/build/docs and full suite pass; frozen production probe receipt hashes correspond to the source under acceptance. Quality and paid experiments remain NOT_RUN.
