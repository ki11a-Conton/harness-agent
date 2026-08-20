import { afterEach, describe, expect, it } from "vitest";
import {
  installDeterministicIds,
  installIdSource,
  newEventId,
  newMemoryId,
  newSessionId,
  newTurnId,
} from "@ar/contracts";

afterEach(() => {
  // Never leak a deterministic source into other tests: restore the default.
  installIdSource(null);
});

describe("Q-8 deterministic IDs in tests", () => {
  it("installDeterministicIds yields a replayable, deterministic sequence", () => {
    const restore = installDeterministicIds();
    try {
      // The same call sequence reproduces identical IDs after a re-install.
      const first = [newSessionId(), newTurnId(), newEventId(), newMemoryId()];
      restore();
      installDeterministicIds();
      const second = [newSessionId(), newTurnId(), newEventId(), newMemoryId()];
      expect(second).toEqual(first);
    } finally {
      restore();
      installIdSource(null);
    }
  });

  it("deterministic IDs are unique within a sequence (no cross-type collision)", () => {
    const restore = installDeterministicIds();
    try {
      const ids = [
        newSessionId(),
        newTurnId(),
        newEventId(),
        newSessionId(),
        newEventId(),
        newMemoryId(),
      ];
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      restore();
      installIdSource(null);
    }
  });

  it("production default (restored) IDs look like random UUIDs", () => {
    installIdSource(null);
    const id = newSessionId();
    const body = id.slice("session_".length);
    expect(body).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // And they are (practically) unique across calls.
    expect(newSessionId()).not.toBe(id);
  });
});