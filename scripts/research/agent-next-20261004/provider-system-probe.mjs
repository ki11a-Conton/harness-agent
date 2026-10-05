import { pathToFileURL } from "node:url";
import { join } from "node:path";

// Called only by provider-production.py with a synthetic key and loopback URL.
const [mode, root, target] = process.argv.slice(2);
const fromRoot = (path) => import(pathToFileURL(join(root, path)).href);
const system = "TOPLEVEL_SYSTEM_中文marker\n保留空白  和换行\n";
if (mode === "seed") {
  const { JsonlMemoryStore } = await fromRoot("packages/memory/dist/memory-store.js");
  const { newMemoryId, newSessionId } = await fromRoot("packages/contracts/dist/index.js");
  const now = Date.now();
  await new JsonlMemoryStore({ dataDir: target }).write({
    id: newMemoryId(), sourceSession: newSessionId(),
    content: "RecallProbe user preference: concise review notes in numbered steps.",
    type: "explicit", scope: "global", importance: 0.9, confidence: 0.9,
    novelty: 0.9, stability: 0.9, createdAt: now, updatedAt: now, deleted: false,
  });
} else if (mode === "events") {
  const { readdir } = await import("node:fs/promises");
  const { JSONLEventStore } = await fromRoot("packages/events/dist/event-store.js");
  const store = new JSONLEventStore({ dataDir: target });
  const sessions = (await readdir(target)).filter((name) => /^session_.*\.jsonl$/.test(name));
  const events = [];
  for (const file of sessions.sort()) events.push(...await store.list(file.slice(0, -6)));
  process.stdout.write(`${JSON.stringify(events)}\n`);
} else if (mode === "direct") {
  const { OpenAICompatibleProvider } = await fromRoot("packages/model/dist/openai.js");
  const provider = new OpenAICompatibleProvider({
    apiKey: "local-non-secret-placeholder", baseUrl: target, modelId: "system-context-probe",
    requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 5000 },
  });
  const client = provider.createClient({ providerId: "openai", modelId: "system-context-probe" }, {});
  const message = (role, content) => ({ id: "message_fixture", sessionId: "session_fixture", role, content, createdAt: 0 });
  const requests = [
    { system, messages: [message("user", "USER_MARKER")] },
    { system, messages: [message("system", "HISTORY_SYSTEM_MARKER"), message("user", "USER_MARKER")] },
    { messages: [message("system", "HISTORY_SYSTEM_MARKER"), message("user", "USER_MARKER")] },
    { system: "", messages: [message("user", "USER_MARKER")] },
    { messages: [message("user", "USER_MARKER")] },
  ];
  const outputs = [];
  for (const request of requests) {
    const events = [];
    for await (const event of client.generate(request, new AbortController().signal)) events.push(event);
    outputs.push({ request, events });
  }
  process.stdout.write(`${JSON.stringify(outputs)}\n`);
} else {
  throw new Error(`unknown probe mode: ${mode}`);
}
