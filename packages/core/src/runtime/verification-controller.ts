/**
 * Q-1: verification gate extracted from runtime.ts. Owns the single
 * runVerificationGate method — completion-policy checks (no-side-effects /
 * requires-changed-file / requires-verification) plus the RuntimeVerifier
 * wiring. Method body is byte-for-byte the one that lived on AgentRuntime;
 * only `this.<field>` → `this.deps.<field>` changed.
 */

import type { SessionStore, TaskSpec, Verifier } from "@ar/contracts";
import { RuntimeVerifier } from "../verification/runtime-verifier.js";
import type { TurnContext } from "./turn-helpers.js";

export interface VerificationGateResult {
  status: "passed" | "failed" | "blocked";
  reason: string;
}

export interface VerificationControllerDeps {
  task?: TaskSpec;
  verifier?: Verifier;
  store: SessionStore;
  now: () => number;
  changedPathsProvider?: () => readonly string[];
  baselineFilesProvider?: () => readonly string[];
}

export class VerificationController {
  constructor(private readonly deps: VerificationControllerDeps) {}

  async runVerificationGate(
    ctx: TurnContext,
  ): Promise<VerificationGateResult | undefined> {
    const { session, turnId } = ctx;
    // P1-15: completion policy runs before the verifier — objective task
    // requirements gate completion even when no verifier is configured.
    const policy = this.deps.task?.completionPolicy;
    const changed = [...(this.deps.changedPathsProvider?.() ?? [])];
    if (policy?.requiresNoSideEffects === true && changed.length > 0) {
      const sample = changed.slice(0, 5).join(", ");
      return {
        status: "failed",
        reason: `completion policy: task requires no side effects but ${changed.length} file(s) changed (${sample}${changed.length > 5 ? ", …" : ""})`,
      };
    }
    if (policy?.requiresChangedFile === true && changed.length === 0) {
      return {
        status: "failed",
        reason: "completion policy: task requires a changed file but nothing was changed",
      };
    }
    if (this.deps.task === undefined || this.deps.verifier === undefined) {
      if (policy?.requiresVerification === true && this.deps.verifier === undefined) {
        return {
          status: "blocked",
          reason: "completion policy: task requires verification but no verifier is configured",
        };
      }
      return undefined;
    }
    const gate = await new RuntimeVerifier(this.deps.verifier).verifyTurn(
      this.deps.task,
      session.id,
      turnId,
      this.deps.store,
      {
        cwd: session.cwd,
        runStartedAt: this.deps.now(),
        changedPaths: changed,
        ...(this.deps.baselineFilesProvider !== undefined
          ? { baselineFiles: [...this.deps.baselineFilesProvider()] }
          : {}),
      },
    );
    return { status: gate.status, reason: gate.reason };
  }
}
