# E4-07 Report: Real `applicationPending -> applied` Champion Lifecycle

## Objective

Correct the champion promotion lifecycle so that accepting a promotion envelope does not falsely claim that the candidate is already active. A promotion must first enter `applicationPending`; only a real CLI or Web startup that successfully creates a harness with the intended champion configuration may persist `applied=true` and an `AppliedProof`.

## Completion status

E4-07 is implemented in three commits:

- `becbfa8` E4-07 part 1: champion promote writes `applicationPending`, never forces `applied=true`.
- `bc6441e` E4-07 part 2: AppliedProof machinery and application lifecycle transitions.
- `e59df8b` E4-07 part 3: real champion application wired into CLI and Web startup.

The working tree was clean following these commits.

## Lifecycle implemented

The persisted lifecycle now has the following semantics:

```text
PROVEN
  -> new accepted promotion
APPLICATION_PENDING (applied=false)
  -> real process startup invokes createHarness
  -> final normalized configuration verified
APPLIED (applied=true + AppliedProof)

APPLICATION_PENDING
  -> createHarness failure, invalid profile, configuration drift, or origin mismatch
APPLICATION_FAILED (applied=false + explicit failure record)

APPLIED
  -> new promotion
APPLICATION_PENDING
```

`APPLYING` is treated as the transient work performed during startup. It is not persisted as a terminal state. If the process exits during application, the persisted state remains pending and can be retried safely on the next startup.

The frozen C0 baseline is `PROVEN` by construction and does not require a champion application proof.

## Promotion command correction

The former promotion path constructed the next state and then forcibly replaced its application state with:

```ts
{ ...next, applied: true }
```

That behavior was removed. `champion promote` now persists the state returned by `applyPromotion`, which has:

```text
applied=false
validity=QUARANTINED_PENDING_REEVALUATION
lifecycle=APPLICATION_PENDING
```

The command output explicitly states that the next real CLI or Web startup must run `createHarness` and write the proof. The promotion command never calls a proof helper and never represents envelope acceptance as runtime application.

## AppliedProofV1

A new content-addressed `AppliedProofV1` records at least:

- schema version;
- champion-state generation digest;
- champion level;
- candidate ID;
- target configuration hash;
- applied configuration hash derived from the real harness's final resolved configuration;
- runtime entrypoint, `cli` or `web`;
- source/build SHA;
- process or startup identifier;
- application timestamp;
- canonical self-excluding proof digest.

The generation token is computed from the champion promotion identity, including the level, candidate, patch, evidence reference, and promotion history. It deliberately excludes mutable application fields such as `applied`, validity, proof, and failure information. This makes the generation stable across the transition from pending to applied while ensuring that a subsequent promotion has a different generation.

Proof verification rejects:

- a malformed or missing proof;
- unsupported schema versions;
- a proof digest that does not recompute;
- a proof from an older promotion generation;
- a different champion level or candidate;
- a target hash different from the currently resolved target;
- an applied hash different from the target hash;
- an unknown runtime entrypoint;
- missing process or timestamp fields.

## Real configuration verification

The application path projects every champion-controlled configuration field from the real harness's final `resolvedConfig`. Each projected check includes:

- dotted configuration key;
- champion-intended value;
- actual final value;
- winning configuration-layer origin.

Application fails closed if any of the following occurs:

1. `createHarness` throws.
2. No champion-controlled fields are projected.
3. An actual value differs from the intended value.
4. A value came from defaults, a profile, the environment, or another layer instead of the champion runtime override.
5. The canonical target and applied projection hashes differ.

Checking configuration origins is important even when values happen to match. For example, an environment variable that independently enables memory must not be treated as proof that the champion profile was applied.

## Shared CLI and Web production path

CLI and Web now use the same exported `createHarnessWithChampion` path.

At startup it:

1. Reads the champion state.
2. Uses the dedicated pending-application profile resolution mode.
3. Resolves the candidate through `resolveChampionHarness`.
4. Builds the intended champion `HarnessConfig` on top of the application's base configuration.
5. Calls the real `createHarness` composition root.
6. Reads the resulting final normalized configuration and per-key origins.
7. Compares the applied projection with the champion target.
8. Builds an `AppliedProofV1` only after the comparison succeeds.
9. Uses compare-and-swap persistence against the champion state read at startup.
10. Returns the champion harness only after successful verification.

Ordinary profile loading remains fail-closed for quarantined or invalid states. The ability to resolve a pending candidate is limited to the dedicated application path, because that path needs the candidate configuration in order to prove whether it can be applied.

## Failure behavior

A failed application never silently runs as the candidate and never writes `applied=true`.

The implementation records `ChampionApplicationFailureV1`, including:

- failure time;
- runtime entrypoint;
- process identifier;
- explicit reason;
- mismatched configuration keys;
- overridden-origin keys;
- target and observed configuration hashes.

The failed state preserves the candidate claim, evidence reference, and complete promotion history. The process falls back to the frozen baseline harness rather than continuing with an unverified candidate.

A compare-and-swap conflict does not overwrite a newer champion state. The startup reports that its proof was not written, and a later startup can re-evaluate the current generation.

## Restart and rollback semantics

An already-applied champion is rechecked against the live final configuration when the process restarts. If the existing proof is valid for the same generation and the live configuration still matches, startup is idempotent and does not rewrite the state.

Rollback to C0 is the frozen baseline and is applied by construction. Rollback to a non-C0 champion level now yields `applied=false`; that older champion must be applied and proven again by a real startup instead of inheriting a stale application claim.

## Tests

### Pure application and proof tests

`packages/evaluation/src/champion-application.test.ts` adds 18 tests covering:

- deterministic, order-independent projection hashing;
- hash sensitivity to configuration changes;
- successful faithful application;
- intended-versus-actual drift rejection;
- default-layer fallback rejection;
- environment-origin rejection even when the value matches;
- empty-projection rejection;
- `createHarness` failure reporting;
- proof digest recomputation;
- proof tamper detection;
- current-generation proof verification;
- previous-generation rejection;
- candidate, level, and entrypoint binding;
- pending-to-applied lifecycle transition;
- generation stability during that transition;
- stale-proof rejection;
- explicit failed-application semantics;
- C0 baseline semantics.

### Real production integration tests

`apps/cli/src/champion-application.integration.test.ts` adds nine integration tests using the real `createHarness` with temporary directories and no provider calls:

1. Promotion produces `applicationPending` and `applied=false`.
2. A real CLI harness startup changes the configuration and persists a proof.
3. A real Web harness startup changes the configuration and persists a proof.
4. Applied configuration hashes come from `createHarness` final resolved configuration.
5. A `createHarness` failure does not write `applied=true` and preserves the claim.
6. A configuration mismatch does not write `applied=true` and returns the baseline harness.
7. A CAS generation conflict cannot overwrite newer state.
8. Restarting an already-applied state is idempotent.
9. An unpromoted C0 state keeps the default configuration.

These tests do not substitute assertions on a pure mapper for production application. They invoke the real harness composition root and inspect its resulting normalized configuration.

## Verification evidence

Successful verification recorded during implementation:

```text
Full TypeScript project build: clean
Focused CLI/Web/champion suites: 96 tests passed across 7 files
Real E4-07 application integration matrix: 9 tests passed
Evaluation + CLI suite after AppliedProof machinery: 1210 tests passed across 98 files
```

The repository was clean after commit `e59df8b`.

## Deliverables

- Correct pending, applied, and failed lifecycle semantics: complete.
- Promotion no longer forces `applied=true`: complete.
- CLI production `createHarness` wiring: complete.
- Web production `createHarness` wiring: complete.
- Shared resolver and verification path: complete.
- Content-addressed AppliedProof with generation binding: complete.
- Explicit failure recording and baseline fallback: complete.
- Real production integration matrix: complete.
- E4-07 report: complete.
