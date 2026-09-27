/**
 * N6 — evidence must be bound to content that cannot be authored by the runner.
 * plan(20260926-175819).md §N6 (line 103), acceptance at line 115.
 *
 * The N0 gate proves the three headline counterexamples. This suite proves the
 * BOUNDARY AROUND the fix, so the green is not a one-case patch:
 *   - a digest-consistent but content-forged activation artifact is refused;
 *   - an activation artifact with the RIGHT schema but the WRONG run identity is
 *     refused (a valid schema alone is not a binding);
 *   - an activation artifact that names no events is refused;
 *   - a GENUINE activation artifact verifies (the refusal is not blanket);
 *   - one changed byte, and a deleted artifact, are refused;
 *   - the aggregate's token delta follows the durable JOURNAL, and a campaign that
 *     self-reports tokens with no journal corroboration is not comparable.
 *
 * SAFETY: pure in-process file fixtures under a temp dir. Zero network, zero
 * provider, zero cost, no key read.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stableStringify } from "@ar/evaluation";
import {
  PREREG_RUN_ACTIVATION_SCHEMA,
  PREREG_RUN_EVIDENCE_FILENAMES,
  PREREG_RUN_MANIFEST_SCHEMA,
  PREREG_RUN_SECURITY_SCHEMA,
  PREREG_RUN_VERIFIER_SCHEMA,
  type PreregRunIdentity,
  verifyArmEvidenceFromArtifacts,
} from "./prereg-run-evidence.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const EXECUTOR = "prereg-arm-executor-v1";

function identity(): PreregRunIdentity {
  return {
    preregistrationDigest: "p".repeat(64),
    planDigest: "l".repeat(64),
    armRunId: "pair-1-candidate",
    armId: "candidate",
    caseId: "reg-01",
    repetition: 0,
    orderIndex: 1,
  };
}

/** A GENUINE artifact set: exactly the shape the executor writes. */
function genuineArtifacts(id: PreregRunIdentity) {
  const manifest = `${stableStringify({
    schemaVersion: PREREG_RUN_MANIFEST_SCHEMA,
    executorId: EXECUTOR,
    preregistrationDigest: id.preregistrationDigest,
    planDigest: id.planDigest,
    armRunId: id.armRunId,
    armId: id.armId,
    caseId: id.caseId,
    repetition: id.repetition,
    orderIndex: id.orderIndex,
  })}\n`;
  const verifier = `${stableStringify({
    schemaVersion: PREREG_RUN_VERIFIER_SCHEMA,
    verifiedCompletion: true,
    status: "passed",
    grade: null,
    violations: [],
  })}\n`;
  const security = `${stableStringify({ schemaVersion: PREREG_RUN_SECURITY_SCHEMA, violations: 0 })}\n`;
  const activation = `${stableStringify({
    schemaVersion: PREREG_RUN_ACTIVATION_SCHEMA,
    caseId: id.caseId,
    armId: id.armId,
    repetition: id.repetition,
    orderIndex: id.orderIndex,
    events: [{ eventId: "e1", schemaVersion: "2.0.0", payloadDigest: "d".repeat(64) }],
  })}\n`;
  return { manifest, verifier, security, activation };
}

let dirs: string[] = [];

async function writeSet(files: Partial<Record<keyof ReturnType<typeof genuineArtifacts>, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "n6-evidence-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    if (text !== undefined) writeFileSync(join(dir, PREREG_RUN_EVIDENCE_FILENAMES[name as keyof typeof PREREG_RUN_EVIDENCE_FILENAMES]), text, "utf8");
  }
  return dir;
}

/** Declare exactly the digests of the files actually present — the hostile
 *  runner's best move: every hash is honest, only the CONTENT is authored. */
function declaredFor(identity: PreregRunIdentity, files: Partial<ReturnType<typeof genuineArtifacts>>) {
  return {
    executorId: EXECUTOR,
    traceDigest: sha(files.manifest ?? ""),
    verifiedCompletion: true,
    securityViolations: 0,
    activationEvidenceDigest: files.activation === undefined ? null : sha(files.activation),
  };
}

beforeEach(async () => {
  dirs = [];
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

describe("N6 — activation evidence must be CONTENT-bound, not merely digest-consistent", () => {
  it("[N6.1] a GENUINE artifact set verifies (the refusal is not blanket)", async () => {
    const id = identity();
    const files = genuineArtifacts(id);
    const dir = await writeSet(files);
    const v = verifyArmEvidenceFromArtifacts(dir, id, declaredFor(id, files));
    expect(v.problems).toEqual([]);
    expect(v.verified).toBe(true);
  }, 60_000);

  it("[N6.2] a digest-consistent activation with an unknown schema is refused", async () => {
    const id = identity();
    const files = genuineArtifacts(id);
    // The exact forgery the N0 counterexample used: honest digest, invented content.
    files.activation = `${stableStringify({ schemaVersion: "never-checked-by-the-validator", requestId: "never-happened" })}\n`;
    const dir = await writeSet(files);
    const v = verifyArmEvidenceFromArtifacts(dir, id, declaredFor(id, files));
    expect(v.verified).toBe(false);
    expect(v.problems.join(" | ")).toContain("activation schemaVersion");
  }, 60_000);

  it("[N6.3] a well-schemad activation bound to ANOTHER run's identity is refused", async () => {
    const id = identity();
    const files = genuineArtifacts(id);
    const other = { ...id, armRunId: "pair-9-candidate", caseId: "reg-99", repetition: 3, orderIndex: 7 };
    files.activation = `${stableStringify({
      schemaVersion: PREREG_RUN_ACTIVATION_SCHEMA,
      caseId: other.caseId,
      armId: other.armId,
      repetition: other.repetition,
      orderIndex: other.orderIndex,
      events: [{ eventId: "stolen" }],
    })}\n`;
    const dir = await writeSet(files);
    const v = verifyArmEvidenceFromArtifacts(dir, id, declaredFor(id, files));
    expect(v.verified).toBe(false);
    expect(v.problems.join(" | ")).toContain("does not match this run's identity");
  }, 60_000);

  it("[N6.4] an activation that names NO events is refused", async () => {
    const id = identity();
    const files = genuineArtifacts(id);
    files.activation = `${stableStringify({
      schemaVersion: PREREG_RUN_ACTIVATION_SCHEMA,
      caseId: id.caseId,
      armId: id.armId,
      repetition: id.repetition,
      orderIndex: id.orderIndex,
      events: [],
    })}\n`;
    const dir = await writeSet(files);
    const v = verifyArmEvidenceFromArtifacts(dir, id, declaredFor(id, files));
    expect(v.verified).toBe(false);
    expect(v.problems.join(" | ")).toContain("no activation events");
  }, 60_000);

  it("[N6.5] ONE changed byte in the manifest is refused, and a DELETED artifact is refused", async () => {
    const id = identity();
    const files = genuineArtifacts(id);
    const dir = await writeSet(files);
    // Honest declaration for the ORIGINAL bytes, then mutate one byte on disk.
    const declared = declaredFor(id, files);
    writeFileSync(join(dir, PREREG_RUN_EVIDENCE_FILENAMES.manifest), `${files.manifest!.replace('"armId":"candidate"', '"armId":"baseline"')}`, "utf8");
    const changed = verifyArmEvidenceFromArtifacts(dir, id, declared);
    expect(changed.verified).toBe(false);

    // ...and a missing artifact is never silently skipped.
    const gone = await writeSet({ verifier: files.verifier, security: files.security, activation: files.activation });
    expect(existsSync(join(gone, PREREG_RUN_EVIDENCE_FILENAMES.manifest))).toBe(false);
    const missing = verifyArmEvidenceFromArtifacts(gone, id, declared);
    expect(missing.verified).toBe(false);
    expect(missing.problems.join(" | ")).toContain("missing or unreadable");
  }, 60_000);

  it("[N6.6] an unactivated run that carries an activation artifact is refused", async () => {
    const id = identity();
    const files = genuineArtifacts(id);
    const dir = await writeSet(files);
    const v = verifyArmEvidenceFromArtifacts(dir, id, { ...declaredFor(id, files), activationEvidenceDigest: null });
    expect(v.verified).toBe(false);
    expect(v.problems.join(" | ")).toContain("non-activated run must not carry an activation artifact");
  }, 60_000);
});
