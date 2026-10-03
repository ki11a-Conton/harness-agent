import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOL_SEMANTICS, newEventId, newSessionId, newTurnId } from "@ar/contracts";
import type { ToolCallId } from "@ar/contracts";
import { ContextController, type ContextControllerDeps } from "./context-controller.js";
import { InMemoryArtifactStore } from "./artifact-store.js";
import type { TurnContext } from "./turn-helpers.js";
import { MemorySessionStore } from "../test/fakes.js";

describe("R3a artifact identity never becomes a filesystem path", () => {
  it.each(["nested/../../escape", "x".repeat(4096)])("contains an untrusted provider id under the artifact root", async (id) => {
    const root = await mkdtemp(join(tmpdir(), "r3a-artifact-identity-"));
    const artifactDir = join(root, "artifacts");
    const outside = join(root, "escape.txt");
    try {
      await writeFile(outside, "unchanged");
      const artifactStore = new InMemoryArtifactStore();
      const ctx = { sessionId: newSessionId(), turnId: newTurnId() } as TurnContext;
      const emit = vi.fn<ContextControllerDeps["emit"]>(async (sessionId, type, payload, turnId) => ({
        id: newEventId(), sessionId, turnId, type, payload, timestamp: 0, sequence: 1,
      }));
      const controller = new ContextController({
        store: new MemorySessionStore(), emit, now: () => 0, failAt: async () => {},
        compactCounter: { value: 0 }, checkpoint: async () => {},
        finishTurn: async () => { throw new Error("unexpected finish"); },
        semanticsOf: () => DEFAULT_TOOL_SEMANTICS,
        artifactStore, toolOutputBudget: { artifactDir, maxInlineBytes: 1 },
      });
      const content = "bounded captured output";
      await controller.renderToolResultForContext(ctx, { id: id as ToolCallId, name: "exec", args: {} }, { status: "success", output: content });
      const artifacts = await artifactStore.list();
      expect(artifacts).toHaveLength(1);
      const artifact = artifacts[0]!;
      const rel = relative(artifactDir, artifact.ref);
      expect(isAbsolute(rel)).toBe(false);
      expect(rel.startsWith("..")).toBe(false);
      expect(dirname(artifact.ref)).toBe(artifactDir);
      expect(artifact.toolCallId).toBe(id);
      expect(await readFile(artifact.ref, "utf8")).toBe(content);
      expect(await readFile(outside, "utf8")).toBe("unchanged");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
