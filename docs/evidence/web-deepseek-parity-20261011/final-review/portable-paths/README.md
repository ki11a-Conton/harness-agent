# Complete UI archive path defect: RED and scoped GREEN

Independent review on 2026-10-12 found that `makeArchive()` split every long
ustar path at its final slash. The format permits slashes in its 100-byte name
field, so a deeply nested notice may fit an earlier split while its final
155-byte prefix overflows. This blocked 7 real public files under the
`harness-agent-1.9.1` root and 10 under `harness-agent-1.9.1-test`.

The fix searches slash boundaries for a split satisfying both field limits.
It preserves every path, notice byte, and declared mode. No notices were
removed, renamed, or replaced. Paths with no valid split remain rejected.

- `public-archive-path-red.json`: actual pre-fix 786-file path probe, including
  the then-executed source hash and valid alternative splits for all 7 failures.
- `notices-roundtrip-red.log`: actual pre-fix test failure on a real notice;
  includes the ten-notice schema 2 roundtrip test and two boundary controls.
- `portable-targeted-green.log`: existing portable/security tests plus the new
  notice/boundary tests, 26 passed, 0 failed, 0 skipped.
- `probe.mjs` and `public-assets-roundtrip-green.json`: all 786 current public
  files, 61,131,850 original bytes, were archived and extracted. Every original
  byte and declared mode was verified. The scoped archive was 36,460,892 bytes,
  SHA-256 `c589ce43687a363bafa387de1ef5a0ce088f53f758a2704ee8de7ff370e0b582`.
  Its report includes individual hashes and both historical root-length cases.

Reproduce from the task worktree:

```sh
node --test scripts/release/portable.test.mjs scripts/release/portable-deepseek-paths.test.mjs
node docs/evidence/web-deepseek-parity-20261011/final-review/portable-paths/probe.mjs
```

These are scoped Linux tests. They do not constitute a complete product
portable build, native Windows consumption, or browser/control parity
acceptance. The separate source snapshot builder requires a clean pinned Git
commit and must build and consume the final product independently. Existing
`gen1`/Windows install workflows exercise the older JSON coding interface and
do not prove the new default DeepSeek UI or its terminal controls.
