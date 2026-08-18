import { describe, expect, it } from "vitest";
import type { Message, MessageRole, TaskSpec, VerificationContext, VerificationResult, Verifier } from "@ar/contracts";
import { newMessageId, newSessionId, newTurnId } from "@ar/contracts";
import { RuntimeVerifier, type RuntimeVerifierOptions } from "./runtime-verifier.js";
import { MemorySessionStore } from "../test/fakes.js";

const SESSION = newSessionId();
const TURN = newTurnId();

function makeMessage(role: MessageRole, content: string, over: Partial<Message> = {}): Message {
  return { id: newMessageId(), sessionId: SESSION, role, content, createdAt: 1_000, ...over };
}

function makeVerifierResult(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    level: 3,
    passed: true,
    checks: [],
    evidence: [],
    startedAt: Date.now(),
    completedAt: Date.now(),
    ...over,
  };
}

function makeTask(verification: TaskSpec["verification"] = []): TaskSpec {
  return { id: "t1", goal: "goal", ...(verification !== undefined ? { verification } : {}) };
}

function makeOpts(over: Partial<RuntimeVerifierOptions> = {}): RuntimeVerifierOptions {
  return { cwd: "C:\\work", runStartedAt: 500, changedPaths: ["C:\\work\\out.txt"], ...over };
}

/**
 * Inline fake Verifier (no @ar/tools import): @ar/core does not depend on
 * @ar/tools, so TaskVerifier is exercised by its own test suite in @ar/tools;
 * here the RuntimeVerifier contract is tested against a shim.
 */
class FakeVerifier implements Verifier {
  contexts: VerificationContext[] = [];
  constructor(
    private readonly handler: (task: TaskSpec, context: VerificationContext) => Promise<VerificationResult> | VerificationResult,
  ) {}
  async verify(task: TaskSpec, context: VerificationContext): Promise<VerificationResult> {
    this.contexts.push(context);
    return this.handler(task, context);
  }
}

async function run(
  fake: FakeVerifier,
  opts: RuntimeVerifierOptions = makeOpts(),
  verification: TaskSpec["verification"] = [],
) {
  const store = new MemorySessionStore();
  const rv = new RuntimeVerifier(fake);
  const gate = await rv.verifyTurn(makeTask(verification), SESSION, TURN, store, opts);
  return { gate, context: fake.contexts[0]!, store };
}

describe("RuntimeVerifier (VERIFY-001)", () => {
  it("maps a passing verifier result to gate status passed", async () => {
    const fake = new FakeVerifier(async () => makeVerifierResult({ passed: true, level: 3 }));
    const { gate } = await run(fake);
    expect(gate.status).toBe("passed");
    expect(gate.result.passed).toBe(true);
    expect(gate.reason).toBe("all checks passed");
  });

  it("maps a failing verifier result to failed and explains via failed checks", async () => {
    const fake = new FakeVerifier(() =>
      makeVerifierResult({
        passed: false,
        level: 1,
        checks: [
          { id: "command:exit", kind: "command", description: "must exit 0", passed: false, error: { code: "VERIFICATION_FAILED", message: "exit 1", retryable: false, safeToRetry: false } },
        ],
      }),
    );
    const { gate } = await run(fake);
    expect(gate.status).toBe("failed");
    expect(gate.result.passed).toBe(false);
    expect(gate.reason).toContain("must exit 0");
    expect(gate.reason).toContain("exit 1");
  });

  it("joins multiple failed checks into the reason", async () => {
    const fake = new FakeVerifier(() =>
      makeVerifierResult({
        passed: false,
        checks: [
          { id: "c1", kind: "command", description: "check one", passed: false, error: { code: "VERIFICATION_FAILED", message: "boom 1", retryable: false, safeToRetry: false } },
          { id: "c2", kind: "artifact", description: "check two", passed: false, error: { code: "VERIFICATION_FAILED", message: "boom 2", retryable: false, safeToRetry: false } },
        ],
      }),
    );
    const { gate } = await run(fake);
    expect(gate.status).toBe("failed");
    expect(gate.reason).toContain("check one: boom 1");
    expect(gate.reason).toContain("check two: boom 2");
  });

  it("fail-closes on a throwing verifier with an INTERNAL_ERROR check", async () => {
    const fake = new FakeVerifier(() => {
      throw new Error("kaboom");
    });
    const { gate } = await run(fake);
    expect(gate.status).toBe("blocked");
    expect(gate.result.passed).toBe(false);
    expect(gate.result.checks).toHaveLength(1);
    expect(gate.result.checks[0]?.passed).toBe(false);
    expect(gate.result.checks[0]?.error?.code).toBe("INTERNAL_ERROR");
    expect(gate.reason).toContain("kaboom");
  });

  it("renders one [role] line per message in the transcript", async () => {
    const fake = new FakeVerifier(() => makeVerifierResult());
    const store = new MemorySessionStore();
    await store.appendMessage(makeMessage("user", "build the thing"));
    await store.appendMessage(makeMessage("assistant", "let me fix it"));
    await store.appendMessage(makeMessage("tool", "exit code 0"));
    const rv = new RuntimeVerifier(fake);
    await rv.verifyTurn(makeTask(), SESSION, TURN, store, makeOpts());

    const transcript = fake.contexts[0]!.transcript;
    expect(transcript).toContain("[user] build the thing");
    expect(transcript).toContain("[assistant] let me fix it");
    expect(transcript).toContain("[tool] exit code 0");
  });

  it("truncates an overlong message to messageTruncate chars", async () => {
    const fake = new FakeVerifier(() => makeVerifierResult());
    const store = new MemorySessionStore();
    await store.appendMessage(makeMessage("assistant", "x".repeat(2_000)));
    const rv = new RuntimeVerifier(fake);
    await rv.verifyTurn(makeTask(), SESSION, TURN, store, makeOpts({ messageTruncate: 10 }));

    const line = fake.contexts[0]!.transcript;
    expect(line).toBe("[assistant] xxxxxxxxx…");
  });

  it("caps the whole transcript at maxTranscriptChars", async () => {
    const fake = new FakeVerifier(() => makeVerifierResult());
    const store = new MemorySessionStore();
    for (let i = 0; i < 20; i++) {
      await store.appendMessage(makeMessage("assistant", `${i}: ${"y".repeat(400)}`));
    }
    const rv = new RuntimeVerifier(fake);
    await rv.verifyTurn(makeTask(), SESSION, TURN, store, makeOpts({ maxTranscriptChars: 500, messageTruncate: 100 }));

    const transcript = fake.contexts[0]!.transcript;
    expect(transcript.length).toBeLessThanOrEqual(500);
    expect(transcript).toContain("[assistant]");
    expect(transcript.endsWith("…")).toBe(true);
  });

  it("applies default caps when options are omitted", async () => {
    const fake = new FakeVerifier(() => makeVerifierResult());
    const store = new MemorySessionStore();
    await store.appendMessage(makeMessage("user", "z".repeat(2_500)));
    const rv = new RuntimeVerifier(fake);
    await rv.verifyTurn(makeTask(), SESSION, TURN, store, makeOpts());

    const transcript = fake.contexts[0]!.transcript;
    expect(transcript.length).toBeLessThanOrEqual(16_000);
    expect(transcript).toContain("…");
  });

  it("passes cwd, changedPaths, runStartedAt and sessionId through to the context", async () => {
    const fake = new FakeVerifier(() => makeVerifierResult());
    await run(fake, makeOpts({ cwd: "C:\\deep\\work", changedPaths: ["a.txt", "b.txt"], runStartedAt: 42_000 }));

    const ctx = fake.contexts[0]!;
    expect(ctx.sessionId).toBe(SESSION);
    expect(ctx.cwd).toBe("C:\\deep\\work");
    expect(ctx.changedPaths).toEqual(["a.txt", "b.txt"]);
    expect(ctx.runStartedAt).toBe(42_000);
  });

  it("P1-16: passes baselineFiles through when provided and omits it when absent", async () => {
    const fake = new FakeVerifier(() => makeVerifierResult());
    await run(fake, makeOpts({ baselineFiles: ["src/a.ts", "src/b.ts"] }));
    expect(fake.contexts[0]!.baselineFiles).toEqual(["src/a.ts", "src/b.ts"]);

    await run(fake, makeOpts());
    expect(fake.contexts[1]).not.toHaveProperty("baselineFiles");
  });

  it("passes turnId through when provided and omits it when undefined", async () => {
    const fake = new FakeVerifier(() => makeVerifierResult());
    const store = new MemorySessionStore();
    const rv = new RuntimeVerifier(fake);

    await rv.verifyTurn(makeTask(), SESSION, TURN, store, makeOpts());
    expect(fake.contexts[0]!.turnId).toBe(TURN);

    await rv.verifyTurn(makeTask(), SESSION, undefined, store, makeOpts());
    expect(fake.contexts[1]).not.toHaveProperty("turnId");
  });

  it("still invokes the verifier for undefined or empty verification specs", async () => {
    const fake = new FakeVerifier(() => makeVerifierResult({ passed: false, level: 0 }));
    const store = new MemorySessionStore();
    const rv = new RuntimeVerifier(fake);

    const gateA = await rv.verifyTurn(makeTask(undefined), SESSION, TURN, store, makeOpts());
    const gateB = await rv.verifyTurn(makeTask([]), SESSION, TURN, store, makeOpts());

    expect(fake.contexts).toHaveLength(2);
    expect(gateA.status).toBe("failed");
    expect(gateB.status).toBe("failed");
    expect(gateB.reason).toContain("level 0");
  });

  it("fills missing startedAt/completedAt while keeping provided timestamps", async () => {
    const fake = new FakeVerifier(() => makeVerifierResult({ startedAt: NaN, completedAt: NaN }));
    const { gate } = await run(fake);
    expect(Number.isFinite(gate.result.startedAt)).toBe(true);
    expect(Number.isFinite(gate.result.completedAt)).toBe(true);
    expect(gate.result.completedAt).toBeGreaterThanOrEqual(gate.result.startedAt);
  });
});