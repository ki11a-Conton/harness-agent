/**
 * A5/B3 — the PRODUCTION paired-arm executor for the v2 pre-registered campaign.
 *
 * WHY THIS EXISTS
 * ---------------
 * `createProductionPreregRunner` used to answer every `runArm` with
 * `ARM_EXECUTOR_NOT_WIRED`: no shipped executor existed, so the release CLI
 * could admit a legal experiment and then never execute it (F1). That refusal
 * was the correct fail-closed stop, but a campaign that only ever refuses is not
 * a runner. This module supplies the executor seam.
 *
 * MEASURED GAP G1 (plan(20260926-070459).md §G1) — NOW CLOSED
 * -----------------------------------------------------------
 * The first A5 executor computed two checkout DIGESTS and then ran the DRIVER
 * process's own `runOneCase` with a `candidate` flag. Two different digests did
 * not mean two different builds ran: both arms were ONE build under two names,
 * so the "pair" was not a pair. B3 replaces that with a real ISOLATED WORKER:
 *
 *   1. The driver resolves each arm's FROZEN checkout and PRE-FLIGHT verifies it
 *      before any request: the declared execution closure must resolve
 *      (`computeArmBuildDigestV1`), the entry file must exist, and — when
 *      `R97_ARM_REQUIRE_GIT=1` — the checkout must be a git work tree with a
 *      readable HEAD and a clean `status --porcelain`. Two arms resolving to the
 *      SAME build digest is `ARM_BUILD_IDENTICAL`; an unsupported isolation
 *      backend is `ARM_ISOLATION_UNSUPPORTED`.
 *   2. The driver spawns `scripts/e4/prereg-arm-isolated-worker.mjs` as a real
 *      CHILD PROCESS and hands it the ONE case plus the checkout to load. The
 *      child loads `apps/cli/dist/benchmark-command.js` FROM ITS OWN CHECKOUT,
 *      reads the versioned mechanism probe that build exports, hashes the entry
 *      bytes it actually loaded, and runs the case through THAT build's own
 *      `runOneCase`.
 *   3. Every model request the child's build makes is a stdio frame back to the
 *      driver, serviced by the ONE budget-wrapped `ctx.provider` (the A4/B2
 *      channel). The child owns no provider and reads no key; the physical-call
 *      count is measured where the call really happens.
 *   4. The driver INDEPENDENTLY compares the child's reported entry hash + probe
 *      to its own pre-flight values. A mismatch is `ARM_BUILD_PROBE_MISMATCH`, so
 *      a driver-only flag can no longer make two arms look different.
 *   5. The IMMUTABLE per-run evidence (`manifest.json`, `verifier.json`,
 *      `security.json`, and `activation.json` for an activated candidate) is
 *      written into the driver-created evidence directory, and A6 re-reads it.
 *
 * HONEST LIMITS (not claimed here)
 * --------------------------------
 *   - Hashing a manifest is an INTEGRITY check, not proof of honest execution;
 *     binding the manifest to the trusted budget journal is a further B4 item.
 *   - `R97_ARM_REQUIRE_GIT=1` is the strict git-identity switch. Off by default
 *     so an offline fixture checkout (a plain directory, not a work tree) can
 *     still exercise the worker protocol; a production run turns it on.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelEvent, ModelProvider } from "@ar/contracts";
import {
  PREREG_RUN_EVIDENCE_FILENAMES,
  PREREG_RUN_MANIFEST_SCHEMA,
  PREREG_RUN_SECURITY_SCHEMA,
  PREREG_RUN_VERIFIER_SCHEMA,
  R97_ARM_BUILD_ENTRIES,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  TOOL_DISPATCH_JOURNAL_UNWRITABLE,
  computeArmBuildDigestV1,
  loadBenchmarkCase,
  resolveBenchmarkCaseDir,
  selectionFromFrozenEvidence,
  stableStringify,
  type BenchmarkCase,
  type DurableToolDispatchBudget,
  type EvalOutcome,
  type PreregisteredArmContext,
  type PreregisteredArmEvidence,
  type PreregisteredArmOutcome,
  type PreregisteredArmRunner,
} from "@ar/evaluation";
import { formalExecutionProfile } from "./prereg-execution-identity.js";
import { R97_ARM_ABI_TOOL_BUDGET } from "./r97-arm-abi.js";

/** A stable, machine-readable reason code for every fail-closed refusal here. */
export const ARM_EXECUTOR_NOT_WIRED = "ARM_EXECUTOR_NOT_WIRED";
export const ARM_CHECKOUT_MISSING = "ARM_CHECKOUT_MISSING";
export const ARM_BUILD_UNRESOLVABLE = "ARM_BUILD_UNRESOLVABLE";
export const ARM_BUILD_IDENTICAL = "ARM_BUILD_IDENTICAL";
export const ARM_CASE_NOT_FOUND = "ARM_CASE_NOT_FOUND";
export const ARM_EVIDENCE_DIR_MISSING = "ARM_EVIDENCE_DIR_MISSING";
/** B3 — the pre-registration's isolation backend cannot be honoured here. */
export const ARM_ISOLATION_UNSUPPORTED = "ARM_ISOLATION_UNSUPPORTED";
/** B3 — the arm's own build entry is missing/unreadable in its checkout. */
export const ARM_WORKER_ENTRY_MISSING = "ARM_WORKER_ENTRY_MISSING";
/** B3 — the child reported a build identity the driver cannot corroborate. */
export const ARM_BUILD_PROBE_MISMATCH = "ARM_BUILD_PROBE_MISMATCH";
/** B3 — the child process failed, exited early, or produced no result. */
export const ARM_WORKER_FAILED = "ARM_WORKER_FAILED";
/** B3 — the child exceeded its wall-clock bound and was killed. */
export const ARM_WORKER_TIMEOUT = "ARM_WORKER_TIMEOUT";
/**
 * R0/S1 (F1) — the arm build does not declare the `tool-budget-rpc-v1` ABI, so
 * it cannot honour the campaign's durable tool budget. The formal path REFUSES
 * it before the first model request instead of running it with `maxToolCalls`
 * silently unenforced.
 */
export const ARM_WORKER_ABI_UNSUPPORTED = "ARM_WORKER_ABI_UNSUPPORTED";
/**
 * R0/S2 (F2) — the campaign's ONE persisted deadline had already passed when this
 * arm run was about to start. Zero model requests and zero tool dispatches are
 * attempted; the deadline is NOT re-derived as `now + duration`.
 */
export const ARM_DEADLINE_EXCEEDED = "ARM_DEADLINE_EXCEEDED";
/**
 * R0/S2 — the short, EXPLICIT grace the driver gives an aborted model stream to
 * unwind before it stops waiting. Reaching it does NOT mean the remote request
 * was revoked: the result is recorded as unconfirmed.
 */
export const WORKER_CLEANUP_GRACE_MS = 2_000;
/**
 * N1 (F30-1) — the bounded wait for the worker PROCESS to actually exit after it
 * has been stopped. The old code `await`ed the `exited` promise with no bound at
 * all, so a child that wrote a result frame and then refused to exit parked the
 * driver forever. Reaching this bound kills the child hard and takes ONE more
 * bounded look; `exited` is never awaited without a deadline.
 */
export const WORKER_EXIT_GRACE_MS = 2_000;
/**
 * N1 (F30-1) — the short drain grace after the child PROCESS exits (or after a
 * stop is triggered), before the driver gives up on further stdout. `'exit'` may
 * be emitted BEFORE the last buffered stdout data is consumed, so this grace is
 * what stops a process-exit event from pre-empting a result frame the child
 * already wrote. It is a FALLBACK, not a delay: the child's frame stream reaching
 * EOF is the PRIMARY trigger and normally releases the loop immediately, so a
 * well-behaved worker pays nothing.
 */
export const WORKER_EXIT_DRAIN_MS = 1_000;
/**
 * N1 (F30-1) — the DECLARED worst-case total cleanup bound for one arm stop:
 * provider-unwind grace + stdout drain + two bounded waits for the child process
 * to exit. A stop that exceeds it is a bug, not a slow machine. Measured values
 * for every acceptance scenario are recorded in `docs/evidence/n1-worker-lifecycle.md`
 * and are far below this ceiling.
 */
export const N1_WORKER_CLEANUP_BOUND_MS =
  WORKER_CLEANUP_GRACE_MS + WORKER_EXIT_DRAIN_MS + 2 * WORKER_EXIT_GRACE_MS;
/**
 * N1 (F30-1) — the caller cancelled the arm run before/while it was in flight.
 * Cancellation-only: this code is reachable from an `AbortSignal`, never from a
 * flag, so it can stop work but can never grant a capability.
 */
export const ARM_RUN_CANCELLED = "ARM_RUN_CANCELLED";
/**
 * N1 (F30-1) — the worker asked the driver to service a SECOND model request
 * while one was still in flight. The protocol admits ONE active request per
 * worker (see `serviceModelRequest`), so the parent REFUSES it instead of
 * overwriting the live controller — losing the first controller is what made the
 * earlier request uncancellable.
 */
export const ARM_WORKER_PROTOCOL_VIOLATION = "ARM_WORKER_PROTOCOL_VIOLATION";

/** The activation artifact schema (only written for an activated candidate). */
export const PREREG_RUN_ACTIVATION_SCHEMA = "prereg-run-activation-v1";

/** Identity stamped on every manifest this executor writes. */
export const PREREG_ARM_EXECUTOR_ID = "prereg-arm-executor-v1";

/** B3 — the shipped child worker, relative to the repo root. */
export const PREREG_ARM_WORKER_REL = join("scripts", "e4", "prereg-arm-isolated-worker.mjs");
/** The one result line the child writes on stdout. */
export const ARM_WORKER_RESULT_SENTINEL = "__PREREG_ARM_RESULT__";

/** B3 — the isolation backends this executor can actually honour. A pre-registered
 *  experiment naming anything else is refused before any request.
 *
 *  R5 adds the audited `trusted-build` posture: two REAL, git-pinned checkouts,
 *  with NO OS network sandbox. The strength string says so in as many words, so
 *  nothing downstream can read the mode as an isolation claim. */
const SUPPORTED_ISOLATION: Record<string, readonly string[]> = {
  "process-exec": ["process"],
  // R5 — the values of TRUSTED_BUILD_BACKEND_ID / TRUSTED_BUILD_STRENGTH
  // (declared below; they cannot be referenced here, this map is initialized
  // before them). The two are pinned together by a test.
  "trusted-build": ["no-os-network-sandbox"],
};

/** B3 — the mechanism probe export every real arm build carries. */
export const ARM_PROBE_EXPORT = "R97_ARM_PROBE";

/**
 * N5 — the isolation backend cannot be honoured for an UNTRUSTED checkout because
 * no provable egress boundary exists on this platform.
 */
export const EGRESS_ISOLATION_UNAVAILABLE = "EGRESS_ISOLATION_UNAVAILABLE";

/**
 * N5/R1 — the marker a SYNTHETIC fixture checkout carries, alongside the
 * test-host trust capability (see `createFixtureCheckoutTrust`).
 *
 * R1/F2 (P0): this marker is a PROVENANCE BREADCRUMB AND NOTHING MORE. On the
 * audited baseline the executor trusted a checkout SOLELY because this file
 * existed, so any writer could create/copy/link it into an arbitrary tree and the
 * executor would run that tree as if the harness had authored it. A filename is
 * not provenance: the trust anchor is the out-of-band capability the TEST HOST
 * injects, and this marker is only an additional regular-file requirement on a
 * checkout that capability already pinned.
 */
export const FIXTURE_CHECKOUT_MARKER_FILENAME = ".r97-synthetic-fixture-checkout";

/**
 * R1/F2 — the brand of the TEST-HOST-owned fixture-checkout trust capability.
 * Module-private on purpose: an object literal cannot carry it, so a JSON/env/
 * marker-driven bypass cannot fabricate one.
 */
const FIXTURE_CHECKOUT_TRUST_BRAND: unique symbol = Symbol("ar.cli.fixtureCheckoutTrust");

/** R1/F2 — one checkout the test host pinned, with the hashes it pinned. */
export interface TrustedFixtureCheckout {
  /** Canonical (`realpath`) checkout directory. */
  readonly dir: string;
  /** The build-closure digest observed when the capability was created. */
  readonly buildDigest: string;
  /** The sha256 of the arm build entry observed at the same moment. */
  readonly entrySha256: string;
}

/**
 * R1/F2 — a capability that says "these EXACT directories were produced by the
 * harness fixture writer, and their bytes were THESE". Not reachable from the
 * production CLI: no env var, JSON field, marker file, port or flag produces it.
 */
export interface FixtureCheckoutTrust {
  readonly [FIXTURE_CHECKOUT_TRUST_BRAND]: true;
  readonly checkouts: readonly TrustedFixtureCheckout[];
}

/**
 * R1/F2 — pin the fixture checkouts the TEST HOST wrote. Computes each pinned
 * checkout's canonical path, build digest and entry hash AT ISSUE TIME, so the
 * executor can verify — immediately before the worker starts — that the tree it
 * was pointed at is still byte-for-byte the tree that was trusted. A tree that
 * cannot establish its closure throws here (fail closed): a capability for an
 * unbuilt tree would be a capability for nothing.
 */
export function createFixtureCheckoutTrust(...dirs: readonly string[]): FixtureCheckoutTrust {
  const rel = R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"));
  if (rel === undefined) throw new Error(`${ARM_WORKER_ENTRY_MISSING}: the shared arm build entry list names no benchmark-command.js`);
  const checkouts = dirs.map((dir) => {
    const real = realpathSync(dir);
    const entryPath = join(real, rel);
    const st = lstatSync(entryPath);
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new Error(`${ARM_WORKER_ENTRY_MISSING}: ${real} has no regular build entry ${rel}`);
    }
    return {
      dir: real,
      buildDigest: computeArmBuildDigestV1(real),
      entrySha256: sha256Hex(readFileSync(entryPath, "utf8")),
    };
  });
  return Object.freeze({
    [FIXTURE_CHECKOUT_TRUST_BRAND]: true as const,
    checkouts: Object.freeze(checkouts),
  });
}

/** R1/F2 — is this the real branded capability (not a look-alike object)? */
export function isFixtureCheckoutTrust(value: unknown): value is FixtureCheckoutTrust {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[FIXTURE_CHECKOUT_TRUST_BRAND] === true
  );
}

// ---------------------------------------------------------------------------
// R5 — the AUDITED TRUSTED-BUILD mode
//
// The fixture capability above answers "may this process run code the HARNESS
// generated?". R5 needs the other question: "may this process run TWO REAL,
// operator-built arms of this repository?" The answer is a DECLARED mode, not a
// marker and not an env variable:
//
//   isolationBackendId = "trusted-build"
//   isolationStrength  = "no-os-network-sandbox"
//
// Both strings live in the pre-registration artifact, so the mode is bound by the
// artifact digest and by the authorization that names that digest: changing the
// posture invalidates the approval. A marker file, an env var or a CLI flag
// cannot switch it on — and the mode's own NAME states the honest limitation
// (there is NO OS network sandbox behind it).
//
// What the mode enforces, immediately before the child starts:
//
//   1. BOTH checkouts are real git work trees at a 40-hex HEAD;
//   2. BOTH are CLEAN (`git status --porcelain` empty);
//   3. BOTH resolve their declared execution closure, and the two closures
//      DIFFER (one build under two names is not a paired experiment);
//   4. the entry the worker will load is a regular file, and it is hashed so the
//      worker's own report can be compared against it;
//   5. when the TEST HOST injected a `TrustedBuildGrant`, the canonical directory
//      of each arm, its git HEAD, its closure digest and its entry hash all equal
//      the pinned values — so a swapped directory, a swapped HEAD, a dirty tree
//      or a swapped closure is refused HERE.
// ---------------------------------------------------------------------------

/** R5 — the declared isolation backend that means "audited real builds, no sandbox". */
export const TRUSTED_BUILD_BACKEND_ID = "trusted-build";
/** R5 — the honest strength: this mode claims NO OS network isolation. */
export const TRUSTED_BUILD_STRENGTH = "no-os-network-sandbox";
/** R5 — a checkout that cannot prove its git identity/closure is not trusted. */
export const TRUSTED_BUILD_NOT_PROVEN = "TRUSTED_BUILD_NOT_PROVEN";

/** R5 — the statement every trusted-build refusal and record carries. */
export const TRUSTED_BUILD_NETWORK_SANDBOX = "none";

/**
 * R5 — the brand of the TEST-HOST-owned trusted-build capability.
 * Module-private on purpose: no JSON/env/marker can fabricate one.
 */
const TRUSTED_BUILD_BRAND: unique symbol = Symbol("ar.cli.trustedBuildGrant");

/** R5 — one arm checkout the test host pinned, with the identity it pinned. */
export interface TrustedBuildPin {
  readonly armId: "baseline" | "candidate";
  /** Canonical (`realpath`) checkout directory. */
  readonly dir: string;
  /** The git HEAD observed when the grant was issued (40-hex). */
  readonly gitHead: string;
  /** The execution-closure digest observed at the same moment. */
  readonly buildDigest: string;
  /** The sha256 of the arm build entry observed at the same moment. */
  readonly entrySha256: string;
}

/**
 * R5 — a capability that says "these EXACT directories were the audited arm
 * builds, at THESE git HEADs and THESE bytes". Not reachable from the production
 * CLI: no env var, JSON field, marker file, port or flag produces it.
 */
export interface TrustedBuildGrant {
  readonly [TRUSTED_BUILD_BRAND]: true;
  readonly isolationBackendId: typeof TRUSTED_BUILD_BACKEND_ID;
  readonly isolationStrength: typeof TRUSTED_BUILD_STRENGTH;
  /** The honest capability statement: this grant proves NO network isolation. */
  readonly networkSandbox: typeof TRUSTED_BUILD_NETWORK_SANDBOX;
  readonly detail: string;
  readonly pins: readonly TrustedBuildPin[];
}

function trustedBuildEntryRel(): string {
  const rel = R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"));
  if (rel === undefined) throw new Error(`${ARM_WORKER_ENTRY_MISSING}: the shared arm build entry list names no benchmark-command.js`);
  return rel;
}

/**
 * R5 — pin the two real arm checkouts the TEST HOST audited. Every field is
 * OBSERVED here, at issue time, so the executor can verify immediately before the
 * worker starts that the tree it was pointed at is still the tree that was
 * audited. A checkout that cannot establish its git identity or its build closure
 * throws (fail closed): a grant for an unprovable tree is a grant for nothing.
 */
export function createTrustedBuildGrant(input: {
  baselineDir: string;
  candidateDir: string;
}): TrustedBuildGrant {
  const rel = trustedBuildEntryRel();
  const pin = (armId: "baseline" | "candidate", dir: string): TrustedBuildPin => {
    const real = realpathSync(dir);
    const head = execFileSync("git", ["-C", real, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!/^[0-9a-f]{40}$/.test(head)) {
      throw new Error(`${TRUSTED_BUILD_NOT_PROVEN}: ${real} is not a git work tree at a 40-hex HEAD (head=${head})`);
    }
    const entryPath = join(real, rel);
    const st = lstatSync(entryPath);
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new Error(`${ARM_WORKER_ENTRY_MISSING}: ${real} has no regular build entry ${rel}`);
    }
    return {
      armId,
      dir: real,
      gitHead: head,
      buildDigest: computeArmBuildDigestV1(real),
      entrySha256: sha256Hex(readFileSync(entryPath, "utf8")),
    };
  };
  const pins = [
    pin("baseline", input.baselineDir),
    pin("candidate", input.candidateDir),
  ];
  if (pins[0]!.buildDigest === pins[1]!.buildDigest) {
    throw new Error(`${ARM_BUILD_IDENTICAL}: the two granted checkouts resolve to the SAME build digest — an experiment with one build is not a paired experiment`);
  }
  return Object.freeze({
    [TRUSTED_BUILD_BRAND]: true as const,
    isolationBackendId: TRUSTED_BUILD_BACKEND_ID,
    isolationStrength: TRUSTED_BUILD_STRENGTH,
    networkSandbox: TRUSTED_BUILD_NETWORK_SANDBOX,
    detail:
      "test-host-issued trusted-build grant: two AUDITED real checkouts pinned by canonical directory, git HEAD, execution-closure digest and entry hash. It proves WHAT runs, not that running it is safe — this build establishes NO OS network sandbox on Windows or Ubuntu.",
    pins: Object.freeze(pins),
  });
}

/** R5 — is this the real branded grant (not a look-alike object)? */
export function isTrustedBuildGrant(value: unknown): value is TrustedBuildGrant {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[TRUSTED_BUILD_BRAND] === true
  );
}

/** R5 — the verdict of the CHEAP git identity of ONE arm checkout (no closure
 *  walk): a real work tree at a 40-hex HEAD with an EMPTY status. */
interface ArmGitHead {
  ok: boolean;
  detail: string;
  gitHead: string | null;
}

/**
 * R5 — HEAD + cleanliness. Deliberately separate from the closure digest: these
 * are the cheapest checks and they run FIRST, so a tree that is not a clean git
 * work tree is refused with the reason that actually applies ("dirty") instead of
 * a downstream closure error.
 */
function armGitHeadAndClean(dir: string, armId: "baseline" | "candidate"): ArmGitHead {
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (head === null || !/^[0-9a-f]{40}$/.test(head)) {
    return { ok: false, detail: `the ${armId} checkout is not a git work tree at a 40-hex HEAD (head=${head === null ? "unreadable" : head})`, gitHead: null };
  }
  const porcelain = git(dir, ["status", "--porcelain"]);
  if (porcelain === null || porcelain !== "") {
    return { ok: false, detail: `the ${armId} checkout is DIRTY${porcelain === null ? " (git status unreadable)" : ""} — an arm must run from an exact, unmodified tree`, gitHead: head };
  }
  return { ok: true, detail: "", gitHead: head };
}

/** R5 — the verdict of the git/closure identity of ONE arm checkout. */
interface ArmGitIdentity {
  ok: boolean;
  detail: string;
  gitHead: string | null;
  buildDigest: string | null;
}

/**
 * R5 — prove the git/closure identity of ONE arm checkout. This is a CHECK, not a
 * claim: an unreadable HEAD, a dirty tree or an unresolvable closure is a refusal.
 * It is what removes the old dependence on the operator remembering
 * `R97_ARM_REQUIRE_GIT=1`.
 */
function armGitIdentity(dir: string, armId: "baseline" | "candidate"): ArmGitIdentity {
  const head = armGitHeadAndClean(dir, armId);
  if (!head.ok) return { ok: false, detail: head.detail, gitHead: head.gitHead, buildDigest: null };
  let buildDigest: string;
  try {
    buildDigest = computeArmBuildDigestV1(dir);
  } catch {
    return { ok: false, detail: `the ${armId} checkout's declared execution closure cannot be established`, gitHead: head.gitHead, buildDigest: null };
  }
  return { ok: true, detail: "", gitHead: head.gitHead, buildDigest };
}

/**
 * R5 — verify the injected grant against the checkout this arm run is about to
 * use. Every pinned field must still hold: a swapped directory, a swapped HEAD, a
 * dirty tree, a swapped closure or a swapped entry is refused BEFORE the child
 * starts. Refusals name the field, so the evidence says WHAT moved.
 */
function verifyTrustedBuildGrant(
  grant: TrustedBuildGrant | undefined,
  armId: "baseline" | "candidate",
  armDir: string,
  identity: ArmGitIdentity,
): { trusted: boolean; detail: string } {
  if (!isTrustedBuildGrant(grant)) {
    return { trusted: false, detail: "no test-host trusted-build grant was injected into this executor" };
  }
  if (grant.isolationBackendId !== TRUSTED_BUILD_BACKEND_ID || grant.isolationStrength !== TRUSTED_BUILD_STRENGTH) {
    return { trusted: false, detail: `the injected grant was issued for ${grant.isolationBackendId}/${grant.isolationStrength}, not the declared mode` };
  }
  let real: string;
  try {
    real = realpathSync(armDir);
  } catch {
    return { trusted: false, detail: `the ${armId} checkout path cannot be canonicalised` };
  }
  const pinned = grant.pins.find((p) => p.armId === armId);
  if (pinned === undefined) {
    return { trusted: false, detail: `the injected grant pins no ${armId} checkout` };
  }
  if (pinned.dir !== real) {
    return { trusted: false, detail: `the ${armId} checkout is not the directory the grant pinned (a swapped checkout directory is not trusted)` };
  }
  if (identity.gitHead === null || identity.gitHead !== pinned.gitHead) {
    return { trusted: false, detail: `the ${armId} checkout HEAD is ${identity.gitHead === null ? "unreadable" : identity.gitHead.slice(0, 12)}, not the granted ${pinned.gitHead.slice(0, 12)} (a swapped SHA is not trusted)` };
  }
  if (identity.buildDigest === null || identity.buildDigest !== pinned.buildDigest) {
    return { trusted: false, detail: `the ${armId} checkout's build closure no longer matches the granted digest (a swapped closure is not trusted)` };
  }
  const rel = trustedBuildEntryRel();
  try {
    const entryPath = join(real, rel);
    const st = lstatSync(entryPath);
    if (!st.isFile() || st.isSymbolicLink()) return { trusted: false, detail: `the ${armId} arm build entry is not a regular file` };
    if (sha256Hex(readFileSync(entryPath, "utf8")) !== pinned.entrySha256) {
      return { trusted: false, detail: `the ${armId} arm build entry no longer matches the granted hash (a swapped entry is not trusted)` };
    }
  } catch {
    return { trusted: false, detail: `the ${armId} checkout no longer resolves its declared build entry` };
  }
  return { trusted: true, detail: "" };
}

/**
 * R1/F2 — decide whether THIS checkout may start. Every condition is verified
 * before the child is spawned:
 *
 *   1. a branded capability was injected by the test host at all;
 *   2. the marker exists and is a REGULAR, non-symlink file (a copied, hard-linked
 *      or symlinked marker is not provenance);
 *   3. the checkout's CANONICAL path is one this capability pinned — so a copied
 *      tree, even one with an identical marker, is not trusted;
 *   4. its build closure and entry bytes still equal the pinned hashes — so
 *      swapping the entry (or moving it) after the capability was issued is not
 *      trusted.
 *
 * It returns the REASON on refusal so the refusal message names what failed.
 */
function verifyFixtureCheckoutTrust(
  trust: FixtureCheckoutTrust | undefined,
  armDir: string,
  armId: "baseline" | "candidate",
): { trusted: boolean; detail: string } {
  if (!isFixtureCheckoutTrust(trust)) {
    return {
      trusted: false,
      detail: "no test-host fixture trust capability was injected into this executor",
    };
  }
  const markerPath = join(armDir, FIXTURE_CHECKOUT_MARKER_FILENAME);
  try {
    const st = lstatSync(markerPath);
    if (!st.isFile() || st.isSymbolicLink()) {
      return {
        trusted: false,
        detail: `the synthetic-fixture marker on the ${armId} checkout is not a regular file (a symlink/directory marker is not provenance)`,
      };
    }
  } catch {
    return { trusted: false, detail: `the ${armId} checkout carries no regular synthetic-fixture marker` };
  }
  let real: string;
  try {
    real = realpathSync(armDir);
  } catch {
    return { trusted: false, detail: `the ${armId} checkout path cannot be canonicalised` };
  }
  const pinned = trust.checkouts.find((c) => c.dir === real);
  if (pinned === undefined) {
    return {
      trusted: false,
      detail: `the ${armId} checkout is not one of the ${trust.checkouts.length} checkout(s) the injected fixture capability pinned`,
    };
  }
  try {
    if (computeArmBuildDigestV1(armDir) !== pinned.buildDigest) {
      return {
        trusted: false,
        detail: `the ${armId} checkout's build closure no longer matches the digest pinned when the fixture capability was issued (a swapped or moved entry is not trusted)`,
      };
    }
    const rel = R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"));
    if (rel === undefined) return { trusted: false, detail: "no declared benchmark-command.js entry" };
    const entryPath = join(armDir, rel);
    const entryStat = lstatSync(entryPath);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return { trusted: false, detail: `the ${armId} arm build entry is not a regular file` };
    }
    if (sha256Hex(readFileSync(entryPath, "utf8")) !== pinned.entrySha256) {
      return {
        trusted: false,
        detail: `the ${armId} arm build entry no longer matches the hash pinned when the fixture capability was issued (a swapped entry is not trusted)`,
      };
    }
  } catch {
    return { trusted: false, detail: `the ${armId} checkout no longer resolves its declared build closure` };
  }
  return { trusted: true, detail: "" };
}

/**
 * N5 — the ONLY environment a worker may inherit. An explicit ALLOWLIST, because
 * "copy the driver env and delete the provider keys" cannot be audited: it leaked
 * `HTTP(S)_PROXY`/`NO_PROXY`, cloud credentials (`AWS_*`, `AZURE_*`, `GOOGLE_*`),
 * other providers' tokens (`ANTHROPIC_*`, `DEEPSEEK_*`), config-file pointers
 * (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `NPM_CONFIG_*`) and — worst —
 * `NODE_OPTIONS`, which injects arbitrary code into every child Node process.
 *
 * Every entry below is either an OS essential needed to START node and resolve
 * modules (all non-secret) or one of the worker's own declared inputs. No proxy,
 * credential, token, config or Node-injection variable is on the list.
 */
const WORKER_ENV_ALLOWLIST = [
  // OS essentials required to launch node and resolve modules, on Windows AND Linux.
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  // The worker's own declared inputs (paths and the explicit git gate).
  "R97_ARM_BASELINE_DIR",
  "R97_ARM_CANDIDATE_DIR",
  "R97_CAMPAIGN_CLAIMS_DIR",
  "R97_ARM_REQUIRE_GIT",
] as const;

/**
 * N5 — is there a provable single-egress boundary for UNTRUSTED code here? The
 * Node permission model does not cover network access, and this build establishes
 * no OS-level sandbox on either Windows or Ubuntu. The honest answer is NO, so the
 * caller must refuse untrusted execution BEFORE it starts rather than discovering
 * a leak after a request has left. Recorded as a capability, not as a claim of
 * isolation.
 */
export function egressIsolationCapability(): { available: boolean; backend: string; detail: string } {
  return {
    available: false,
    backend: "none",
    detail:
      "no portably provable network-isolation boundary exists in this build: the Node permission model does not cover network access, and no OS-level sandbox is established on Windows or Ubuntu",
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isDir(path: string | undefined): path is string {
  if (path === undefined || path === "") return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A STABLE refusal. The error carries the stable `code` AND, when the refusal
 * came out of an arm-run stop, the OBSERVED cancellation record.
 *
 * N1 (F30-1) — plan §4 item 7: "错误路径的 cancellation 观测应能被测试和 artifact
 * 读取，不只留在抛错前的局部变量". Before N1 the abort facts existed only as local
 * variables inside `launchArmWorker` that were discarded by the very `refuse()`
 * that reported the failure, so neither a test nor a report could read them. The
 * record is attached here as a NON-ENUMERABLE property so it never changes the
 * error's serialized shape or its `message`, while remaining directly readable.
 */
function refuse(code: string, message: string, cancellation?: WorkerCancellationRecord): never {
  const err = new Error(`${code}: ${message}`);
  (err as { code?: string }).code = code;
  if (cancellation !== undefined) {
    Object.defineProperty(err, "cancellation", {
      value: cancellation,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  throw err;
}

/**
 * N1 (F30-1) — the OBSERVED cancellation facts for one arm-run stop, as attached
 * to a refusal. Structurally the `cancellation` field of `LaunchArmWorkerResult`,
 * named so a reader of a thrown error does not have to import the internal type.
 */
export type WorkerCancellationRecord = LaunchArmWorkerResult["cancellation"];

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * The arm's real build digest, or a STABLE refusal. A directory that exists but
 * whose declared execution closure cannot be established (a missing/moved
 * `apps/cli/dist/…`, an import that escapes the checkout) must not surface as an
 * opaque internal identity error: an arm that cannot PROVE its build is not an
 * arm this executor may run.
 */
function armBuildDigestOrRefuse(armId: "baseline" | "candidate", dir: string): string {
  try {
    return computeArmBuildDigestV1(dir);
  } catch {
    refuse(
      ARM_BUILD_UNRESOLVABLE,
      `the ${armId} arm checkout exists but its declared execution closure (${R97_ARM_BUILD_ENTRIES.length} entries, R97_ARM_${armId.toUpperCase()}_DIR) cannot be established — the checkout is not a built tree`,
    );
  }
}

/** The arm's own build entry, hashed. Missing/unreadable → the arm cannot run. */
function armEntryPathOrRefuse(armId: "baseline" | "candidate", dir: string): { path: string; sha256: string } {
  // `R97_ARM_BUILD_ENTRIES[1]` is `apps/cli/dist/benchmark-command.js`, the entry
  // the worker loads. Reading the position from the shared constant keeps the
  // worker's target and the driver's pre-flight the same file.
  const rel = R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"));
  if (rel === undefined) refuse(ARM_WORKER_ENTRY_MISSING, "the shared arm build entry list names no benchmark-command.js");
  const path = join(dir, rel);
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch {
    refuse(ARM_WORKER_ENTRY_MISSING, `the ${armId} arm has no readable build entry ${rel} in its checkout — the arm cannot be launched`);
  }
  return { path, sha256: sha256Hex(readFileSync(path, "utf8")) };
}

/**
 * N5 — build the worker's environment from the ALLOWLIST. Fail closed: a name that
 * is not listed is not passed, whatever it is. The old form
 * (`{ ...env }` then delete four keys) is deliberately gone.
 */
export function buildWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of WORKER_ENV_ALLOWLIST) {
    const v = env[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * A line-delimited reader over a child stream that never loses a frame.
 *
 * N1 (F30-1) — `release()` is the BOUNDED release added for this task. A reader
 * whose stream never closes (a child that exited while its pipe stayed open, or a
 * stopped worker whose stdout is still held) would park `next()` forever, which
 * is exactly the unbounded wait F30-1 is about. `release()` ends the stream
 * LOGICALLY: every queued line is still delivered first, then `next()` resolves
 * `null`. It is idempotent, and it deliberately does NOT race a second `next()`
 * against a discarded one — a discarded `next()` leaves a waiter in the queue
 * that would consume the very line the caller is still waiting for.
 */
function createLineReader(stream: NodeJS.ReadableStream): {
  next: () => Promise<string | null>;
  release: () => void;
} {
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let ended = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      if (waiters.length > 0) waiters.shift()!(line);
      else queued.push(line);
    }
  });
  stream.on("end", () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!(null);
  });
  stream.on("error", () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!(null);
  });
  return {
    next(): Promise<string | null> {
      if (queued.length > 0) return Promise.resolve(queued.shift()!);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    release(): void {
      ended = true;
      while (waiters.length > 0) waiters.shift()!(null);
    },
  };
}

interface WorkerReport {
  ok: boolean;
  code?: string;
  error?: string;
  armBuildReport?: { entryRel: string; entrySha256: string; probe: string; abi?: string[] } | null;
  outcome?: EvalOutcome;
  proxyBudget?: { modelCalls: number; toolReserves?: number; toolSettles?: number };
}

export interface PreregArmExecutorDeps {
  /** Repository root the frozen selection and the real cases are read from. */
  rootDir: string;
  /** Environment the arm checkouts and the execution profile are read from. */
  env: NodeJS.ProcessEnv;
  /** B3 — the pre-registration's isolation contract. Defaults to the shipped
   *  `process-exec`/`process` backend; anything else is refused. */
  isolation?: { isolationBackendId?: string; isolationStrength?: string };
  /** B3 — override the child worker path (tests). Defaults to the shipped one. */
  workerPath?: string;
  /** B3 — the wall-clock bound on one arm-run child process. */
  workerTimeoutMs?: number;
  /**
   * R1/F2 — the TEST-HOST fixture-checkout trust capability. Only
   * `createFixtureCheckoutTrust` produces a value this option accepts, and the
   * production CLI (`createProductionPreregRunner` with no option) supplies none,
   * so the release CLI accepts NO fixture-bypass configuration.
   *
   * A checkout is trusted iff it is one the capability pinned AND its bytes still
   * match the pinned digests. The `.r97-synthetic-fixture-checkout` marker is
   * required but is NEVER sufficient — a marker alone, copied, hard-linked or
   * symlinked, upgrades nothing.
   */
  trustedFixtureCheckouts?: FixtureCheckoutTrust;
  /**
   * R5 — the TEST-HOST trusted-build grant for the audited `trusted-build` mode.
   * Only `createTrustedBuildGrant` produces a value this option accepts. When it
   * is supplied, the mode additionally requires every pinned field (canonical
   * directory, git HEAD, closure digest, entry hash) to still hold.
   *
   * It is OPTIONAL because the mode is self-proving: a clean git work tree whose
   * closure resolves is enough for the DECLARED audited posture. The grant is what
   * makes "swapped SHA / swapped closure / swapped directory" refusals precise.
   */
  trustedBuildGrant?: TrustedBuildGrant;
}

/**
 * Build the real `runArm`. Every prerequisite the executor cannot establish —
 * a frozen checkout, two distinct arm builds, a real case, an evidence
 * directory, a budgeted provider, a supported isolation backend, a child that
 * actually ran the arm's own build — is a refusal with a stable code, never a
 * fabricated `{ status: "passed" }`.
 */
export function createPreregArmExecutor(deps: PreregArmExecutorDeps): PreregisteredArmRunner {
  const root = deps.rootDir;
  const env = deps.env;
  const profile = formalExecutionProfile(env);
  const workerPath = deps.workerPath ?? join(root, PREREG_ARM_WORKER_REL);
  const configuredWorkerTimeoutMs = deps.workerTimeoutMs ?? 600_000;

  // The frozen selection is the ONLY source of `caseId -> suite`. It is read
  // once, lazily, so construction stays free of I/O.
  let suiteByCaseId: Map<string, string> | null = null;
  const suiteOf = (caseId: string): string | null => {
    if (suiteByCaseId === null) {
      const resolved = selectionFromFrozenEvidence({ root });
      suiteByCaseId = new Map(resolved.frozen.cases.map((c) => [c.caseId, c.suite]));
    }
    return suiteByCaseId.get(caseId) ?? null;
  };

  return async (arm, ctx: PreregisteredArmContext): Promise<PreregisteredArmOutcome> => {
    // --- 0. the isolation contract the pre-registration actually named ------
    const backendId = deps.isolation?.isolationBackendId ?? "process-exec";
    const strength = deps.isolation?.isolationStrength ?? "process";
    const allowed = SUPPORTED_ISOLATION[backendId];
    if (allowed === undefined || !allowed.includes(strength)) {
      refuse(
        ARM_ISOLATION_UNSUPPORTED,
        `the pre-registered isolation backend ${backendId}/${strength} cannot be honoured by this build (supported: ${Object.entries(SUPPORTED_ISOLATION)
          .map(([b, s]) => `${b}/${s.join("|")}`)
          .join(", ")})`,
      );
    }

    // --- 1. the frozen arm checkout and its real build digest ---------------
    const armDir = arm.armId === "candidate" ? env["R97_ARM_CANDIDATE_DIR"] : env["R97_ARM_BASELINE_DIR"];
    if (!isDir(armDir)) {
      refuse(
        ARM_CHECKOUT_MISSING,
        `the ${arm.armId} arm has no frozen checkout (set R97_ARM_${arm.armId.toUpperCase()}_DIR) — an arm without its build cannot be run`,
      );
    }
    const otherDir = arm.armId === "candidate" ? env["R97_ARM_BASELINE_DIR"] : env["R97_ARM_CANDIDATE_DIR"];
    // R5 — git identity is a property of the DECLARED mode, not of an env var the
    // operator has to remember. `trusted-build` ALWAYS proves HEAD + clean tree for
    // BOTH arms, BEFORE the closure walk, so the refusal names what actually
    // failed; the legacy env flag is kept only as extra strictness for the fixture
    // posture.
    const isTrustedBuild = backendId === TRUSTED_BUILD_BACKEND_ID && strength === TRUSTED_BUILD_STRENGTH;
    const requireGit = isTrustedBuild || env["R97_ARM_REQUIRE_GIT"] === "1";
    const counterpartArmId: "baseline" | "candidate" = arm.armId === "candidate" ? "baseline" : "candidate";
    const gitHead = requireGit ? armGitHeadAndClean(armDir, arm.armId) : null;
    const counterpartGitHead = requireGit && isDir(otherDir) ? armGitHeadAndClean(otherDir, counterpartArmId) : null;
    if (gitHead !== null && !gitHead.ok) {
      refuse(
        isTrustedBuild ? TRUSTED_BUILD_NOT_PROVEN : ARM_BUILD_UNRESOLVABLE,
        `${isTrustedBuild ? `the declared ${TRUSTED_BUILD_BACKEND_ID}/${TRUSTED_BUILD_STRENGTH} mode requires` : "R97_ARM_REQUIRE_GIT=1 but"}: ${gitHead.detail}`,
      );
    }
    if (counterpartGitHead !== null && !counterpartGitHead.ok) {
      refuse(
        isTrustedBuild ? TRUSTED_BUILD_NOT_PROVEN : ARM_BUILD_UNRESOLVABLE,
        `${isTrustedBuild ? `the declared ${TRUSTED_BUILD_BACKEND_ID}/${TRUSTED_BUILD_STRENGTH} mode requires` : "R97_ARM_REQUIRE_GIT=1 but"}: ${counterpartGitHead.detail}`,
      );
    }
    const armBuildDigest = armBuildDigestOrRefuse(arm.armId, armDir);
    if (isDir(otherDir) && armBuildDigestOrRefuse(arm.armId === "candidate" ? "baseline" : "candidate", otherDir) === armBuildDigest) {
      refuse(
        ARM_BUILD_IDENTICAL,
        `${arm.armId} and its counterpart resolve to the SAME build digest (${armBuildDigest.slice(0, 12)}…) — an experiment with one build is not a paired experiment`,
      );
    }
    // Pre-flight the entry the worker will load — all BEFORE any request leaves.
    const entry = armEntryPathOrRefuse(arm.armId, armDir);
    const identity: ArmGitIdentity = {
      ok: true,
      detail: "",
      gitHead: gitHead?.gitHead ?? null,
      buildDigest: armBuildDigest,
    };

    // --- 2. the evidence directory the A6 re-verification reads back --------
    if (typeof ctx.evidenceDir !== "string" || ctx.evidenceDir.length === 0) {
      refuse(
        ARM_EVIDENCE_DIR_MISSING,
        "the driver did not provide an evidence directory — a run whose raw artifacts have nowhere to be written cannot be verified",
      );
    }

    // --- 3. the REAL case, located from the frozen selection ----------------
    const suite = suiteOf(arm.caseId);
    if (suite === null) {
      refuse(ARM_CASE_NOT_FOUND, `case ${arm.caseId} is not part of the frozen selection`);
    }
    const caseDir = resolveBenchmarkCaseDir(root, suite, arm.caseId);
    if (caseDir === null) {
      refuse(ARM_CASE_NOT_FOUND, `case ${suite}/${arm.caseId} is not a readable benchmarks/<suite>/<caseId> directory`);
    }
    if (!existsSync(workerPath)) {
      refuse(ARM_WORKER_ENTRY_MISSING, `the isolated arm worker ${PREREG_ARM_WORKER_REL} is not present in this checkout`);
    }
    const caseDef = await loadBenchmarkCase(caseDir);

    // --- 3b. the EGRESS TRUST BOUNDARY (N5/R1, extended by R5) ---------------
    // Two admitted postures, each with its OWN proof obligation:
    //
    //   `trusted-build` (R5) — the DECLARED audited posture. The proof is the git
    //     identity + clean tree + resolvable, DIFFERING closures of BOTH arms
    //     (verified above), plus, when injected, every field of the test-host
    //     grant. The mode's OWN NAME states the limitation it does not remove:
    //     NO OS network sandbox exists on this platform. It is an audited trust
    //     declaration about WHICH bytes run, not an isolation claim.
    //
    //   `process-exec` (R1) — a checkout may start only when the TEST HOST
    //     injected a fixture trust capability that pins THIS canonical directory
    //     and the hashes it had when the capability was issued. The marker is an
    //     additional regular-file requirement, never the trust source. Every
    //     OTHER checkout is untrusted, and untrusted code may only run behind a
    //     provable single-egress boundary — which does not exist here, so it is
    //     refused BEFORE the child starts.
    if (isTrustedBuild) {
      const granted = verifyTrustedBuildGrant(deps.trustedBuildGrant, arm.armId, armDir, identity);
      // A grant, when present, is BINDING: a pinned checkout whose fields moved is
      // refused rather than silently fallen back to the self-proving check.
      if (deps.trustedBuildGrant !== undefined && !granted.trusted) {
        refuse(TRUSTED_BUILD_NOT_PROVEN, `the injected trusted-build grant does not hold for the ${arm.armId} checkout: ${granted.detail}`);
      }
      if (!identity.ok || identity.gitHead === null) {
        refuse(TRUSTED_BUILD_NOT_PROVEN, `the ${arm.armId} checkout cannot prove the git identity the ${TRUSTED_BUILD_BACKEND_ID}/${TRUSTED_BUILD_STRENGTH} mode requires: ${identity.detail}`);
      }
      if (counterpartGitHead !== null && !counterpartGitHead.ok) {
        refuse(TRUSTED_BUILD_NOT_PROVEN, `the counterpart checkout cannot prove the git identity the ${TRUSTED_BUILD_BACKEND_ID}/${TRUSTED_BUILD_STRENGTH} mode requires: ${counterpartGitHead.detail}`);
      }
      // Recorded, not claimed: the mode provides no network isolation.
      process.stderr.write(
        `[prereg] trusted-build mode: ${arm.armId} @ ${identity.gitHead.slice(0, 12)} closure ${armBuildDigest.slice(0, 12)}… network sandbox=${TRUSTED_BUILD_NETWORK_SANDBOX}\n`,
      );
    } else {
      const fixtureTrust = verifyFixtureCheckoutTrust(deps.trustedFixtureCheckouts, armDir, arm.armId);
      const capability = egressIsolationCapability();
      if (!fixtureTrust.trusted && !capability.available) {
        refuse(
          EGRESS_ISOLATION_UNAVAILABLE,
          `the ${arm.armId} checkout is not a fixture build this process TRUSTS (${fixtureTrust.detail}) and this build cannot prove a single-egress boundary for untrusted code (${capability.detail}) — refusing to START it rather than discovering the leak after a request left`,
        );
      }
    }

    // --- 4. run the arm's OWN build in an isolated child process ------------
    //
    // R0/S2 (F2) — THE ONE DEADLINE. `campaignDeadlineAtMs` is the instant the
    // cost journal already holds, so the effective per-arm bound is
    // min(campaign remaining, workerTimeoutMs) and a RESUME reuses the original
    // deadline instead of recomputing `now + duration`. An already-expired
    // campaign is refused HERE, so it makes zero model requests and zero tool
    // dispatches.
    const campaignDeadlineAtMs = ctx.campaignDeadlineAtMs ?? null;
    let workerTimeoutMs = configuredWorkerTimeoutMs;
    if (campaignDeadlineAtMs !== null) {
      const remaining = campaignDeadlineAtMs - Date.now();
      if (remaining <= 0) {
        refuse(
          ARM_DEADLINE_EXCEEDED,
          `the campaign deadline (${new Date(campaignDeadlineAtMs).toISOString()}) had already passed when ${ctx.armRunId} was about to start — ` +
            `refusing before the first model request rather than re-deriving a fresh window`,
        );
      }
      if (remaining < workerTimeoutMs) {
        workerTimeoutMs = remaining;
      }
    }

    // N3 — COVERAGE. The producing execution declares, BEFORE it launches the
    // arm's worker, that it OBSERVED this arm run. That is what makes a truly
    // zero-tool arm run provable: the journal exists, names the arm run and
    // carries 0 reserve frames, instead of a reader being asked to accept an
    // empty `reservations: []` as proof that nothing dispatched.
    //
    // A journal that cannot be opened is a REFUSAL: an arm whose dispatches could
    // not be recorded must not run, because no later step could tell "dispatched
    // nothing" from "lost the record".
    const coverage = ctx.toolDispatchBudget?.coverage;
    if (coverage !== undefined) {
      try {
        await coverage.beginArmRun({
          armRunId: ctx.armRunId,
          arm: arm.armId,
          caseId: arm.caseId,
          repetition: arm.repetition,
          orderIndex: arm.orderIndex,
          campaignDigest: ctx.preregistrationDigest,
        });
      } catch (err) {
        refuse(
          TOOL_DISPATCH_JOURNAL_UNWRITABLE,
          `the durable tool-dispatch journal could not declare coverage for ${ctx.armRunId} (${
            err instanceof Error ? err.message : String(err)
          }) — refusing to run an arm whose tool dispatches could not be recorded`,
        );
      }
    }
    let launched: LaunchArmWorkerResult;
    try {
      launched = await launchArmWorker({
        workerPath,
        env,
        timeoutMs: workerTimeoutMs,
        checkoutDir: armDir,
        caseDef,
        armRunId: ctx.armRunId,
        orderIndex: arm.orderIndex,
        runOptions: {
          modelId: profile.provider.modelId,
          budgetTokens: profile.budgetTokens,
          // The mechanism difference IS the arm: candidate → the pre-registered
          // mechanism, baseline → the champion wiring. Never a CLI flag.
          ...(arm.armId === "candidate" ? { candidate: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2 } : {}),
          armId: arm.armId,
          repetition: arm.repetition + 1,
          attempt: 1,
        },
        provider: ctx.provider,
        // R0/S1 (F1) — the campaign's durable tool budget and its ONE deadline are
        // forwarded from the driver's context. When the driver supplied one, the
        // worker must prove the `tool-budget-rpc-v1` ABI BEFORE any model request
        // and every tool dispatch is reserved and settled against this budget.
        ...(ctx.toolDispatchBudget === undefined ? {} : { toolDispatchBudget: ctx.toolDispatchBudget }),
        ...(ctx.campaignDeadlineAtMs === undefined ? {} : { campaignDeadlineAtMs: ctx.campaignDeadlineAtMs }),
        // N1 (F30-1) — the CALLER-CANCELLATION path. The frozen
        // `PreregisteredArmContext` declares no signal today, so this reads one
        // DEFENSIVELY: a driver that supplies `signal` gets the same finalize as the
        // deadline, and a driver that supplies none is unaffected. It is a narrow,
        // explicit read of an optional field — not a change to the frozen contract
        // (that interface is owned by another task this wave) and not a capability
        // channel: an `AbortSignal` can only STOP work, never grant it.
        ...(() => {
          const supplied = (ctx as { signal?: unknown }).signal;
          return supplied instanceof AbortSignal ? { callerSignal: supplied } : {};
        })(),
      });
    } finally {
      // The arm run is over however it ended (result, refusal, timeout, crash).
      // Closing the coverage is what turns "observed N reserve frames" into a
      // CLOSED fact rather than a run that is still in flight.
      if (coverage !== undefined) {
        try {
          await coverage.closeArmRun(ctx.armRunId);
        } catch (err) {
          process.stderr.write(
            `[degraded] N3 dispatch-journal coverage close failed for ${ctx.armRunId}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }
      }
    }

    // --- 5. independently corroborate the reported build identity ----------
    //
    // N1 (F30-1) — every refusal AFTER the worker ran carries the OBSERVED
    // cancellation record. Plan §4 item 7 requires the abort facts to be readable
    // from the error path, not to live only in a local variable that the throw
    // discards: a caller that gets `ARM_BUILD_PROBE_MISMATCH` can still prove
    // whether the worker's transport was aborted and whether it was classified as
    // a normal completion.
    const report = launched.report;
    const observed = launched.cancellation;
    if (report.armBuildReport === null || report.armBuildReport === undefined) {
      refuse(ARM_BUILD_PROBE_MISMATCH, `the ${arm.armId} worker ran no arm build (no build report was returned)`, observed);
    }
    if (report.armBuildReport.entrySha256 !== entry.sha256) {
      refuse(
        ARM_BUILD_PROBE_MISMATCH,
        `the ${arm.armId} worker loaded a build entry (${report.armBuildReport.entrySha256.slice(0, 12)}…) that is not the pre-flight verified entry (${entry.sha256.slice(0, 12)}…)`,
        observed,
      );
    }
    if (report.armBuildReport.entryRel !== R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"))) {
      refuse(ARM_BUILD_PROBE_MISMATCH, `the ${arm.armId} worker loaded ${report.armBuildReport.entryRel}, not the declared build entry`, observed);
    }
    if (report.outcome === undefined) {
      refuse(ARM_WORKER_FAILED, `the ${arm.armId} worker ran the build but returned no case outcome`, observed);
    }

    return writeArmEvidence({
      arm,
      ctx,
      armBuildDigest,
      armEntrySha256: entry.sha256,
      armProbe: report.armBuildReport.probe,
      workerModelCalls: report.proxyBudget?.modelCalls ?? null,
      evaluated: report.outcome,
    });
  };
}

// ---------------------------------------------------------------------------
// The child-process boundary
// ---------------------------------------------------------------------------

interface LaunchArmWorkerOptions {
  workerPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  checkoutDir: string;
  caseDef: BenchmarkCase;
  runOptions: Record<string, unknown>;
  /** The ONE budget-wrapped provider. The child owns none. */
  provider: ModelProvider;
  /**
   * R0/S1 (F1) — the campaign's ONE durable PRE-DISPATCH tool budget. When it is
   * present this is a FORMAL arm run: the child must prove the
   * `tool-budget-rpc-v1` ABI before any model request, and every tool dispatch
   * the arm makes is reserved and settled HERE, against the same `CostBudget`
   * that enforces `maxToolCalls`.
   */
  toolDispatchBudget?: DurableToolDispatchBudget;
  /** R0/S1 — the campaign's ONE persisted deadline (epoch ms), forwarded so the
   *  arm's orchestrator refuses a tool that would start after it. */
  campaignDeadlineAtMs?: number | null;
  /** R0/S1 — the arm-run identity a reservation must belong to. */
  armRunId: string;
  /**
   * N3 — the schedule's order index for this arm run, when the driver knows it.
   * It travels with every tool-dispatch journal event so the journal can be
   * bound to the SAME scheduled arm the readiness verifier reconciles. `null`
   * means "not proven here", never a substituted 0.
   */
  orderIndex?: number | null;
  /**
   * N1 (F30-1) — the caller's cancellation signal, when it supplied one. It is
   * ONE of the termination triggers and is handled by the same finalize as the
   * deadline and the worker exit: an arm stopped from outside must abort the
   * transport it owns, not merely stop being awaited.
   */
  callerSignal?: AbortSignal | undefined;
}

/**
 * N1 (F30-1) — the ONE classification of why a worker was stopped. The union is
 * closed so an unclassified stop cannot be returned as a silent default, and so
 * a reader can tell a TIMEOUT apart from an early EXIT apart from a clean
 * COMPLETION.
 */
type WorkerTerminationReason =
  | "completed" // the worker wrote its result frame and exited 0
  | "deadline" // the arm exceeded its wall-clock bound
  | "caller_cancelled" // the caller aborted the arm run
  | "worker_exit" // the child exited before writing a result
  | "worker_error" // the child could not be spawned / raised `error`
  | "stdout_eof" // the child's stdout closed with no result frame
  | "result_frame_rejected" // the result sentinel line was not parseable
  | "protocol_violation" // the child broke the ONE-active-request contract
  | "unsupported_abi"; // the arm build declares no tool-budget capability

interface LaunchArmWorkerResult {
  report: WorkerReport;
  /** MEASURED physical provider entries this driver serviced for the child. */
  physicalProviderCalls: number;
  exitCode: number | null;
  /**
   * R0/S2 — what the deadline actually did to the in-flight transport. Recorded
   * as OBSERVED, never as a claim that a remote request was revoked: a provider
   * that ignores its `AbortSignal` leaves `streamSettled: false`.
   *
   * N1 (F30-1) — this record is now produced by ONE idempotent finalize that
   * EVERY termination path converges on (deadline, worker exit, child `error`,
   * stdout EOF, malformed result frame, caller cancellation, normal completion),
   * so it is populated on the non-timeout paths too. Before N1 only the deadline
   * path aborted the transport, so a worker that exited after sending a request
   * left the provider's signal `false` and the remote outcome unrecorded.
   */
  cancellation: {
    timedOut: boolean;
    /** The driver aborted the controller the provider is holding. */
    signalAborted: boolean;
    /** The provider's generator returned within the cleanup grace. */
    streamSettled: boolean;
    /** MEASURED wall-clock ms from the stop being triggered to the driver resuming. */
    cleanupMs: number;
    /**
     * N1 — the single classification of WHY this worker was stopped. Every
     * termination path sets exactly one; `null` is unreachable in a returned
     * result (a result is only returned when a result frame was accepted).
     */
    terminationReason: WorkerTerminationReason;
    /**
     * N1 — the three transport states are reported SEPARATELY and are never
     * collapsed into one another:
     *   `localAbort`             — this driver aborted the controller it owns;
     *   `providerReturned`       — the provider's generator unwound in grace;
     *   `remoteOutcomeUnknown`   — the remote side was never confirmed, so
     *                              nothing may claim the request was revoked.
     */
    localAbort: boolean;
    providerReturned: boolean;
    remoteOutcomeUnknown: boolean;
    /** N1 — model requests REFUSED because one was already in flight. */
    concurrencyRefusals: number;
    /**
     * N1 — how many times a normal frame write was suppressed because the stop
     * had already been triggered (no normal event is ever published post-close).
     */
    framesSuppressedAfterStop: number;
    /** N1 — EPIPE / ERR_STREAM_DESTROYED / `error` events observed on stdin. */
    stdinErrors: number;
    /** The first such stdin error's message, or null. */
    stdinError: string | null;
    /**
     * R0/S2 — frames the driver could NOT deliver because the child had already
     * closed its stdin (or the write raised EPIPE/ERR_STREAM_DESTROYED).
     *
     * Counted rather than swallowed: an end-of-life race is normal, but it must
     * be OBSERVABLE, because a large count means the driver was still talking to
     * a child that had stopped listening and any state it reported is suspect.
     * See the empty-catch audit in `packages/security`.
     */
    frameWritesAfterClose: number;
    /** The first write error seen, or null when none was raised. */
    frameWriteError: string | null;
    /**
     * R0/S2 — settlements the durable budget could not be told about, so an
     * unproven dispatch stays visibly UNSETTLED instead of being silently
     * released. Counted for the same reason as `frameWritesAfterClose`.
     */
    settleNoticesFailed: number;
    /** DETACHED stream rejections absorbed so they cannot become unhandled. */
    detachedStreamRejections: number;
    /** The first such rejection's message, or null. */
    detachedStreamError: string | null;
  };
}

/** R0/S1 — one live reservation the child has been granted but not yet settled. */
interface LiveReservation {
  settle: (outcome: "dispatched" | "not_executed" | "unknown") => Promise<void>;
}

/**
 * Spawn the isolated worker, service every model request it makes with the ONE
 * budget-wrapped provider, and return the single result frame it writes.
 *
 * The child is given a SANITIZED environment (no provider keys), so it cannot
 * open a second, unbudgeted transport even by accident. A child that dies, times
 * out, or writes no result is a stable refusal — never a fabricated outcome.
 */
async function launchArmWorker(opts: LaunchArmWorkerOptions): Promise<LaunchArmWorkerResult> {
  const child = spawn(process.execPath, [opts.workerPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: buildWorkerEnv(opts.env),
    windowsHide: true,
  });
  const reader = createLineReader(child.stdout);
  let physicalProviderCalls = 0;
  /**
   * N3 — THE PARENT LINK. A tool dispatch is a CONSEQUENCE of a model response,
   * and the durable journal must say WHICH request declared the tool call.
   *
   * `modelRequestOrdinal` counts the model requests this driver has actually
   * serviced for this arm run (the same 1-based ordinal
   * `createFormalBudgetedProvider` uses to name the request-journal entry
   * `<armRunId>:r<N>`), and `lastCompletedRequestOrdinal` remembers the most
   * recent request whose terminal `completed` event was FORWARDED to the worker.
   *
   * The worker runs one request at a time and executes the tools of a response
   * before it asks for the next one, so the request that declared a tool call is
   * exactly the last one whose `completed` event reached the child. When no
   * request has completed yet, there is NO provable parent: the journal records
   * `null` and the verifier refuses the binding rather than inventing one.
   */
  let modelRequestOrdinal = 0;
  let lastCompletedRequestOrdinal: number | null = null;
  /** N3 — the parent identity a `tool_reserve` frame is attributed to, or nulls. */
  const parentOf = (): { parentRequestId: string | null; parentAttemptId: number | null } =>
    lastCompletedRequestOrdinal === null
      ? { parentRequestId: null, parentAttemptId: null }
      : {
          parentRequestId: `${opts.armRunId}:r${lastCompletedRequestOrdinal}`,
          // The response the child consumed is the logical request's OBSERVED
          // attempt, which the request journal records as attempt 0 (a physical
          // retry is recorded as its own, higher, attempt id). The verifier
          // requires the named attempt to EXIST in that journal, so a wrong
          // constant here fails closed instead of passing silently.
          parentAttemptId: 0,
        };
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let timedOut = false;
  /**
   * R0/S2 (F2) — THE CONTROLLER HAS AN EXPLICIT OWNER.
   *
   * Before this, each model stream was started with a freshly constructed
   * `new AbortController().signal` whose controller was never kept, so NOTHING in
   * the process could abort it: a worker timeout killed the child while the
   * driver's in-flight `for await` stayed parked on a provider that never yields.
   *
   * The owner is a mutable HOLDER, not a bare `let`: a `let` assigned only in one
   * closure is narrowed to `never` in the others, which is exactly the kind of
   * type-level accident that let the old discard-the-controller pattern look
   * correct.
   *
   * N1 (F30-1) — ONE WORKER, ONE ACTIVE MODEL REQUEST. The protocol already
   * enforced this on the child side (`createProxyProvider` throws
   * `PREREG_WORKER_CONCURRENCY`), so a single slot is the honest shape. What was
   * missing is the PARENT side of the same rule: `serviceModelRequest` used to
   * OVERWRITE `current` unconditionally, so a second request silently discarded
   * the first controller and the first provider stream became uncancellable.
   * The parent now REFUSES the second request instead (see
   * `ARM_WORKER_PROTOCOL_VIOLATION`), and that refusal is itself a termination
   * path. No concurrency was added to dodge the question.
   */
  const streamOwner: { current: { id: number; controller: AbortController } | null } = { current: null };
  /**
   * N1 — whether a model request is CURRENTLY in flight. Distinct from
   * `streamOwner.current !== null` on purpose: the holder is cleared in the
   * stream's own `finally`, which runs a microtask AFTER the terminal `done`
   * frame was written, so a stop triggered in that window must not be read as
   * "abort the stream you already completed".
   */
  let streamActive = false;
  /**
   * N1 — set when a request ended because its provider stream really finished
   * (terminal event delivered, `done` published). `finalize` uses it to keep the
   * plan §4 rule "a normally-completed stream must NOT be reported as cancelled".
   */
  let streamCompleted = false;
  /** Resolves when the currently serviced model stream unwinds (either way). */
  let streamSettled: Promise<void> = Promise.resolve();
  /**
   * N1 — set by `finalize` BEFORE anything is aborted or closed. It is the ONE
   * latch that stops new frames being accepted, stops normal events being
   * written to a dying child, and refuses a late second model request.
   */
  let stopTriggered = false;
  /**
   * N1 — the bounded "the child is gone, stop waiting for more stdout" release.
   * A stop, or a child process that has exited, arms this; when it fires the
   * reader is released so the frame loop can classify the stop instead of waiting
   * on a stdout that may never close. It is the bound that makes "the worker wrote
   * a result and then refused to exit" finite.
   */
  let drainArmed = false;
  const armDrain = (): void => {
    if (drainArmed) return;
    drainArmed = true;
    const t = setTimeout(() => {
      // `release()` ends the reader LOGICALLY: every queued line is still
      // delivered first, so a result frame the child already wrote is never lost.
      reader.release();
    }, WORKER_EXIT_DRAIN_MS);
    t.unref?.();
  };
  /** N1 — the ONE classification of why this worker is being stopped. */
  let terminationReason: WorkerTerminationReason | null = null;
  const cancellation = {
    timedOut: false,
    signalAborted: false,
    streamSettled: true,
    cleanupMs: 0,
    terminationReason: "completed" as WorkerTerminationReason,
    localAbort: false,
    providerReturned: false,
    remoteOutcomeUnknown: false,
    concurrencyRefusals: 0,
    framesSuppressedAfterStop: 0,
    stdinErrors: 0,
    stdinError: null as string | null,
    frameWritesAfterClose: 0,
    frameWriteError: null as string | null,
    settleNoticesFailed: 0,
    detachedStreamRejections: 0,
    detachedStreamError: null as string | null,
  };

  /**
   * N1 (F30-1) — THE ONE IDEMPOTENT FINALIZE.
   *
   * Every termination path — deadline, caller cancellation, worker exit, child
   * `error`, stdout EOF, a malformed result frame, a protocol violation, a normal
   * completion — converges here, in this fixed order:
   *
   *   1. set "no new frames are accepted" (the latch) and record WHY;
   *   2. abort the ACTIVE transport the provider is holding;
   *   3. close the child process THIS task owns (never a batch kill);
   *   4. record the MEASURED cleanup elapsed time.
   *
   * The first caller wins; every later call is a no-op that cannot overwrite the
   * recorded reason or re-run the kill. Before N1 only `deadlineFired` did this,
   * so a worker that exited non-timeout returned `ARM_WORKER_FAILED` with the
   * provider's `AbortSignal` still `false`.
   */
  const finalize = (reason: WorkerTerminationReason): void => {
    if (stopTriggered) return; // idempotent: the first reason is the reason
    stopTriggered = true;
    terminationReason = reason;
    cancellation.terminationReason = reason;
    const startedCleanup = Date.now();
    // 0. RELEASE A PARKED READ. A stop that arrives while the frame loop is
    //    awaiting `reader.next()` must be able to unwind it; without this the
    //    loop would stay parked until the child's stdout closed, which is exactly
    //    the unbounded wait this task removes. No frame is dropped by this: a
    //    line already queued is still delivered by `reader.next()`.
    armDrain();
    // 1. NO NEW FRAMES. Set before the abort so a stream that unwinds on abort
    //    cannot publish a late `event`/`done` frame to a stopped worker.
    // 2. ABORT THE TRANSPORT FIRST — the provider is holding this exact signal.
    //
    // N1 — only when a request is REALLY still in flight. A stream that already
    // delivered its terminal event is not cancelled just because the child chose
    // to exit right after; recording it as aborted would be a false claim, and
    // the plan forbids reporting a normally-completed stream as cancelled.
    if (streamOwner.current !== null && !(streamCompleted && !streamActive)) {
      cancellation.signalAborted = true;
      cancellation.localAbort = true;
      cancellation.streamSettled = false;
      try {
        streamOwner.current.controller.abort();
      } catch (err) {
        // An abort listener that throws must not skip the child kill below.
        cancellation.detachedStreamRejections += 1;
        cancellation.detachedStreamError ??= err instanceof Error ? err.message : String(err);
      }
    }
    // 3. Only then close the child process THIS task owns. Never a batch kill.
    //
    // N1 — ONE documented exception: on `completed` the child has just written
    // its result frame and is exiting on its own. SIGTERMing it there would
    // replace its real exit code with a kill signal and turn every SUCCESSFUL arm
    // into `ARM_WORKER_FAILED`. So the child is NOT killed on `completed`; the
    // bounded exit wait below still guarantees the process cannot outlive the
    // cleanup bound (it escalates to SIGKILL), which is the property that matters.
    // Every non-completion reason is a stop, and a stop closes the child here.
    if (reason !== "completed") {
      try {
        child.kill();
      } catch (err) {
        cancellation.detachedStreamRejections += 1;
        cancellation.detachedStreamError ??= err instanceof Error ? err.message : String(err);
      }
    }
    cancellation.cleanupMs = Date.now() - startedCleanup;
  };

  const deadlineFired = (): void => {
    timedOut = true;
    cancellation.timedOut = true;
    finalize("deadline");
  };
  const timer = setTimeout(deadlineFired, opts.timeoutMs);
  timer.unref?.();

  /**
   * N1 — the caller's cancellation, if it supplied a signal. `{ once: true }` so
   * a second abort cannot re-enter, and the listener is removed on every exit
   * path below so a long-lived caller signal cannot leak this worker.
   */
  const onCallerAbort = (): void => {
    finalize("caller_cancelled");
  };
  if (opts.callerSignal !== undefined) {
    if (opts.callerSignal.aborted) onCallerAbort();
    else opts.callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  /**
   * N1 — the child PROCESS state, observed rather than awaited blindly.
   *
   * The old code built `exited` from `child.on("exit")`/`child.on("error")` and
   * then `await`ed it with no bound, so a child that wrote a result and refused
   * to exit parked the driver forever. Here the events are RECORDED (so they can
   * also drive the termination paths) and every await below races a deadline.
   */
  let processExited = false;
  /** N1 — the child could not be spawned or raised `error` (never ran). */
  let processErrored = false;
  /** N1 — the terminating signal, when the child was signalled rather than exited. */
  let exitSignalName: NodeJS.Signals | null = null;
  let exitCode: number | null = null;
  let exitResolve: (() => void) | null = null;
  const exitSignal = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  /**
   * N1 — the accepted result frame. Declared here: the exit handler reads it.
   *
   * A mutable HOLDER, not two bare `let`s, for the same reason `streamOwner` is
   * one: `handleLine` assigns them from inside a closure, and TypeScript narrows
   * a `let` that only a closure assigns to its initializer at every use site —
   * here that narrowed `sawResult` to `false`, made the "no result" refusal
   * statically unconditional, and turned `report` into `never`. The holder keeps
   * the declared types honest at every read.
   */
  const result: { sawResult: boolean; report: WorkerReport | null } = { sawResult: false, report: null };
  child.on("exit", (code, signal) => {
    processExited = true;
    exitCode = code;
    exitSignalName = signal;
    // N1 — the child is gone, so no further stdout can arrive in a well-behaved
    // case. ARM THE BOUNDED DRAIN rather than finalizing here: `'exit'` can be
    // delivered BEFORE the parent has drained the result frame the child wrote,
    // so classifying immediately would mislabel a SUCCESSFUL run as an early
    // exit. The frame loop stays authoritative — it consumes whatever is buffered
    // and then classifies from the real evidence (`result.sawResult`), within the
    // drain bound.
    armDrain();
    exitResolve?.();
  });
  child.on("error", () => {
    processExited = true;
    processErrored = true;
    if (exitCode === null) exitCode = null;
    armDrain();
    exitResolve?.();
  });
  /**
   * N1 (F30-1) — stdin has an ASYNC error channel that a synchronous try/catch
   * around `write()` cannot see: an EPIPE arrives as an `'error'` EVENT on the
   * stream, and an unhandled one would tear the driver process down. It is
   * recorded (never an empty catch) and counts as an observed end-of-life race.
   */
  child.stdin?.on("error", (err: Error) => {
    cancellation.stdinErrors += 1;
    cancellation.stdinError ??= err instanceof Error ? err.message : String(err);
    cancellation.frameWritesAfterClose += 1;
    cancellation.frameWriteError ??= cancellation.stdinError;
  });

  // R0/S1 (F1) — the child is told whether the FORMAL budget RPC is in play. The
  // flag is a TRANSPORT instruction; the capability itself is exported over the
  // RPC and never serialized.
  const wantsBudgetRpc = opts.toolDispatchBudget !== undefined;
  const runOptions = wantsBudgetRpc ? { ...opts.runOptions, toolBudgetRpc: true } : opts.runOptions;

  // R0/S1 — the reservations the child currently holds, keyed by the reservation
  // id THIS driver minted. A settle naming an unknown id is refused; a duplicate
  // settle is acknowledged without settling twice.
  const liveReservations = new Map<string, LiveReservation>();
  const settledReservations = new Set<string>();
  let reservationSeq = 0;
  /** R0/S1 — set when the child's declared ABI cannot honour the formal path. */
  let abiRefusal: string | null = null;
  /** R0/S1 — MEASURED reservations this driver granted / refused. */
  const budgetCounters = { granted: 0, refused: 0, settled: 0, unknownSettle: 0 };

  // Kick the child off with its single options line. `armRunId` is carried at the
  // TOP level (not inside `runOptions`, whose `armId` is the baseline/candidate
  // label) so a reservation can be bound to the arm RUN it belongs to.
  child.stdin?.write(
    `${JSON.stringify({ checkoutDir: opts.checkoutDir, case: opts.caseDef, runOptions, armRunId: opts.armRunId })}\n`,
  );

  const reply = (frame: Record<string, unknown>): void => {
    // A post-cancellation write must never raise: the child may already be gone
    // (EPIPE / ERR_STREAM_DESTROYED), and that is a normal end-of-life race.
    //
    // R0/S2 — this is NOT a silent swallow. The occurrence is COUNTED and
    // surfaced on the cancellation record, so "the child stopped accepting
    // frames" is an observed fact rather than an invisible one. The child's exit
    // still classifies the arm; this only makes the race reportable.
    //
    // N1 (F30-1) — the stop latch is checked FIRST: after a stop no normal frame
    // (an `event`, a `done`, a `proceed`, a `tool_grant`) may be published to a
    // worker the driver has already declared dead. Only the `abort` refusal frame
    // is allowed past, because that one is the driver TELLING the child to stop.
    if (stopTriggered && frame["t"] !== "abort") {
      cancellation.framesSuppressedAfterStop += 1;
      return;
    }
    if (child.stdin === null || child.stdin.destroyed || !child.stdin.writable) {
      cancellation.frameWritesAfterClose += 1;
      return;
    }
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (err) {
      cancellation.frameWritesAfterClose += 1;
      cancellation.frameWriteError = err instanceof Error ? err.message : String(err);
    }
  };

  /**
   * R0/S2 — service ONE model request DETACHED. The old code awaited the whole
   * provider stream inline, which parked the frame loop inside a generator that
   * never ends; the deadline timer could then fire but the driver could never
   * return. The loop below now stays responsive while the stream runs.
   *
   * N1 (F30-1) — ONE ACTIVE REQUEST PER WORKER, ENFORCED HERE.
   *
   * The child-side proxy already refuses a concurrent `generate()` (see
   * `createProxyProvider`'s `PREREG_WORKER_CONCURRENCY`), so the protocol's real
   * arity is ONE. The parent half of that rule was missing: the old body
   * assigned `streamOwner.current` unconditionally, so a second request replaced
   * the live controller and the FIRST provider stream could never be aborted —
   * it stayed parked on a provider that never yields, which is exactly the F30-1
   * class of leak. The parent now REFUSES the second request as a PROTOCOL
   * VIOLATION and finalizes, so the first controller is never lost and no
   * uncancellable stream is created. Returning `false` lets the frame loop treat
   * the refusal as a termination path.
   */
  const serviceModelRequest = (id: number, request: unknown): boolean => {
    if (stopTriggered) {
      // The stop already happened: a request arriving now is refused, never
      // started, so no new transport can be opened on a dead worker.
      cancellation.concurrencyRefusals += 1;
      return false;
    }
    if (streamOwner.current !== null) {
      // ONE slot. Refusing beats clobbering: the live controller is the ONLY
      // handle to the in-flight provider stream, and overwriting it would strand
      // that stream uncancellable for the rest of the process's life.
      cancellation.concurrencyRefusals += 1;
      return false;
    }
    const controller = new AbortController();
    streamOwner.current = { id, controller };
    streamActive = true;
    physicalProviderCalls += 1;
    // N3 — this serviced request's 1-based ordinal for THIS arm run. It is the
    // `<N>` of the request-journal name `<armRunId>:r<N>` the budgeted provider
    // mints for the very same call, and it is the number the tool-dispatch
    // journal resolves a tool call's parent request from.
    modelRequestOrdinal += 1;
    const ordinal = modelRequestOrdinal;
    const run = (async (): Promise<void> => {
      try {
        const client = opts.provider.createClient({ id: runOptions["modelId"] as string } as never, {} as never);
        for await (const event of client.generate(request as never, controller.signal)) {
          if (stopTriggered) {
            // N1 — a normal frame the driver WITHHELD because the stop already
            // happened. Counted here rather than only inside `reply()`, because
            // this is where the suppression actually occurs: the loop breaks
            // before it would ever have called `reply`.
            cancellation.framesSuppressedAfterStop += 1;
            break;
          }
          reply({ t: "event", id, event });
          if ((event as ModelEvent).type === "completed" || (event as ModelEvent).type === "error") {
            // N3 — the worker only receives this frame if `reply` published it
            // (a suppressed frame is not delivered), so this is exactly "the
            // response that declared the arm's tool calls reached the child".
            if ((event as ModelEvent).type === "completed") lastCompletedRequestOrdinal = ordinal;
            break;
          }
        }
        if (!stopTriggered) reply({ t: "done", id });
        else cancellation.framesSuppressedAfterStop += 1;
        // N1 — the request genuinely ENDED: its events were published and its
        // terminal `done` (or the provider's own terminal event) was delivered.
        // This is what `finalize` reads to decide whether an abort is still owed,
        // so a stream that finished normally is NOT reported as cancelled.
        streamCompleted = true;
      } catch (err) {
        // The run body reports its own failure to the child, but only while the
        // worker is still live: a post-stop write must not be published.
        if (!stopTriggered) reply({ t: "error", id, message: err instanceof Error ? err.message : String(err) });
      } finally {
        // N1 — the slot is released HERE, in the stream's own `finally`, so it is
        // released on every outcome: normal completion, provider error, or abort.
        // Before N1 the slot was never released at all, which is why a second
        // request could silently take it over mid-flight.
        if (streamOwner.current !== null && streamOwner.current.controller === controller) {
          streamOwner.current = null;
          streamActive = false;
        }
      }
    })();
    streamSettled = run;
    // R0/S2 — the run body already reports its own failures to the child
    // (L1198-1200). This trailing handler exists ONLY so a rejected DETACHED
    // promise can never become an unhandled rejection that tears the driver
    // down mid-arm. It records the fact instead of discarding it: an empty
    // handler here is what the `packages/security` empty-catch audit forbids,
    // and rightly so — an unobserved rejection is exactly the kind of thing
    // that later looks like a driver crash with no explanation.
    void run.then(
      () => undefined,
      (err: unknown) => {
        cancellation.detachedStreamRejections += 1;
        cancellation.detachedStreamError = err instanceof Error ? err.message : String(err);
      },
    );
    return true;
  };

  /**
   * N1 — handle ONE line from the child. Returns `false` when the frame loop must
   * STOP (result accepted, malformed result, or a terminal protocol violation).
   *
   * This is the old loop body with its routing rules unchanged; extracting it is
   * what lets the loop race the bounded drain signal without duplicating the
   * router.
   */
  const handleLine = async (line: string): Promise<boolean> => {
    if (line.startsWith(ARM_WORKER_RESULT_SENTINEL)) {
      const parsed = ((): WorkerReport | null => {
        try {
          return JSON.parse(line.slice(ARM_WORKER_RESULT_SENTINEL.length)) as WorkerReport;
        } catch {
          // N1 — a malformed result frame is a CLASSIFIED termination, not a
          // silent `sawResult = true` followed by a confusing downstream crash
          // when the unparsed report is dereferenced.
          return null;
        }
      })();
      if (parsed === null) {
        finalize("result_frame_rejected");
        return false;
      }
      result.sawResult = true;
      result.report = parsed;
      return false;
    }
    let frame: { t?: string; id?: number; request?: unknown; [k: string]: unknown };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return true; // a non-frame line is ignored
    }
    if (typeof frame.id !== "number") return true;

    // --- R0/S1: the ABI capability handshake, BEFORE any arm code runs ----
    if (frame.t === "hello") {
      const abi = Array.isArray(frame["abi"]) ? (frame["abi"] as unknown[]).filter((c): c is string => typeof c === "string") : [];
      if (!wantsBudgetRpc) {
        // A child that opens a handshake the driver did not ask for is not a
        // protocol this driver speaks.
        reply({ t: "abort", id: frame.id, reason: "this driver did not request the budget ABI handshake" });
        return true;
      }
      if (!abi.includes(R97_ARM_ABI_TOOL_BUDGET)) {
        abiRefusal =
          `the ${opts.armRunId} arm build declares no ${R97_ARM_ABI_TOOL_BUDGET} capability (declared: [${abi.join(", ") || "none"}]) — ` +
          `the formal pre-registered path must refuse an arm that cannot honour the campaign's durable tool budget, rather than run it with maxToolCalls unenforced`;
        reply({ t: "abort", id: frame.id, reason: abiRefusal });
        return true;
      }
      reply({ t: "proceed", id: frame.id });
      return true;
    }

    // --- R0/S1: the tool-dispatch budget RPC -----------------------------
    if (frame.t === "tool_reserve") {
      if (opts.toolDispatchBudget === undefined) {
        reply({ t: "tool_error", id: frame.id, message: "no tool-dispatch budget is wired for this arm run" });
        return true;
      }
      if (frame["armRunId"] !== opts.armRunId) {
        // An old worker's message must not spend a new arm's quota.
        reply({
          t: "tool_error",
          id: frame.id,
          message: `reservation for ${String(frame["armRunId"])} cannot be charged to ${opts.armRunId}`,
        });
        return true;
      }
      const reservationId = `${opts.armRunId}:tool:${++reservationSeq}`;
      // N3 — the TOOL-side reservation id, the schedule order index and the
      // parent model request/attempt travel WITH the reservation, so the durable
      // journal can bind this dispatch to the arm run, the case and the very
      // model request that declared it. The tool id is minted HERE and is
      // deliberately NOT the model's quota id: the two are different identifiers
      // in different namespaces and are never compared for equality.
      const granted = await opts.toolDispatchBudget.reserve(frame.request as never, {
        toolReservationId: reservationId,
        orderIndex: opts.orderIndex ?? null,
        ...parentOf(),
      });
      if (!granted.ok) {
        budgetCounters.refused += 1;
        reply({ t: "tool_grant", id: frame.id, ok: false, reason: granted.reason ?? "TOOL_BUDGET_EXHAUSTED" });
        return true;
      }
      budgetCounters.granted += 1;
      liveReservations.set(reservationId, { settle: granted.settle });
      reply({ t: "tool_grant", id: frame.id, ok: true, reservationId });
      return true;
    }

    if (frame.t === "tool_settle") {
      const reservationId = String(frame["reservationId"]);
      const outcome = frame["outcome"];
      if (outcome !== "dispatched" && outcome !== "not_executed" && outcome !== "unknown") {
        reply({ t: "tool_error", id: frame.id, message: `unknown settlement outcome ${String(outcome)}` });
        return true;
      }
      if (settledReservations.has(reservationId)) {
        // Idempotent: a duplicate settle is acknowledged, never charged twice.
        reply({ t: "tool_settled", id: frame.id, duplicate: true });
        return true;
      }
      const live = liveReservations.get(reservationId);
      if (live === undefined) {
        budgetCounters.unknownSettle += 1;
        reply({ t: "tool_error", id: frame.id, message: `no live reservation ${reservationId} belongs to ${opts.armRunId}` });
        return true;
      }
      liveReservations.delete(reservationId);
      settledReservations.add(reservationId);
      budgetCounters.settled += 1;
      await live.settle(outcome);
      reply({ t: "tool_settled", id: frame.id });
      return true;
    }

    // --- R0/S2: the child cancelled an in-flight model request ------------
    if (frame.t === "cancel") {
      // The arm build stopped waiting. Abort THIS request's transport (not
      // somebody else's) and keep the loop responsive.
      if (streamOwner.current !== null && streamOwner.current.id === frame.id) {
        cancellation.signalAborted = true;
        cancellation.localAbort = true;
        streamOwner.current.controller.abort();
      }
      return true;
    }

    if (frame.t !== "request") return true;
    if (!serviceModelRequest(frame.id, frame.request)) {
      // N1 — the ONE-active-request contract was broken (or the worker asked
      // after its own stop). That is a terminal protocol violation: continuing
      // would leave an uncancellable stream behind, so the arm is stopped and
      // classified instead.
      finalize("protocol_violation");
      return false;
    }
    return true;
  };

  try {
    for (;;) {
      // N1 (F30-1) — the read is BOUNDED. `reader.next()` alone parks until the
      // child writes or its stdout closes, so a child that exits (or is stopped)
      // while its pipe stays open would park the driver forever. `armDrain()`
      // releases the reader logically after the drain bound, so `next()` returns
      // `null` and the loop reaches its classification. No frame is lost: every
      // line already queued is delivered before the release takes effect.
      const line = await reader.next();
      if (line === null) break;
      if (!(await handleLine(line))) break;
    }
  } finally {
    clearTimeout(timer);
    if (opts.callerSignal !== undefined) opts.callerSignal.removeEventListener("abort", onCallerAbort);
  }

  // N1 (F30-1) — EVERY path that leaves the frame loop finalizes here, not just
  // the timeout. Reaching this point with `stopTriggered` still false means the
  // loop ended because the child's stdout ended (or its process did), so the
  // transport is aborted and the child is closed exactly once, before anything is
  // classified. This is the line the old implementation was missing: it cleared
  // the timer and returned `ARM_WORKER_FAILED` while the provider's signal was
  // still `false`.
  //
  // The reason is taken from the REAL evidence, in this order: a result frame was
  // accepted (`completed`), the child could not be spawned (`worker_error`), the
  // child exited without a result (`worker_exit`), otherwise its stdout simply
  // ended (`stdout_eof`).
  //
  // The stdout 'end' event and the process 'exit' event are SEPARATE signals that
  // race, and 'end' usually wins. Waiting a bounded moment for the exit evidence
  // is what keeps a plain `exit(2)` classified as `worker_exit` instead of the
  // weaker `stdout_eof`; it cannot hang, and it costs nothing when the exit event
  // already arrived.
  if (!stopTriggered && !result.sawResult && !processExited) {
    await Promise.race([
      exitSignal,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250);
        t.unref?.();
      }),
    ]);
  }
  if (!stopTriggered) {
    finalize(
      result.sawResult
        ? "completed"
        : processErrored
          ? "worker_error"
          : processExited
            ? "worker_exit"
            : "stdout_eof",
    );
  }

  // R0/S2 — STOP WAITING even when the provider ignores its AbortSignal. The
  // grace is bounded and explicit; reaching it records `streamSettled: false`
  // (unconfirmed), and never claims the remote request was revoked.
  //
  // N1 — this now runs whenever a transport was aborted, not only on the timeout:
  // a worker that exited mid-request deserves the same bounded unwind.
  if (cancellation.localAbort) {
    const grace = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, WORKER_CLEANUP_GRACE_MS);
      t.unref?.();
    });
    await Promise.race([
      streamSettled.then(
        () => undefined,
        (err: unknown) => {
          // Reaching here is expected after an abort (the abort rejects the
          // in-flight generate). Record it so it is not an unobserved rejection.
          cancellation.detachedStreamRejections += 1;
          cancellation.detachedStreamError ??= err instanceof Error ? err.message : String(err);
        },
      ),
      grace,
    ]);
    cancellation.providerReturned = await Promise.race([
      streamSettled.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 0);
        t.unref?.();
      }),
    ]);
    cancellation.streamSettled = cancellation.providerReturned;
    // N1 — the three states stay DISTINCT and are never collapsed: a local abort
    // that the provider ignored means the remote outcome is UNKNOWN, and nothing
    // downstream may read that as "the request was revoked".
    cancellation.remoteOutcomeUnknown = !cancellation.providerReturned;
  }

  // The child owns its own stdin; close it, then take the exit code.
  //
  // R0/S2 — the guard above already establishes non-null/writable, but the child
  // can die between the check and the write, so the throw is real. It is NOT
  // discarded: an EPIPE here is the same end-of-life race `reply()` counts, and
  // folding it into the same counter keeps one number for "the child stopped
  // listening" regardless of which call site observed it.
  try {
    child.stdin?.end();
  } catch (err) {
    cancellation.frameWritesAfterClose += 1;
    cancellation.frameWriteError ??= err instanceof Error ? err.message : String(err);
  }

  /**
   * N1 (F30-1) — BOUNDED WAIT FOR THE CHILD PROCESS.
   *
   * `exited` used to be awaited with no bound, so a child that wrote a result
   * frame and then refused to exit parked the driver forever (acceptance row:
   * "result frame then child will not exit"). The wait is now: whatever is left
   * of the cleanup grace, then ONE hard kill, then a second bounded look. The
   * result is a measured `exitCode: null` — explicitly classified, never an
   * unbounded await.
   */
  const exitWaitMs = processExited ? 0 : WORKER_EXIT_GRACE_MS;
  let exitWaitExpired = false;
  if (!processExited) {
    const waitStarted = Date.now();
    await Promise.race([
      exitSignal,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, exitWaitMs);
        t.unref?.();
      }),
    ]);
    if (!processExited) {
      // The child is not cooperating. SIGKILL, then ONE more bounded look so a
      // normally-killable process still reports its real code.
      exitWaitExpired = true;
      try {
        child.kill("SIGKILL");
      } catch (err) {
        cancellation.detachedStreamRejections += 1;
        cancellation.detachedStreamError ??= err instanceof Error ? err.message : String(err);
      }
      await Promise.race([
        exitSignal,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, WORKER_EXIT_GRACE_MS);
          t.unref?.();
        }),
      ]);
    }
    cancellation.cleanupMs += Date.now() - waitStarted;
  }

  // A reservation the child never settled is NOT refunded here: the durable
  // budget's own conservative rule decides, and an unproven dispatch must stay
  // visible as unsettled rather than be silently released.
  //
  // N1 — the ID and the bound are preserved exactly: this path settles the
  // ORIGINAL reservation id as `unknown` (local abort vs provider returned vs
  // remote outcome unknown are reported separately above), it never re-mints an
  // id and never disguises the settle as "no dispatch happened".
  if (liveReservations.size > 0) {
    for (const [reservationId, live] of liveReservations) {
      liveReservations.delete(reservationId);
      settledReservations.add(reservationId);
      budgetCounters.settled += 1;
      // R0/S2 — the budget could not be told this dispatch settled. That is
      // exactly the "unproven dispatch" case this branch exists to keep visible,
      // so the failure is COUNTED (`settleNoticesFailed`) rather than swallowed:
      // a nonzero count is the signal that the journal holds a reservation whose
      // fate is unknown, and a reader must be able to see that instead of
      // inferring it from a missing entry.
      try {
        await live.settle("unknown");
      } catch (err) {
        cancellation.settleNoticesFailed += 1;
        cancellation.frameWriteError ??= err instanceof Error ? err.message : String(err);
      }
    }
  }

  // R0/S1 — an arm refused by the capability pre-check reports the CAPABILITY
  // reason, never a downstream timeout or a missing result.
  if (abiRefusal !== null) {
    refuse(
      ARM_WORKER_ABI_UNSUPPORTED,
      `${abiRefusal} (termination=${cancellation.terminationReason}, signalAborted=${String(cancellation.signalAborted)})`,
      cancellation,
    );
  }
  if (terminationReason === "protocol_violation") {
    refuse(
      ARM_WORKER_PROTOCOL_VIOLATION,
      `the arm worker opened a SECOND concurrent model request while one was already in flight (refusals=${cancellation.concurrencyRefusals}); ` +
        `this driver services ONE active request per worker, so the arm was stopped rather than let the first controller be lost ` +
        `(termination=${cancellation.terminationReason}, signalAborted=${String(cancellation.signalAborted)}, ` +
        `providerReturnedWithinGrace=${String(cancellation.providerReturned)})`,
      cancellation,
    );
  }
  if (timedOut) {
    refuse(
      ARM_WORKER_TIMEOUT,
      `the arm worker exceeded its ${opts.timeoutMs} ms bound; the transport was aborted first ` +
        `(signalAborted=${String(cancellation.signalAborted)}, providerReturnedWithinGrace=${String(cancellation.streamSettled)}) ` +
        `and the worker this task owns was then killed. A provider that did not return leaves the remote request UNCONFIRMED, not revoked`,
      cancellation,
    );
  }
  if (!result.sawResult || result.report === null) {
    refuse(
      ARM_WORKER_FAILED,
      `the arm worker produced no result (exit=${exitCode ?? "unreadable"}, termination=${cancellation.terminationReason}, ` +
        `signalAborted=${String(cancellation.signalAborted)}, cleanupMs=${cancellation.cleanupMs})` +
        `${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, 200)}`}`,
      cancellation,
    );
  }
  if (!result.report.ok) {
    refuse(
      result.report.code ?? ARM_WORKER_FAILED,
      `the arm worker refused: ${result.report.error ?? "unknown error"}`,
      cancellation,
    );
  }
  if (exitCode !== 0) {
    refuse(
      ARM_WORKER_FAILED,
      `the arm worker reported a result but exited ${exitCode}${exitWaitExpired ? " (it did not exit within the cleanup bound and was killed)" : ""}`,
      cancellation,
    );
  }
  return { report: result.report, physicalProviderCalls, exitCode, cancellation };
}

/**
 * Derive the declared evidence from the REAL outcome and persist the raw bytes
 * it references. The manifest is the trace: its sha256 IS `traceDigest`, so a
 * digest with no matching manifest cannot be re-produced.
 */
async function writeArmEvidence(input: {
  arm: PreregisteredArmContext["arm"];
  ctx: PreregisteredArmContext;
  armBuildDigest: string;
  armEntrySha256: string;
  armProbe: string;
  workerModelCalls: number | null;
  evaluated: EvalOutcome;
}): Promise<PreregisteredArmOutcome> {
  const { arm, ctx, armBuildDigest, armEntrySha256, armProbe, workerModelCalls, evaluated } = input;
  const status: PreregisteredArmOutcome["status"] =
    evaluated.status === "error" ? "error" : evaluated.status === "passed" ? "passed" : "failed";
  const tokensUsed = evaluated.metrics.tokens_input + evaluated.metrics.tokens_output;

  // An error outcome carries NO verifier verdict (there was nothing verified to
  // report) — its evidence is absent, and the aggregate excludes it from the pair.
  if (status === "error") {
    return {
      status,
      ...(evaluated.failureCategory !== undefined ? { failureCategory: evaluated.failureCategory } : {}),
      tokensUsed,
      reason: evaluated.reason ?? "the harness reported an infrastructure-level failure",
    };
  }

  const verifiedCompletion = evaluated.status === "passed";
  const securityViolations = evaluated.violations.length;

  const manifestText = `${stableStringify({
    schemaVersion: PREREG_RUN_MANIFEST_SCHEMA,
    executorId: PREREG_ARM_EXECUTOR_ID,
    preregistrationDigest: ctx.preregistrationDigest,
    planDigest: ctx.planDigest,
    armRunId: ctx.armRunId,
    armId: arm.armId,
    caseId: arm.caseId,
    repetition: arm.repetition,
    orderIndex: arm.orderIndex,
    armBuildDigest,
    // B3 — the identity of the arm build that ACTUALLY ran in the child.
    armEntrySha256,
    armProbe,
  })}\n`;
  const traceDigest = sha256Hex(manifestText);

  const verifierText = `${stableStringify({
    schemaVersion: PREREG_RUN_VERIFIER_SCHEMA,
    verifiedCompletion,
    status: evaluated.status,
    grade: evaluated.grade ?? null,
    violations: evaluated.violations,
  })}\n`;
  const securityText = `${stableStringify({
    schemaVersion: PREREG_RUN_SECURITY_SCHEMA,
    violations: securityViolations,
  })}\n`;

  // Activation evidence exists IFF the candidate arm really observed the
  // mechanism activation; a baseline run never carries one (that would be
  // CONTAMINATION, which the aggregate detects).
  let activationText: string | null = null;
  if (arm.armId === "candidate" && evaluated.activationEvidenceV2 !== undefined && evaluated.activationEvidenceV2.events.length > 0) {
    activationText = `${stableStringify({
      schemaVersion: PREREG_RUN_ACTIVATION_SCHEMA,
      caseId: arm.caseId,
      armId: arm.armId,
      repetition: arm.repetition,
      orderIndex: arm.orderIndex,
      events: evaluated.activationEvidenceV2.events,
    })}\n`;
  }

  await mkdir(ctx.evidenceDir, { recursive: true });
  await writeFile(join(ctx.evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.manifest), manifestText, "utf8");
  await writeFile(join(ctx.evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.verifier), verifierText, "utf8");
  await writeFile(join(ctx.evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.security), securityText, "utf8");
  if (activationText !== null) {
    await writeFile(join(ctx.evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.activation), activationText, "utf8");
  }

  const evidence: PreregisteredArmEvidence = {
    executorId: PREREG_ARM_EXECUTOR_ID,
    traceDigest,
    verifiedCompletion,
    securityViolations,
    activationEvidenceDigest: activationText === null ? null : sha256Hex(activationText),
  };

  return {
    status,
    ...(evaluated.failureCategory !== undefined ? { failureCategory: evaluated.failureCategory } : {}),
    tokensUsed,
    reason: `harness: verified=${verifiedCompletion} violations=${securityViolations} termination=${evaluated.terminationReason ?? "unknown"} arm=${armBuildDigest.slice(0, 12)} probe=${armProbe} workerCalls=${workerModelCalls ?? "unknown"}`,
    evidence,
  };
}
