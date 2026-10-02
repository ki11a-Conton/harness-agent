import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessExecutor } from "../../packages/tools/dist/process/executor.js";
import { ContextController } from "../../packages/core/dist/runtime/context-controller.js";
import { ToolOrchestrator } from "../../packages/tools/dist/orchestrator.js";

// Read-only reproducer for the existing output boundary and UTF-8 defects.
// Only disposable files and a fake secret/injection sentinel are used.
// Exit 0 means the observations completed, not that the contracts passed.
const workspace = await mkdtemp(join(tmpdir(), "harness-codex-source-repro-"));
const secret = "SECRET_SENTINEL";
const attack = "ATTACK_SENTINEL";
const text = `${secret} ${attack} ${"x".repeat(10000)}`;
const evidence = {
  schemaVersion: 1,
  node: process.version,
  platform: process.platform,
  observationExitSemantics: "Exit 0 means the reproducer completed; inspect contractChecks for correctness.",
  contextShapeBoundary: [],
};

try {
  for (const scenario of [
    { name: "string_with_budget", structured: false, budget: true },
    { name: "exec_object_with_budget", structured: true, budget: true },
    { name: "string_without_budget", structured: false, budget: false },
  ]) {
    let redactorCalls = 0;
    let detectorCalls = 0;
    const events = [];
    const artifactDir = join(workspace, scenario.name);
    const controller = new ContextController({
      ...(scenario.budget ? { toolOutputBudget: { maxInlineBytes: 32, artifactDir } } : {}),
      outputRedactor(content) {
        redactorCalls += 1;
        return {
          content: content.replaceAll(secret, "[REDACTED]"),
          redacted: content.includes(secret) ? 1 : 0,
        };
      },
      injectionDetector(content) {
        detectorCalls += 1;
        return { hasInjection: content.includes(attack), reasons: ["fake_research_marker"] };
      },
      emit: async (_sessionId, type) => { events.push(type); },
    });
    const output = scenario.structured ? { stdout: text, stderr: "", exitCode: 0 } : text;
    const result = { status: "success", output };
    const original = JSON.stringify(result);
    const rendered = await controller.renderToolResultForContext(
      { sessionId: "session_research", turnId: "turn_research" },
      { id: "tc_research", name: "exec", arguments: {} },
      result,
    );
    let artifact = null;
    const artifactPath = join(artifactDir, "session_research-turn_research-tc_research.txt");
    try {
      const content = await readFile(artifactPath, "utf8");
      const expected = (typeof output === "string" ? output : JSON.stringify(output)).replaceAll(secret, "[REDACTED]");
      artifact = {
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
        secretVisible: content.includes(secret),
        completeRedactedModelText: content === expected,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    evidence.contextShapeBoundary.push({
      scenario: scenario.name,
      redactorCalls,
      detectorCalls,
      events,
      renderedBytes: Buffer.byteLength(rendered),
      secretVisible: rendered.includes(secret),
      attackVisible: rendered.includes(attack),
      blocked: rendered.includes("tool output blocked"),
      rawResultUnchanged: JSON.stringify(result) === original,
      artifact,
      contractChecks: {
        redactorInvoked: redactorCalls > 0,
        detectorInvoked: detectorCalls > 0,
        noSecretInModelText: !rendered.includes(secret),
        noAttackInModelText: !rendered.includes(attack),
      },
    });
  }

  const executor = new ProcessExecutor();
  const cap = await executor.runArgv({
    file: process.execPath,
    args: ["-e", "process.stdout.write('中'.repeat(100))"],
    cwd: workspace,
    maxOutputBytes: 8,
  });
  const streaming = [];
  const split = await executor.runArgv({
    file: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(()=>process.stdout.write(Buffer.from([0x98,0x80])),100)"],
    cwd: workspace,
    maxOutputBytes: 100,
    onOutput: ({ stream, text: chunk }) => { if (stream === "stdout") streaming.push(chunk); },
  });
  const limited = ToolOrchestrator.prototype.applyOutputLimit(
    { status: "success", output: "中".repeat(100) },
    { sandboxPolicy: { process: { maxOutputBytes: 8 } } },
  );
  const limitedBody = limited.output.split("\n")[0];
  evidence.executorUtf8 = {
    byteCap: {
      maxOutputBytes: 8,
      actualBodyBytes: Buffer.byteLength(cap.stdout),
      actualCodeUnits: cap.stdout.length,
      status: cap.status,
      truncated: cap.truncated,
      capRespected: Buffer.byteLength(cap.stdout) <= 8,
    },
    chunkBoundary: {
      expected: "😀",
      actual: split.stdout,
      status: split.status,
      validUtf8Preserved: split.stdout === "😀",
      streamingActual: streaming.join(""),
      streamingUtf8Preserved: streaming.join("") === "😀",
    },
    orchestratorByteCap: {
      maxOutputBytes: 8,
      actualBodyBytes: Buffer.byteLength(limitedBody),
      capRespected: Buffer.byteLength(limitedBody) <= 8,
      note: "Body bytes exclude the independently appended truncation notice.",
    },
  };
} finally {
  await rm(workspace, { recursive: true, force: true });
  try {
    await stat(workspace);
    evidence.temporaryWorkspaceRemoved = false;
    throw new Error("Disposable workspace was not removed");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    evidence.temporaryWorkspaceRemoved = true;
  }
}

console.log(JSON.stringify(evidence, null, 2));
