import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRef, ProviderConfig } from "@ar/contracts";
import { createHarness } from "./create-harness.js";
import type { HarnessConfig } from "./config.js";

/**
 * P8-1: verification plan auto-orchestration wired through the real harness.
 *
 * When the host supplies a task, createHarness wires a TaskVerifier AND a plan
 * builder: a task with no declared specs gets a plan derived from the change
 * set + discovered commands; explicit specs win. Every step is observable as
 * verification.step_started / verification.step_completed (P8-2).
 *
 * The turn runs on a fake model that immediately stops — completion is decided
 * by the verification gate alone (never by the model's word).
 */

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-verification-wiring-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

function fakeProvider(): { provider: ModelProvider; model: ModelRef } {
  const model: ModelRef = { providerId: "fake", modelId: "test-model" };
  const provider: ModelProvider = {
    id: "fake",
    async listModels() {
      return [{ id: model.modelId, name: "Test", capabilities: { contextWindowTokens: 128_000 } }];
    },
    createClient(_model: ModelRef, _config: ProviderConfig) {
      return {
        async *generate(_request: unknown): AsyncGenerator<ModelEvent, void, void> {
          yield { type: "started", timestamp: 0 };
          yield { type: "text_delta", text: "done", timestamp: 0 };
          yield {
            type: "completed",
            result: { finishReason: "stop", text: "done" },
            timestamp: 0,
          };
        },
      };
    },
  };
  return { provider, model };
}

function baseConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const { provider, model } = fakeProvider();
  return { cwd: process.cwd(), profile: "test", modelProvider: provider, model, ...overrides };
}

/** Runs one full turn and returns the outcome + events. */
async function runTurn(harness: Awaited<ReturnType<typeof createHarness>>, cwd: string) {
  const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
  const turn = await harness.runtime.startTurn(session.id, "complete the task");
  const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  const events = await harness.events.list(session.id);
  return { outcome, events };
}

describe("P8-1: verification plan auto-orchestration in createHarness", () => {
  it("runs the verification gate when the task declares explicit specs", async () => {
    const cwd = await tempDir();
    const harness = await createHarness(
      baseConfig({
        cwd,
        task: {
          id: "t-explicit",
          goal: "finish the work",
          verification: [{ kind: "command", command: "node", args: ["-e", "process.exit(0)"], description: "explicit check" }],
        },
      }),
    );

    try {
      const { outcome, events } = await runTurn(harness, cwd);
      expect(outcome.status).toBe("completed");
      expect(outcome.terminationReason).toBe("verified_complete");

      const steps = events.filter((e) => e.type.startsWith("verification.step_"));
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.some((e) => e.type === "verification.step_completed" && e.payload.passed === true)).toBe(true);
      expect(events.some((e) => e.type === "verification.completed" && e.payload.passed === true)).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("auto-orchestrates a plan from discovered commands when the task declares none", async () => {
    const cwd = await tempDir();
    // A package.json whose test script passes lets discoverCommands (P7-6)
    // produce the test hint the plan builder consumes.
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: 'node -e "process.exit(0)"' } }));

    const harness = await createHarness(
      baseConfig({
        cwd,
        task: { id: "t-auto", goal: "finish the work" }, // no verification specs
      }),
    );

    try {
      const { outcome, events } = await runTurn(harness, cwd);
      expect(outcome.status).toBe("completed");
      expect(outcome.terminationReason).toBe("verified_complete");

      const completed = events.filter((e) => e.type === "verification.step_completed");
      // The plan builder generated at least one command step (the repo test
      // from the discovered package.json test script).
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect(completed.some((e) => String(e.payload.kind) === "command" && e.payload.passed === true)).toBe(true);
      expect(completed.some((e) => String(e.payload.description).includes("planned:"))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("fails closed with an honest empty plan when nothing can be verified", async () => {
    const cwd = await tempDir(); // no package.json → no discovered commands
    const harness = await createHarness(
      baseConfig({
        cwd,
        task: { id: "t-empty", goal: "finish the work" },
      }),
    );

    try {
      const { outcome } = await runTurn(harness, cwd);
      // An empty plan is NOT a pass: the TaskVerifier returns its
      // deterministic level-0 / passed=false result (never invented success).
      expect(outcome.status).toBe("failed");
    } finally {
      await harness.close();
    }
  });

  it("a custom planner override replaces the default derivation", async () => {
    const cwd = await tempDir();
    const harness = await createHarness(
      baseConfig({
        cwd,
        task: { id: "t-custom", goal: "finish the work" },
        verification: {
          planner: async () => [
            { kind: "command", command: "node", args: ["-e", "process.exit(0)"], description: "custom planned check" },
          ],
        },
      }),
    );

    try {
      const { outcome, events } = await runTurn(harness, cwd);
      expect(outcome.status).toBe("completed");
      const completed = events.filter((e) => e.type === "verification.step_completed");
      expect(completed.some((e) => String(e.payload.description) === "custom planned check")).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
