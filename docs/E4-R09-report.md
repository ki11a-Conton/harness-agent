# E4-R09 Report — one strict GateEvidenceV2 protocol for generation, reading and verification

## Defects fixed

| id | defect | fix |
|---|---|---|
| F18 | `loadGateEvidenceV2` was `JSON.parse(raw) as GateEvidenceV2` — a missing-field object passed validation | `gateEvidenceV2Issues()`: strict field-level + cross-field checks (schemaVersion, gate id, argv, toolVersion, gitSha never `unknown`, cleanBefore/cleanAfter, 64-hex input/output digest, ISO timestamps, integer/null exitCode, known state, passed boolean, artifactRef digests). `parseGateEvidenceV2` throws; the loader returns NOT_RUN (never PASS) for any invalid object. |
| F19 | the release CLI's `runGate` hand-wrote a `schemaVersion: 1` shape (`passed = exitCode === 0`, no cleanliness/digest binding), while `runGateV2` existed unused; release-verify REJECTED anything non-V1; CI/collector/V1-authority could each claim current-release green on different paths | the release CLI, the verifier and the evidence loader now all consume the SAME strict V2 protocol: `runGate` delegates to `runGateV2`; `parseRawEvidence` strictly validates V2 and maps it; `validateGateEvidenceInstance` accepts V2 as current and demotes V1 to **blocked (historical/unsupported for the current release)**. |

## What the release pipeline now enforces

- **Generator**: `runGateV2` captures git state before/after, derives `passed`
  from the real exit code AND declared-artifact presence AND a **clean source
  tree** (a dirty run records state=failed with a "dirty source tree" reason —
  it can never certify a release). Paid key stripped at the CLI runner; provider
  calls recorded separately (`providerCalls`), offline gates carry 0.
- **Reader**: `parseRawEvidence` must pass `gateEvidenceV2Issues` before any
  field is trusted; `gitSha→headSha`, argv→canonical command string,
  platform from the `gates/<os>/<gate>.json` path.
- **Verifier**: V2 is the current protocol; a V2 PASS on a dirty tree (before or
  after) is BLOCKED; **V1 evidence is historical** — blocked with
  "migrate to V2", never green; command substitution, stale headSha, wrong
  platform, inconsistent exitCode/passed remain blocked/thrown.
- The strict loader (`loadGateEvidenceV2`) feeds the R08 collector/audit path,
  so a single protocol spans generation, reading, aggregation and the
  capability audit.

## Tests (97 across the three suites)

- gate-evidence-v2.test.ts (34): F18 11-case negative matrix (missing digest /
  bad schema / evil gate id / empty argv / `unknown` SHA / dirty pass / nonzero
  exit with passed / invalid state / bad timestamps / bad artifactRef digest) +
  valid object + loader NOT_RUN; clean-temp-git-repo positive for the generator.
- release-command.test.ts (20): runGate writes durable **V2** evidence with the
  real exit code (and truthful cleanliness booleans); red gates still capture +
  write evidence; legacy **V1 evidence → NOT READY**.
- release-verify.test.ts (43): V2 accepted at HEAD; V1 **blocked (historical)**;
  dirty-tree V2 PASS **blocked**; migration of fixtures to V2; all existing
  platform-aggregation/merge semantics unchanged (Linux success never fills a
  missing Windows; missing platform → not ready …).

## Explicitly NOT claimed

- This wires the generator + reader + verifier; the CI workflow (`.github/...`)
  emitting V2 from the same generator is the remaining integration step for
  CI-side evidence (R10/docs close-out tracks it).
- V1 evidence files remain readable as diagnostics but are blocked for the
  current release — there is no path where V1 and V2 both certify the current
  release as green.
- The evidence binds HEAD + cleanness + digests; it is a checksum/consistency
  protocol, not a signature (per R04's trust-boundary note).

## Verification

```text
pnpm typecheck (tsc -b)   clean
gate-evidence-v2          34 passed
release-command           20 passed
release-verify            43 passed
```
Commits: `010a899` (F18), `7a30a49` (F19).