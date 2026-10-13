# Models/settings production acceptance

These records exercise the unmodified official browser client against `apps/web/dist/main.js`, actual owner factories, persisted settings/credentials, and an actual loopback OpenAI-compatible HTTP provider. No paid provider is called; this proves transport/ownership/control behavior, not paid-model coding quality.

## Confirmed defects and fixes

1. `agentAvailable` previously meant “actor already loaded.” Real blank sessions and process-reopened sessions were marked unavailable despite valid frozen effective agents. `session-availability.test.ts` retains the two real RED cases; the host now resolves the persisted effective agent without loading an actor or sending a model request.
2. A draft model generation's durable alias CAS precedes activation of its deliberately private `failed` replacement. An existing real `session/follow` read that window as `session/not-found` and terminated. `browser-run-04-red/trace.json` records the actual error sentinel. `session-model-snapshot.test.ts` holds the actual replacement owner's `updateSession` activation at a deterministic barrier: follow, summary, projections and page now wait for the same short owner lock, preserve the committed prefix and receive the newer durable `model/selection` event. Streams release the lock before yielding/waiting; already-locked mutations use the unlocked projection helper.
3. Independent security review found a real credential symlink swap between `lstat` and pathname `readFile`, and a hard-link alias. Private settings/credentials now use bounded descriptor reads with no-follow/nonblocking flags on POSIX, original/opened/final file identity, regular-file/nlink/size/private credential mode, and fixed-parent checks. The independent RED is retained under `../final-review`; the catalog cases pass in `catalog-safe-documents-green.log`. That combined run's remaining byte-preview failure belongs to the separate file preview domain and is not relabeled as a catalog failure.

## Browser records

- Runs 01–03 preserve acceptance-runner failures, not three application defects: official blank rows display `New Session` irrespective of title; a manually invoked pre-prompt rename correctly freezes the draft through real metadata tool activity; and `session/follow` emits durable `model/selection` events rather than `session/control` projection frames.
- Run 04 is the real generation-activation race above.
- Run 05 is a screenshot capture timeout before its test prompt; it is not evidence of a failed model route.
- Run 06 passes all 16 browser assertions and all three PNG captures, but its two host launches used different captured compiled artifacts because another worker rebuilt `dist`. Keep it as path evidence, not a frozen-build restart proof.
- Run 07 passes all 16 assertions with identical captured Web artifacts at both real process launches: actual Models/key form, theme/font/chat settings, two tabs, authoritative `modelSelection.next`, the pre-existing follow stream, stable history prefix, one real alternate-model HTTP request, visible started-session refusal, actual restart, persisted settings and selected owner, and zero uncaught browser errors. Paid model requests: **0**. Three screenshots pass. Its production turn settlement is verified by the actual host's durable summary and turn-boundary projection.

The runner now also records its own SHA, Node/Playwright versions, per-launch compiled artifact hashes, source hashes, explicit screenshot status and a same-artifact assertion. Final release evidence must rerun it after the complete source/build freeze; these targeted fingerprints are not a substitute for the final clean-tree/portable gates.

## Targeted results

- `lazy-agent-availability-red.log`: 2/2 real RED cases.
- `lazy-agent-availability-catalog-green.log`: 21/21 PASS.
- `model-generation-read-red.log`: real activation-barrier RED.
- `model-generation-read-green.log`: 40/40 PASS (session, catalog, availability, generation regression).
- `model-generation-prefix-green.log`: activation barrier, same existing follow, preserved prefix PASS.
- `typecheck-model-generation.log`: `tsc -b` PASS.

The scratch fixture's credential is a generated-purpose local fixture value and is redacted from browser traces. Private fixture data directories are excluded from the checked-in acceptance archive. Original RED/GREEN records are retained in distinct directories.
