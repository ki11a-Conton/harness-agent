# E4-R04 Report — promotion identity binding + bundle read semantics

## Defects fixed (F08–F11)

| id | defect | fix |
|---|---|---|
| F08 | changing `DecisionArtifact.baselineArtifactDigest` / `candidateArtifactDigest` (then recomputing the outer digests the attacker can reach) was not caught — nothing compared the stored digest fields against reality | the replay now computes the digests from the ACTUAL bytes read and requires the stored fields to equal them; any mismatch → `DECISION_REPLAY_MISMATCH` |
| F09 | `verifyDecisionArtifactReplayV3` injected `stored[...]` digest strings into the replay's `V3ArtifactPair` — a forger who rewrote them and recomputed the DecisionArtifact `contentDigest` had the replay replay THEIR values | replay pair carries digests of the actual bytes; stored-vs-actual mismatch is a violation |
| F10 | candidate/role identity never cross-bound: `candidateId`, arm roles, config identity could disagree silently | replay now binds: `candidate.arm.armId === "candidate"`, `baseline.arm.armId === "baseline"` (roles not swapped), `decision.candidateId === candidate.arm.candidateId`, and both `candidate.arm.candidateConfigHash` and `manifest.runtimeConfigHash` must be present (missing promotion-required identity → reject; never skipped) |
| F11 | reads used `ref.path` directly (resolved against `process.cwd()`), while the guard resolved against `bundleRoot` — so a moved bundle read the WRONG files, and each file was re-read repeatedly (check A, consume B) | every path now resolves against the confirmed `bundleRoot`; each file is read ONCE (`readOnce` cache) and the same bytes feed digest verification, strict parse AND replay |

Plus strict version support (#4): `schemaVersion` must equal `3.0.0`, `evaluatorVersion` must equal the current evaluator, `policy.version` must equal the ONE supported policy version `DECISION_POLICY_V3_VERSION` and `stored.policyVersion` must equal `policy.version`. A non-empty string is never enough.

## Real bundle structure + identity correspondence

```
bundleRoot/
  envelope.json          PromotionEnvelope (content-addressed; artifactRefs may be relative)
  baseline.json          V3 experiment artifact, role "baseline"
  candidate.json         V3 experiment artifact, role "candidate"
  decision-artifact.json DecisionArtifactV3 (contentDigest recomputable)
```

| identity | carried by | cross-bound against |
|---|---|---|
| `candidateId` | envelope, DecisionArtifact, candidate.arm, CLI option | replay: decision.candidateId === candidate.arm.candidateId; envelope.candidateId === expected |
| role (baseline/candidate) | artifactRefs + arm.armId | replay: armId checks reject swapped roles |
| `planDigest` | envelope? decision, candidate manifest | loader: decision.planDigest === candidate.manifest.planDigest |
| `sourceSha` | envelope + provenance.gitSha | loader: equal (when envelope.sourceSha != null) |
| policy + thresholdDigest | decision.policy + manifest | replay: thresholdDigest === digest(embedded policy); policy.version supported |
| config identity | candidate.arm.candidateConfigHash, manifest.runtimeConfigHash | replay: both MUST be present (unknown → reject) |
| artifact digests | artifactRefs.digest, decision baseline/candidateArtifactDigest | loader: recomputed from the ACTUAL bytes read |

## Forgery matrix (all byte-identical outputs, `loadPromotionEnvelope` read-only)

Each case recomputes every digest the attacker can reach — the loader must still
reject:

| forgery | expected code | observed |
|---|---|---|
| decision baseline+candidateArtifactDigest rewritten, contentDigest + envelope digest recomputed | DECISION_REPLAY_MISMATCH (ACTUAL bytes) | ✅ |
| envelope.candidateId → another-candidate, envelope digest recomputed | CANDIDATE_MISMATCH | ✅ |
| candidate artifact arm.candidateId → impostor, artifact digest REBUILT (recomputed) | DECISION_REPLAY_MISMATCH (candidateId) | ✅ |
| decision flipped to ACCEPT, digest recomputed | DECISION_REPLAY_MISMATCH | ✅ (pre-existing) |
| baseline ref → candidate file | CROSS_BINDING_MISMATCH | ✅ (pre-existing) |
| path traversal / symlink escape out of bundleRoot | PATH_OUTSIDE_BUNDLE | ✅ (pre-existing) |

## Checksum trust boundary — explicit

SHA-256 here is an **integrity checksum, not a digital signature**. The loader
can detect a single-file tamper that is not accompanied by recomputation of the
files the loader re-reads, and it recomputes from the same bytes it consumes; it
does NOT defend against an attacker who replaces ALL trusted roots (envelope +
artifacts + decision) with a coherent forged set. That is orthogonal (key
management/PKI) and out of scope, per the task.

## Acceptance notes

- `verifyArtifactRefs: false` / `verifyDecisionArtifact: false` remain diagnostic
  escapes; the production CLI promote path does not pass them (checked in
  `e3-07-promotion-trust.test.ts`), so a bypass result can never write
  `applicationPending`.
- Gemstone (legacy) arbitrary-text-artifact / hand-written ACCEPT negatives still
  reject (ARTIFACT_NOT_V3 + DECISION_REPLAY_MISMATCH suites pass unchanged).
- Every rejected load leaves the champion state and bundle files untouched
  (read-only loader; the "byte-identical after rejected load" test passes).

## Verification

```text
pnpm typecheck (tsc -b)   clean
R04 command set            54 passed / 5 files
full packages/evaluation + apps/cli   (see full-suite run)
```

## Explicitly NOT claimed

- No digital-signature/PKI guarantee.
- The tests forge files in a temp dir on this host; symlink-race handling is
  best-effort (realpath guard) and is not an absolute defense against a malicious
  local admin — as the task allows.
- This task is the loader side; R05 owns proving the applied mechanism runs and
  closing the CAS-failure instance leak.