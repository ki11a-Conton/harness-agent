import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newSessionId, newTurnId } from "@ar/contracts";
import { InboxSessionInputQueue } from "./session-actor.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it.each([false, true])("reserves exactly one durable followup under concurrent requests (hydrated=%s)", async warm => {
  const { JSONLInboxStore } = await import(new URL("../../../session/src/inbox.js", import.meta.url).href);
  const dir = await mkdtemp(join(tmpdir(), "followup-reservation-")); dirs.push(dir);
  const sessionId = newSessionId(), inbox = new JSONLInboxStore({ dataDir: dir });
  const queue = new InboxSessionInputQueue({ sessionId, inbox });
  const first = await queue.enqueueFollowup({ sessionId, text: "first change" });
  const second = await queue.enqueueFollowup({ sessionId, text: "second change" });
  if (warm) await queue.hydratePendingFollowups();
  const reservations = await Promise.all(Array.from({ length: 4 }, () => queue.reservePendingFollowup()));
  expect(reservations.filter(Boolean)).toEqual([{ id: first, input: { sessionId, text: "first change" } }]);
  expect(queue.pendingCount).toBe(1);
  const firstTurn = newTurnId(); await queue.bindReservedFollowup(first, firstTurn);
  expect((await new JSONLInboxStore({ dataDir: dir }).listAll(sessionId)).find((p: { text: string }) => p.text === "first change")).toMatchObject({ promotedTurnId: firstTurn, status: "promoted" });
  await queue.completeReservedFollowup(first);
  expect(await queue.reservePendingFollowup()).toEqual({ id: second, input: { sessionId, text: "second change" } });
  const secondTurn = newTurnId(); await queue.bindReservedFollowup(second, secondTurn); await queue.completeReservedFollowup(second);
  expect(queue.pendingCount).toBe(0);
  expect(await new JSONLInboxStore({ dataDir: dir }).listRecoverable(sessionId)).toEqual([]);
});

it("release requeues the sole reservation ahead of later inputs", async () => {
  const queue = new InboxSessionInputQueue({ sessionId: newSessionId() });
  const first = await queue.enqueueFollowup({ sessionId: queue.sessionId, text: "one" });
  const second = await queue.enqueueFollowup({ sessionId: queue.sessionId, text: "two" });
  const reservations = await Promise.all([queue.reservePendingFollowup(), queue.reservePendingFollowup()]);
  expect(reservations.filter(Boolean).map(row => row!.id)).toEqual([first]);
  await queue.releaseReservedFollowup(first);
  expect((await queue.reservePendingFollowup())!.id).toBe(first);
  await queue.completeReservedFollowup(first);
  expect((await queue.reservePendingFollowup())!.id).toBe(second);
});
