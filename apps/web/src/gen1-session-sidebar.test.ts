import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

async function sidebar(initial: string[] = []) {
  const raw = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const storage = new Map<string, string>([["harness.web.froms", JSON.stringify(initial)]]);
  const sandbox = { localStorage: { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) } };
  return runInNewContext(raw.replace("void init();", "") + "\n({ mergeKnownSessions, state });", sandbox) as {
    mergeKnownSessions(sessions: unknown[]): boolean;
    state: { froms: string[]; titles: Map<string, string>; activeFrom: string | null };
  };
}

it("recovers persistent backend conversations with an empty browser store", async () => {
  const app = await sidebar();
  expect(app.mergeKnownSessions([{ from: "durable-sender-1", createdAt: 1, firstText: "Fix the tests" }])).toBe(true);
  expect(Array.from(app.state.froms)).toEqual(["durable-sender-1"]);
  expect(app.state.titles.get("durable-sender-1")).toBe("Fix the tests");
  expect(app.mergeKnownSessions([{ from: "durable-sender-1", createdAt: 1, firstText: "Fix the tests" }])).toBe(false);
});

it("keeps unsent local conversations and the selected conversation while bounding the sidebar", async () => {
  const app = await sidebar(["local-unsent-1"]);
  app.state.activeFrom = "durable-sender-0";
  const sessions = Array.from({ length: 70 }, (_, index) => ({ from: `durable-sender-${index}`, createdAt: index }));
  expect(app.mergeKnownSessions([...sessions, { from: "<script>alert(1)</script>" }, { from: 123 }])).toBe(true);
  expect(app.state.froms).toHaveLength(50);
  expect(app.state.froms).toContain("local-unsent-1");
  expect(app.state.froms).toContain("durable-sender-0");
  expect(app.mergeKnownSessions(sessions)).toBe(false);
});
