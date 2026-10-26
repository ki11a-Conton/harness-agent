// Real native fetch and loopback HTTP; no response replacement or paid model.
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const root = process.argv[2], output = process.argv[3];
const { OpenAICompatibleProvider } = await import(pathToFileURL(join(root, "packages/model/dist/openai.js")));
const cases = [];
for (const mode of ["cancel", "deadline"]) for (const status of [401, 429, 500]) {
  const controller = new AbortController(); let requests = 0, started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const server = createServer((req, res) => {
    requests++; req.resume(); res.writeHead(status, { "content-type": "text/plain" });
    res.write("offline diagnostic body"); started();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "offline" }, {
    apiKey: "offline-only", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    maxProviderRetries: 0, requestTimeoutMs: mode === "deadline" ? 500 : 0,
  });
  try {
    const events = [], pending = (async () => {
      for await (const event of client.generate({ messages: [] }, controller.signal)) events.push(event);
    })();
    await bodyStarted;
    if (mode === "cancel") { await new Promise(resolve => setTimeout(resolve, 30)); controller.abort(); }
    await pending;
    cases.push({ mode, status, callerAborted: controller.signal.aborted, requests,
      terminal: events.filter(e => e.type === "completed" || e.type === "error").map(e => ({
        type: e.type, finishReason: e.result?.finishReason, providerKind: e.error?.provider?.kind,
      })) });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const report = { sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "",
  transport: "actual loopback HTTP; native fetch; no observers", paidModelCalls: 0, cases };
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
