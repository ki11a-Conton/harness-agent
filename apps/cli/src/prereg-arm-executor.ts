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

function refuse(code: string, message: string): never {
  const err = new Error(`${code}: ${message}`);
  (err as { code?: string }).code = code;
  throw err;
}

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

/** A line-delimited reader over a child stream that never loses a frame. */
function createLineReader(stream: NodeJS.ReadableStream): { next: () => Promise<string | null> } {
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

    const launched = await launchArmWorker({
      workerPath,
      env,
      timeoutMs: workerTimeoutMs,
      checkoutDir: armDir,
      caseDef,
      armRunId: ctx.armRunId,
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
    });

    // --- 5. independently corroborate the reported build identity ----------
    const report = launched.report;
    if (report.armBuildReport === null || report.armBuildReport === undefined) {
      refuse(ARM_BUILD_PROBE_MISMATCH, `the ${arm.armId} worker ran no arm build (no build report was returned)`);
    }
    if (report.armBuildReport.entrySha256 !== entry.sha256) {
      refuse(
        ARM_BUILD_PROBE_MISMATCH,
        `the ${arm.armId} worker loaded a build entry (${report.armBuildReport.entrySha256.slice(0, 12)}…) that is not the pre-flight verified entry (${entry.sha256.slice(0, 12)}…)`,
      );
    }
    if (report.armBuildReport.entryRel !== R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"))) {
      refuse(ARM_BUILD_PROBE_MISMATCH, `the ${arm.armId} worker loaded ${report.armBuildReport.entryRel}, not the declared build entry`);
    }
    if (report.outcome === undefined) {
      refuse(ARM_WORKER_FAILED, `the ${arm.armId} worker ran the build but returned no case outcome`);
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
}

interface LaunchArmWorkerResult {
  report: WorkerReport;
  /** MEASURED physical provider entries this driver serviced for the child. */
  physicalProviderCalls: number;
  exitCode: number | null;
  /**
   * R0/S2 — what the deadline actually did to the in-flight transport. Recorded
   * as OBSERVED, never as a claim that a remote request was revoked: a provider
   * that ignores its `AbortSignal` leaves `streamSettled: false`.
   */
  cancellation: {
    timedOut: boolean;
    /** The driver aborted the controller the provider is holding. */
    signalAborted: boolean;
    /** The provider's generator returned within the cleanup grace. */
    streamSettled: boolean;
    /** MEASURED wall-clock ms from the deadline firing to the driver resuming. */
    cleanupMs: number;
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
   */
  const streamOwner: { current: { id: number; controller: AbortController } | null } = { current: null };
  /** Resolves when the currently serviced model stream unwinds (either way). */
  let streamSettled: Promise<void> = Promise.resolve();
  const cancellation = { timedOut: false, signalAborted: false, streamSettled: true, cleanupMs: 0 };

  const deadlineFired = (): void => {
    timedOut = true;
    cancellation.timedOut = true;
    const startedCleanup = Date.now();
    // 1. ABORT THE TRANSPORT FIRST — the provider is holding this exact signal.
    if (streamOwner.current !== null) {
      cancellation.signalAborted = true;
      cancellation.streamSettled = false;
      streamOwner.current.controller.abort();
    }
    // 2. Only then close the child process THIS task owns. Never a batch kill.
    child.kill();
    cancellation.cleanupMs = Date.now() - startedCleanup;
  };
  const timer = setTimeout(deadlineFired, opts.timeoutMs);
  timer.unref?.();

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
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
    if (child.stdin === null || child.stdin.destroyed || !child.stdin.writable) return;
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // The child's exit is what classifies the arm, not this write.
    }
  };

  /**
   * R0/S2 — service ONE model request DETACHED. The old code awaited the whole
   * provider stream inline, which parked the frame loop inside a generator that
   * never ends; the deadline timer could then fire but the driver could never
   * return. The loop below now stays responsive while the stream runs.
   */
  const serviceModelRequest = (id: number, request: unknown): void => {
    const controller = new AbortController();
    streamOwner.current = { id, controller };
    physicalProviderCalls += 1;
    const run = (async (): Promise<void> => {
      try {
        const client = opts.provider.createClient({ id: runOptions["modelId"] as string } as never, {} as never);
        for await (const event of client.generate(request as never, controller.signal)) {
          if (timedOut) break; // no event is published after the deadline
          reply({ t: "event", id, event });
          if ((event as ModelEvent).type === "completed" || (event as ModelEvent).type === "error") break;
        }
        if (!timedOut) reply({ t: "done", id });
      } catch (err) {
        if (!timedOut) reply({ t: "error", id, message: err instanceof Error ? err.message : String(err) });
      }
    })();
    streamSettled = run;
    void run.catch(() => undefined);
  };

  let report: WorkerReport | null = null;
  let sawResult = false;
  try {
    for (;;) {
      const line = await reader.next();
      if (line === null) break;
      if (line.startsWith(ARM_WORKER_RESULT_SENTINEL)) {
        sawResult = true;
        report = JSON.parse(line.slice(ARM_WORKER_RESULT_SENTINEL.length)) as WorkerReport;
        break;
      }
      let frame: { t?: string; id?: number; request?: unknown; [k: string]: unknown };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        continue; // a non-frame line is ignored
      }
      if (typeof frame.id !== "number") continue;

      // --- R0/S1: the ABI capability handshake, BEFORE any arm code runs ----
      if (frame.t === "hello") {
        const abi = Array.isArray(frame["abi"]) ? (frame["abi"] as unknown[]).filter((c): c is string => typeof c === "string") : [];
        if (!wantsBudgetRpc) {
          // A child that opens a handshake the driver did not ask for is not a
          // protocol this driver speaks.
          reply({ t: "abort", id: frame.id, reason: "this driver did not request the budget ABI handshake" });
          continue;
        }
        if (!abi.includes(R97_ARM_ABI_TOOL_BUDGET)) {
          abiRefusal =
            `the ${opts.armRunId} arm build declares no ${R97_ARM_ABI_TOOL_BUDGET} capability (declared: [${abi.join(", ") || "none"}]) — ` +
            `the formal pre-registered path must refuse an arm that cannot honour the campaign's durable tool budget, rather than run it with maxToolCalls unenforced`;
          reply({ t: "abort", id: frame.id, reason: abiRefusal });
          continue;
        }
        reply({ t: "proceed", id: frame.id });
        continue;
      }

      // --- R0/S1: the tool-dispatch budget RPC -----------------------------
      if (frame.t === "tool_reserve") {
        if (opts.toolDispatchBudget === undefined) {
          reply({ t: "tool_error", id: frame.id, message: "no tool-dispatch budget is wired for this arm run" });
          continue;
        }
        if (frame["armRunId"] !== opts.armRunId) {
          // An old worker's message must not spend a new arm's quota.
          reply({
            t: "tool_error",
            id: frame.id,
            message: `reservation for ${String(frame["armRunId"])} cannot be charged to ${opts.armRunId}`,
          });
          continue;
        }
        const reservationId = `${opts.armRunId}:tool:${++reservationSeq}`;
        const granted = await opts.toolDispatchBudget.reserve(frame.request as never);
        if (!granted.ok) {
          budgetCounters.refused += 1;
          reply({ t: "tool_grant", id: frame.id, ok: false, reason: granted.reason ?? "TOOL_BUDGET_EXHAUSTED" });
          continue;
        }
        budgetCounters.granted += 1;
        liveReservations.set(reservationId, { settle: granted.settle });
        reply({ t: "tool_grant", id: frame.id, ok: true, reservationId });
        continue;
      }

      if (frame.t === "tool_settle") {
        const reservationId = String(frame["reservationId"]);
        const outcome = frame["outcome"];
        if (outcome !== "dispatched" && outcome !== "not_executed" && outcome !== "unknown") {
          reply({ t: "tool_error", id: frame.id, message: `unknown settlement outcome ${String(outcome)}` });
          continue;
        }
        if (settledReservations.has(reservationId)) {
          // Idempotent: a duplicate settle is acknowledged, never charged twice.
          reply({ t: "tool_settled", id: frame.id, duplicate: true });
          continue;
        }
        const live = liveReservations.get(reservationId);
        if (live === undefined) {
          budgetCounters.unknownSettle += 1;
          reply({ t: "tool_error", id: frame.id, message: `no live reservation ${reservationId} belongs to ${opts.armRunId}` });
          continue;
        }
        liveReservations.delete(reservationId);
        settledReservations.add(reservationId);
        budgetCounters.settled += 1;
        await live.settle(outcome);
        reply({ t: "tool_settled", id: frame.id });
        continue;
      }

      // --- R0/S2: the child cancelled an in-flight model request ------------
      if (frame.t === "cancel") {
        // The arm build stopped waiting. Abort THIS request's transport (not
        // somebody else's) and keep the loop responsive.
        if (streamOwner.current !== null && streamOwner.current.id === frame.id) {
          cancellation.signalAborted = true;
          streamOwner.current.controller.abort();
        }
        continue;
      }

      if (frame.t !== "request") continue;
      serviceModelRequest(frame.id, frame.request);
    }
  } finally {
    clearTimeout(timer);
  }

  // R0/S2 — STOP WAITING even when the provider ignores its AbortSignal. The
  // grace is bounded and explicit; reaching it records `streamSettled: false`
  // (unconfirmed), and never claims the remote request was revoked.
  if (timedOut) {
    const grace = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, WORKER_CLEANUP_GRACE_MS);
      t.unref?.();
    });
    await Promise.race([streamSettled.catch(() => undefined), grace]);
    cancellation.streamSettled = await Promise.race([
      streamSettled.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 0);
        t.unref?.();
      }),
    ]);
  }

  // The child owns its own stdin; close it, then take the exit code.
  try {
    child.stdin?.end();
  } catch {
    // already closed
  }
  const exitCode = await exited;

  // A reservation the child never settled is NOT refunded here: the durable
  // budget's own conservative rule decides, and an unproven dispatch must stay
  // visible as unsettled rather than be silently released.
  if (liveReservations.size > 0) {
    for (const [reservationId, live] of liveReservations) {
      liveReservations.delete(reservationId);
      settledReservations.add(reservationId);
      budgetCounters.settled += 1;
      await live.settle("unknown").catch(() => undefined);
    }
  }

  // R0/S1 — an arm refused by the capability pre-check reports the CAPABILITY
  // reason, never a downstream timeout or a missing result.
  if (abiRefusal !== null) {
    refuse(ARM_WORKER_ABI_UNSUPPORTED, abiRefusal);
  }
  if (timedOut) {
    refuse(
      ARM_WORKER_TIMEOUT,
      `the arm worker exceeded its ${opts.timeoutMs} ms bound; the transport was aborted first ` +
        `(signalAborted=${String(cancellation.signalAborted)}, providerReturnedWithinGrace=${String(cancellation.streamSettled)}) ` +
        `and the worker this task owns was then killed. A provider that did not return leaves the remote request UNCONFIRMED, not revoked`,
    );
  }
  if (!sawResult || report === null) {
    refuse(
      ARM_WORKER_FAILED,
      `the arm worker produced no result (exit=${exitCode ?? "unreadable"})${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, 200)}`}`,
    );
  }
  if (!report.ok) {
    refuse(report.code ?? ARM_WORKER_FAILED, `the arm worker refused: ${report.error ?? "unknown error"}`);
  }
  if (exitCode !== 0) {
    refuse(ARM_WORKER_FAILED, `the arm worker reported a result but exited ${exitCode}`);
  }
  return { report, physicalProviderCalls, exitCode, cancellation };
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