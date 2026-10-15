import { expect, it } from "vitest";
import { newEventId, newSessionId } from "@ar/contracts";
import { MemEventStore } from "./mem-stores.js";

it("interleaved concurrent memory writers allocate independent zero-based dense session journals", async () => {
  const store = new MemEventStore(), a = newSessionId(), b = newSessionId(), empty = newSessionId();
  await Promise.all(Array.from({ length: 40 }, (_, index) => store.appendNew({
    id: newEventId(), sessionId: index % 2 ? a : b, timestamp: index, type: "human.message", payload: { text: String(index) },
  })));
  for (const id of [a, b]) {
    const journal = await store.list(id);
    expect(journal.map(event => event.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(await store.nextSequence(id)).toBe(20);
    expect((await store.list(id, { afterSequence: 17, limit: 1 })).map(event => event.sequence)).toEqual([18]);
    const streamed = []; for await (const event of store.stream(id, { afterSequence: 18 })) streamed.push(event.sequence);
    expect(streamed).toEqual([19]);
  }
  expect(await store.nextSequence(empty)).toBe(0);
});
