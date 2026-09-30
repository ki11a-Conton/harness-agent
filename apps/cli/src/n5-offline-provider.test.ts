import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const driver = new URL("../../../scripts/e4/r5-real-formal.mjs", import.meta.url).href;

describe("N5 formal scripted provider conversation binding", () => {
  it("matches multiline request content and writes once in every arm/repetition", () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { createOfflineScriptedProvider } = await import(${JSON.stringify(driver)});
      const transcript = [];
      const needle = 'Fix CSV parsing.\\nTrim every field.';
      const p = createOfflineScriptedProvider({ transcript, caseScripts: [{
        caseId: 'csv', needle, variant: 'write',
        writeTarget: { path: 'src/csv.js', content: 'correct bytes' }
      }] });
      const results = [];
      for (const sessionId of ['baseline-r1', 'candidate-r1', 'baseline-r2', 'candidate-r2']) {
        const messages = [{ sessionId, role: 'user', content: needle }];
        const first = [];
        for await (const e of p.createClient().generate({ messages })) first.push(e);
        messages.push({ sessionId, role: 'assistant', content: '' });
        const follow = [];
        for await (const e of p.createClient().generate({ messages })) follow.push(e);
        results.push({ first, follow });
      }
      process.stdout.write(JSON.stringify({ results, transcript }));
    `], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const { results, transcript } = JSON.parse(r.stdout);
    expect(transcript.map((t: { caseId: string; callIndex: number }) => [t.caseId, t.callIndex]))
      .toEqual(Array.from({ length: 4 }, () => [["csv", 0], ["csv", 1]]).flat());
    for (const result of results) {
      const writes = result.first.filter((e: { type: string }) => e.type === "tool_call_delta");
      expect(writes).toHaveLength(1);
      expect(writes[0].toolCall.args).toEqual({ path: "src/csv.js", content: "correct bytes" });
      expect(result.follow.filter((e: { type: string }) => e.type === "tool_call_delta")).toEqual([]);
      for (const events of [result.first, result.follow]) {
        expect(events.filter((e: { type: string }) => e.type === "completed")).toHaveLength(1);
      }
    }
  });
});
