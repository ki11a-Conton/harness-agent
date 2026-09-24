import { describe, expect, it } from "vitest";
import {
  newArtifactId,
  newSessionId,
  newToolCallId,
  newTurnId,
  type Artifact,
} from "@ar/contracts";
import { InMemoryArtifactStore } from "./artifact-store.js";

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: newArtifactId(),
    sessionId: newSessionId(),
    turnId: newTurnId(),
    toolCallId: newToolCallId(),
    ref: "/tmp/x.txt",
    mime: "text/plain",
    bytes: 3,
    sha256: "abc",
    createdAt: 10,
    sensitivity: "medium",
    retention: "turn",
    ...over,
  };
}

describe("P1-12: InMemoryArtifactStore", () => {
  it("registers and retrieves by id", async () => {
    const store = new InMemoryArtifactStore();
    const a = artifact();
    await store.register(a);
    expect(await store.get(a.id)).toEqual(a);
    expect(await store.get(newArtifactId())).toBeUndefined();
  });

  it("indexes by tool call, session, and content hash", async () => {
    const store = new InMemoryArtifactStore();
    const sessionId = newSessionId();
    const turnId = newTurnId();
    const toolCallId = newToolCallId();
    const a = artifact({ sessionId, turnId, toolCallId, sha256: "hash-1" });
    const b = artifact({ sessionId, turnId, toolCallId, sha256: "hash-2" });
    const c = artifact({ sha256: "hash-1" });
    await store.register(a);
    await store.register(b);
    await store.register(c);

    expect(await store.byToolCallId(sessionId, turnId, toolCallId)).toHaveLength(2);
    expect(await store.bySessionId(sessionId)).toHaveLength(2);
    expect((await store.byHash("hash-1")).map((x) => x.id).sort()).toEqual([a.id, c.id].sort());
    expect(await store.byHash("nope")).toHaveLength(0);
  });

  it("remove deletes from every index", async () => {
    const store = new InMemoryArtifactStore();
    const sessionId = newSessionId();
    const a = artifact({ sessionId, sha256: "same" });
    const b = artifact({ sessionId, sha256: "same" });
    await store.register(a);
    await store.register(b);

    await store.remove([a.id]);
    expect(await store.get(a.id)).toBeUndefined();
    expect(await store.get(b.id)).toBeDefined();
    expect(await store.bySessionId(sessionId)).toHaveLength(1);
    expect((await store.byHash("same")).map((x) => x.id)).toEqual([b.id]);
    // removing a non-existent id is a no-op
    await store.remove([newArtifactId()]);
    expect(await store.list()).toHaveLength(1);
  });
});