/** Observe errors and usage at the provider boundary, including recovered retries. */
import { assert, digest, SOAK_CALLS } from "./execution-common.mjs";

export function errorKind(error) {
  const e = error?.error ?? error ?? {};
  const message = String(e.message ?? "");
  if (/model_not_found/i.test(message) || e.provider?.code === "model_not_found") return "model_not_found";
  if (["network", "timeout", "server_error", "rate_limit"].includes(e.provider?.kind) || e.provider?.status >= 500 ||
    /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network error|getaddrinfo/i.test(message)) return "transport";
  return "provider_error";
}
function validCount(n) { return Number.isSafeInteger(n) && n >= 0; }
export function redactRequest(request, secrets = []) {
  let text = JSON.stringify(request);
  for (const secret of secrets.filter(s => typeof s === "string" && s.length >= 4)) text = text.split(secret).join("[REDACTED]");
  return JSON.parse(text);
}
export function observedProvider(provider, { record = () => {}, scope = () => null, secrets = [], initialRecords = [] } = {}) {
  const records = [...initialRecords];
  return { records, provider: { id: provider.id, listModels: () => provider.listModels(), createClient(model, config) {
    const inner = provider.createClient(model, config);
    return { async *generate(request, signal) {
      const captured = redactRequest(request, secrets);
      const item = { requestId: records.length + 1, scope: scope(), requestDigest: digest(captured),
        request: captured, modelId: model.modelId, completed: false, usage: null, retries: [], failure: null, toolCalls: [] };
      records.push(item);
      let usage = {};
      try {
        for await (const event of inner.generate(request, signal)) {
          if (event.type === "retry") item.retries.push(errorKind(event.error));
          if (event.type === "usage") usage = { ...usage, ...event.usage };
          if (event.type === "error") item.failure = errorKind(event.error);
          if (event.type === "completed") {
            item.completed = !["error", "cancelled"].includes(event.result.finishReason);
            item.toolCalls = redactRequest(event.result.toolCalls ?? [], secrets);
            usage = { ...usage, ...event.result.usage };
          }
          yield event;
        }
      } catch (error) { item.failure = errorKind(error); throw error; }
      finally {
        if (!item.completed && item.failure === null) item.failure = "incomplete_stream";
        if (validCount(usage.inputTokens) && validCount(usage.outputTokens) && usage.source !== "unknown")
          item.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
        await record(item);
      }
    } };
  } } };
}
export function infrastructureCounts(records) {
  return { generateCalls: records.length, physicalAttempts: records.length + records.reduce((n, r) => n + r.retries.length, 0),
    retries: records.reduce((n, r) => n + r.retries.length, 0),
    transportFailures: records.reduce((n, r) => n + r.retries.filter(k => k === "transport").length + Number(r.failure === "transport"), 0),
    modelNotFound: records.reduce((n, r) => n + r.retries.filter(k => k === "model_not_found").length + Number(r.failure === "model_not_found"), 0),
    incompleteUsage: records.filter(r => r.usage === null).length, failedCalls: records.filter(r => !r.completed || r.failure !== null).length };
}
export function soakVerdict(records) {
  const counts = infrastructureCounts(records);
  return { counts, passed: counts.generateCalls === SOAK_CALLS && counts.transportFailures === 0 && counts.modelNotFound === 0 &&
    counts.failedCalls === 0 && counts.incompleteUsage === 0 && counts.retries === 0 };
}
export async function runSoak(provider, { modelId, signal = () => AbortSignal.timeout(120000), onRecord, beforeCall = () => {} } = {}) {
  assert(typeof modelId === "string" && modelId.length > 0, "MODEL_REQUIRED");
  const observed = observedProvider(provider, { record: onRecord });
  const client = observed.provider.createClient({ providerId: provider.id, modelId }, {});
  for (let i = 0; i < SOAK_CALLS; i++) {
    await beforeCall(i);
    try {
      for await (const event of client.generate({ messages: [{ id: `n7-soak-${i}`, sessionId: "n7-soak", role: "user", content: "Reply OK.", createdAt: 0 }] }, signal())) {
        // Consume the actual provider stream; no fake usage or synthetic completion.
        if (event.type === "error") break;
      }
    } catch { /* item records the category; no sensitive error text is persisted */ }
    const last = observed.records.at(-1);
    if (!last?.completed || last.failure !== null || last.usage === null || last.retries.length !== 0) break;
  }
  return { records: observed.records, ...soakVerdict(observed.records) };
}
