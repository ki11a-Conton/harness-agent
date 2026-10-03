/** Actual local HTTP and keyless CLI probes. No live model, key, or paid call.
 * Run after building the selected checkout:
 * node scripts/research/agent-measurement-20261003/provider-policy.mjs --repo <checkout> --out <external evidence directory>
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const flags = process.argv.slice(2);
const value = name => {
  const index = flags.indexOf(name);
  if (index < 0 || !flags[index + 1]) throw new Error(`required ${name}`);
  return flags[index + 1];
};
const repo = resolve(value("--repo"));
const out = resolve(value("--out"));
await mkdir(out, { recursive: true });
const models = await import(pathToFileURL(join(repo, "packages/model/dist/index.js")).href);
const git = args => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const fingerprints = {};
for (const relative of ["packages/model/src/openai.ts", "packages/model/dist/openai.js", "apps/cli/src/benchmark-command.ts", "apps/cli/dist/benchmark-command.js", "packages/model/src/openai-request-policy.test.ts", "apps/cli/src/benchmark-provider-policy.test.ts"]) {
  try { fingerprints[relative] = createHash("sha256").update(await readFile(join(repo, relative))).digest("hex"); }
  catch (error) { if (error.code !== "ENOENT") throw error; fingerprints[relative] = null; }
}
const request = { messages: [{ id: "m", sessionId: "s", createdAt: 0, role: "user", content: "offline policy probe" }] };
const envNames = ["OPENAI_MAX_RETRIES", "OPENAI_RETRY_DELAY_MS", "OPENAI_REQUEST_TIMEOUT_MS"];
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const setPolicyEnv = policy => {
  process.env.OPENAI_MAX_RETRIES = String(policy.maxProviderRetries);
  process.env.OPENAI_RETRY_DELAY_MS = String(policy.retryDelayMs);
  process.env.OPENAI_REQUEST_TIMEOUT_MS = String(policy.requestTimeoutMs);
};
const restorePolicyEnv = () => {
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
};

async function actualHttp({ name, policy, laterEnv, wrapper = false, mutateOriginal = false, config = {}, hanging = false }) {
  let physicalHttp = 0;
  let closedResponses = 0;
  const server = createServer((req, res) => {
    physicalHttp++;
    req.resume();
    res.on("close", () => { closedResponses++; });
    req.on("end", () => {
      if (hanging) return;
      if (physicalHttp <= 2) { res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"error":"offline transient fixture"}'); }
      else { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end('data: {"choices":[{"delta":{"content":"offline"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }
    });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const recordedPolicy = { ...policy };
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  let provider = new models.OpenAICompatibleProvider({ apiKey: "offline-not-a-credential", baseUrl: endpoint, ...(wrapper ? {} : { requestPolicy: policy }) });
  if (wrapper && typeof models.withOpenAIRequestPolicy === "function") provider = models.withOpenAIRequestPolicy(provider, policy);
  if (mutateOriginal) policy.maxProviderRetries = 9;
  setPolicyEnv(laterEnv);
  const caller = new AbortController();
  const fallback = setTimeout(() => caller.abort(), 1000);
  const events = [];
  try {
    for await (const event of provider.createClient({ providerId: "openai", modelId: "offline-fixture" }, config).generate(request, caller.signal)) {
      events.push({ type: event.type, ...(event.type === "completed" ? { finishReason: event.result.finishReason } : {}) });
    }
    await new Promise(done => setTimeout(done, 20));
    return { name, policy: recordedPolicy, laterEnv, physicalHttp, transportRetries: events.filter(event => event.type === "retry").length,
      events, callerFallbackUsed: caller.signal.aborted, closedResponses, wrapper, mutatedOriginal: mutateOriginal, externalBilledCalls: 0 };
  } finally {
    clearTimeout(fallback);
    server.closeAllConnections();
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    restorePolicyEnv();
  }
}

const probes = [];
probes.push(await actualHttp({ name: "frozen-zero-retry", policy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 2000 }, laterEnv: { maxProviderRetries: 2, retryDelayMs: 0, requestTimeoutMs: 2000 }, mutateOriginal: true }));
probes.push(await actualHttp({ name: "frozen-two-retries", policy: { maxProviderRetries: 2, retryDelayMs: 0, requestTimeoutMs: 2000 }, laterEnv: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 2000 } }));
probes.push(await actualHttp({ name: "wrapper-enforces-confirmed-policy", policy: { maxProviderRetries: 2, retryDelayMs: 0, requestTimeoutMs: 2000 }, laterEnv: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 2000 }, wrapper: true, mutateOriginal: true, config: { maxProviderRetries: 0 } }));
probes.push(await actualHttp({ name: "frozen-timeout", policy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 50 }, laterEnv: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 0 }, hanging: true }));

const cases = join(out, "cases");
await mkdir(join(cases, "single"), { recursive: true });
await writeFile(join(cases, "single", "request.md"), "Reply once with OK.");
await writeFile(join(cases, "single", "expected.md"), "No artifact required.");
const command = ["apps/cli/dist/main.js", "benchmark", "--cases", cases, "--out", join(out, "keyless-output"), "--dry-run", "--provider", "openai", "--model", "offline-fixture", "--max-logical-runs", "1", "--max-model-calls", "10"];
const keyless = [];
for (const policy of [{ maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 1000 }, { maxProviderRetries: 9, retryDelayMs: 0, requestTimeoutMs: 1000 }, { maxProviderRetries: 0, retryDelayMs: 900, requestTimeoutMs: 1000 }, { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 120000 }]) {
  const env = { ...process.env, OPENAI_API_KEY: "", OPENAI_MODEL: "", RUN_PAID_BENCHMARKS: "0", OPENAI_MAX_RETRIES: String(policy.maxProviderRetries), OPENAI_RETRY_DELAY_MS: String(policy.retryDelayMs), OPENAI_REQUEST_TIMEOUT_MS: String(policy.requestTimeoutMs) };
  const result = spawnSync(process.execPath, command, { cwd: repo, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`keyless dry-run exited ${result.status}`);
  const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  keyless.push({ policy, planDigest: parsed.planDigest, effectiveModelParams: parsed.effectiveModelParams, providerCalls: parsed.providerCalls, sourceSha: parsed.sourceSha, treeFingerprint: parsed.treeFingerprint });
}

const checks = {
  constructorZeroRetriesFrozen: probes[0].physicalHttp === 1 && probes[0].transportRetries === 0,
  constructorTwoRetriesFrozen: probes[1].physicalHttp === 3 && probes[1].transportRetries === 2,
  wrapperPolicyFrozen: probes[2].physicalHttp === 3 && probes[2].transportRetries === 2,
  timeoutFrozen: probes[3].physicalHttp === 1 && !probes[3].callerFallbackUsed && probes[3].events.some(event => event.type === "error"),
  eachPolicyChangesKeylessDigest: new Set(keyless.map(row => row.planDigest)).size === keyless.length,
  keylessZeroProviderCalls: keyless.every(row => row.providerCalls === 0),
};
const manifest = { schemaVersion: "agent-measurement-provider-policy-v1", purpose: "actual local HTTP and keyless CLI execution-policy identity", sourceSha: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "", sourceAndBuildSha256: fingerprints,
  environment: { node: process.version, platform: process.platform, arch: process.arch }, measuredAt: new Date().toISOString(), resolverAvailable: typeof models.resolveOpenAIRequestPolicy === "function", frozenWrapperAvailable: typeof models.withOpenAIRequestPolicy === "function",
  probes, keyless, checks, passed: Object.values(checks).every(Boolean), paidCalls: 0, realModelBenefit: "NOT_RUN", promotion: "NOT_RUN", limitation: "generate attempt caps and planning estimates do not establish physical HTTP or USD caps" };
await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ sourceSha: manifest.sourceSha, dirty: manifest.dirty, checks, passed: manifest.passed, paidCalls: 0 }));
process.exitCode = manifest.passed ? 0 : 1;
