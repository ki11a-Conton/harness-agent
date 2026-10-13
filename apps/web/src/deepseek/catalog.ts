import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { z } from "zod";
import type { ModelInfo, ModelProvider, SessionId, ToolDefinition, ToolResult } from "@ar/contracts";
import type { Harness } from "@ar/harness";
import { RemoteFailure } from "./transport.js";

export interface CatalogSelection { provider: string; model: string; reasoningEffort?: string }
export interface ModelProfile {
  api?: "openai-completions";
  displayName?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; input?: Array<"text"> }>;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
}
export interface ResolvedModelProfile extends ModelProfile { apiKey?: string }
export interface CatalogHost {
  harness: Harness;
  cwd: string;
  dataDir?: string;
  providers?: readonly ModelProvider[];
  /** Actual launch facts, supplied by the composition root rather than guessed from private provider state. */
  initialProviderProfiles?: Readonly<Record<string, ModelProfile>>;
  initialCredentials?: Readonly<Record<string, string>>;
  environment?: Readonly<Record<string, string | undefined>>;
  executeHostTool(sessionId: string | undefined, definition: ToolDefinition, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  registerTool?(definition: ToolDefinition): void;
  executeTool?(sessionId: string | undefined, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  /** Validate availability for fresh sessions. Existing sessions retain their frozen model/provider. */
  validateModelProfiles?(profiles: Readonly<Record<string, ModelProfile>>, signal: AbortSignal): Promise<void>;
  /** Pure host validation before commit; the maps contain secrets and must never be logged or returned remotely. */
  validateCredentials?(values: Readonly<Record<string, string>>, prior: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void>;
  selectModel?(sessionId: string, selection: CatalogSelection, signal: AbortSignal): Promise<CatalogSelection>;
  openSettingsDocument?(path: string, signal: AbortSignal): Promise<void>;
  publish?(topic: string, args: readonly unknown[]): void;
}

const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROUTE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DOCUMENT = 1024 * 1024;
const chains = new Map<string, Promise<void>>();
const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function ownString(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const current = Object.hasOwn(value, key) ? value[key] : undefined;
  return typeof current === "string" && current.length > 0 ? current : undefined;
}
function bad(message: string): never { throw new RemoteFailure("gateway/bad-request", message); }
function object(value: unknown): Record<string, unknown> { if (!record(value)) bad("Expected an object"); return value; }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) bad("Invalid request fields");
}
function text(value: unknown, field: string, maximum = 1000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) bad(`Invalid ${field}`);
  return value;
}
function ref(value: unknown): string { const name = text(value, "credential reference", 200); if (!REF.test(name) || UNSAFE.has(name)) bad("Invalid credential reference"); return name; }
function json(value: unknown, depth = 0): void {
  if (depth > 30) bad("Settings are nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) { if (value.length > 1000) bad("Settings array is too large"); for (const item of value) json(item, depth + 1); return; }
  if (!record(value)) bad("Settings require JSON values");
  for (const [key, child] of Object.entries(value)) { if (UNSAFE.has(key)) bad("Unsafe settings path"); json(child, depth + 1); }
}
function endpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new RemoteFailure("settings/rejected", "Model endpoint must be an absolute HTTP URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RemoteFailure("settings/rejected", "Model endpoint must be HTTP without embedded credentials, query or fragment");
  }
  return parsed.href.replace(/\/+$/u, "");
}
async function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new RemoteFailure("gateway/cancelled", "Catalog operation was cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

// MIT adaptations of DeepSeek Harness's shared settings fields and llm-pi-ai
// profile schema at 5badb15009ae1756c3afe0ae0cef1faafc290ccc. The protocol
// and modality unions deliberately describe only the adapters this host serves.
// Original source: https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages
// License is retained in public/deepseek/licenses/upstream-source-reference/LICENSE.
const modelFields = {
  id: Schema.string().required(), name: Schema.string(),
  contextWindow: Schema.number().step(1).min(1), maxTokens: Schema.number().step(1).min(1),
  input: Schema.array(Schema.union(["text"])),
};
const profileSchema = Schema.object({
  apiKeyEnv: Schema.string().role("credential-ref"), displayName: Schema.string(),
  api: Schema.union(["openai-completions"]), baseURL: Schema.string(),
  models: Schema.array(Schema.object(modelFields)),
  defaultContextWindow: Schema.number().step(1).min(1), defaultMaxTokens: Schema.number().step(1).min(1),
});
const schemas = {
  "llm-pi-ai": Schema.object({ providers: Schema.dict(profileSchema).default({}).volatile() }),
  locale: Schema.object({ preference: Schema.string().pattern(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u).required(false) }),
  "ui-theme": Schema.object({ preference: Schema.union(["light", "dark", "system"]).default("system"), fontSize: Schema.number().step(1).min(10).max(22).default(14) }),
  "ui-conversation": Schema.object({ busyEnter: Schema.union(["queue", "steer"]).default("queue") }),
  "ui-chat": Schema.object({
    transcriptView: Schema.union(["compact", "standard", "detailed", "verbose", "normal", "expanded"]).loose(),
    performanceUsage: Schema.union(["compact", "detailed"]).default("detailed"),
    linkOpening: Schema.union(["sidebar", "new-tab"]).default("sidebar"),
  }),
  "ui-settings": Schema.object({ enabled: Schema.boolean().default(true) }),
  "ui-settings-general": Schema.object({ welcomeNoticeVersion: Schema.string().volatile() }),
};
type Namespace = keyof typeof schemas;
const profileValidation = z.object({
  apiKeyEnv: z.string().regex(REF).refine(value => !UNSAFE.has(value)).optional(), displayName: z.string().min(1).max(200).optional(),
  api: z.literal("openai-completions").optional(), baseURL: z.string().min(1).max(2000).optional(),
  models: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200).optional(),
    contextWindow: z.number().int().positive().safe().optional(), maxTokens: z.number().int().positive().safe().optional(),
    input: z.array(z.literal("text")).min(1).max(1).optional() }).strict()).min(1).max(1000).optional(),
  defaultContextWindow: z.number().int().positive().safe().optional(), defaultMaxTokens: z.number().int().positive().safe().optional(),
}).strict();
const validation = {
  "llm-pi-ai": z.object({ providers: z.record(profileValidation).optional() }).strict(),
  locale: z.object({ preference: z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u).optional() }).strict(),
  "ui-theme": z.object({ preference: z.enum(["light", "dark", "system"]).optional(), fontSize: z.number().int().min(10).max(22).optional() }).strict(),
  "ui-conversation": z.object({ busyEnter: z.enum(["queue", "steer"]).optional() }).strict(),
  "ui-chat": z.object({
    transcriptView: z.enum(["compact", "standard", "detailed", "verbose", "normal", "expanded"]).nullable().optional(),
    performanceUsage: z.enum(["compact", "detailed"]).optional(),
    linkOpening: z.enum(["sidebar", "new-tab"]).optional(),
  }).strict(),
  "ui-settings": z.object({ enabled: z.boolean().optional() }).strict(),
  "ui-settings-general": z.object({ welcomeNoticeVersion: z.string().max(200).optional() }).strict(),
};
interface SettingsDocument { version: 1; namespaces: Partial<Record<Namespace, { revision: number; user: Record<string, unknown> }>> }
interface CredentialDocument { version: 1; revision: number; values: Record<string, string> }
interface NamespaceView { ns: string; autoGenerate: boolean; schema: unknown; value: Record<string, unknown>; base: Record<string, unknown>; user?: Record<string, unknown>; applies: "live"; secrets: never[]; revision: number }

function merge(base: Record<string, unknown>, user: Record<string, unknown>): Record<string, unknown> {
  const result = clone(base);
  for (const [key, value] of Object.entries(user)) result[key] = record(value) && record(result[key]) ? merge(result[key], value) : clone(value);
  return result;
}
function mutation(section: Record<string, unknown>, operations: unknown): Record<string, unknown> {
  if (!Array.isArray(operations) || operations.length > 100) bad("Invalid settings operations");
  let result = clone(section);
  for (const raw of operations) {
    const op = object(raw); keys(op, ["op", "path"], op.op === "set" ? ["value"] : []);
    if (op.op !== "set" && op.op !== "unset") bad("Invalid settings operation");
    if (op.op === "set" && !Object.hasOwn(op, "value")) bad("Missing settings value");
    if (!Array.isArray(op.path) || op.path.length > 20 || op.path.some(item => typeof item !== "string" || item.length === 0 || item.length > 200 || UNSAFE.has(item))) bad("Unsafe settings path");
    const path = op.path as string[];
    if (path.length === 0) { if (op.op === "unset") result = {}; else { json(op.value); result = clone(object(op.value)); } continue; }
    let target: Record<string, unknown> | unknown[] = result;
    for (let index = 0; index < path.length - 1; index++) {
      const key = path[index]!;
      let value = (target as Record<string, unknown>)[key];
      if (!record(value) && !Array.isArray(value)) { value = /^\d+$/u.test(path[index + 1]!) ? [] : {}; (target as Record<string, unknown>)[key] = value; }
      target = value as Record<string, unknown> | unknown[];
    }
    const leaf = path.at(-1)!;
    if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/u.test(leaf) || Number(leaf) > 1000)) bad("Invalid settings array index");
    if (op.op === "set") { json(op.value); (target as Record<string, unknown>)[leaf] = clone(op.value); }
    else if (Array.isArray(target)) target.splice(Number(leaf), 1);
    else delete target[leaf];
  }
  return result;
}

/** Official settings/credentials/model DTOs backed by private controlled tools. */
export function createCatalogService(host: CatalogHost) {
  const providers = [...host.providers ?? [host.harness.config.modelProvider]];
  const environment = { ...host.environment ?? process.env };
  const launchKeys = { ...host.initialCredentials };
  const initialProfiles: Record<string, ModelProfile> = {};
  for (const [name, value] of Object.entries(host.initialProviderProfiles ?? {})) {
    const parsed = profileValidation.safeParse(value);
    if (!ROUTE.test(name) || UNSAFE.has(name) || !parsed.success) throw new RemoteFailure("settings/rejected", "Invalid initial model profile");
    if (parsed.data.baseURL !== undefined) endpoint(parsed.data.baseURL);
    initialProfiles[name] = parsed.data;
  }
  for (const [name, value] of Object.entries(launchKeys)) if (!REF.test(name) || UNSAFE.has(name) || !value || value.length > 64_000 || /[\r\n\u0000]/u.test(value)) throw new RemoteFailure("credential/rejected", "Invalid initial credential");
  const settingsPath = join(resolve(host.dataDir ?? host.cwd), "deepseek", "settings.json");
  const credentialPath = join(resolve(host.dataDir ?? host.cwd), "deepseek", "credentials.json");
  let memorySettings: SettingsDocument = { version: 1, namespaces: {} };
  let memoryCredentials: CredentialDocument = { version: 1, revision: 0, values: {} };
  const defaults: Record<Namespace, Record<string, unknown>> = {
    "llm-pi-ai": { providers: clone(initialProfiles) }, locale: {},
    "ui-theme": { preference: "system", fontSize: 14 }, "ui-conversation": { busyEnter: "queue" },
    "ui-chat": { performanceUsage: "detailed", linkOpening: "sidebar" }, "ui-settings": { enabled: true }, "ui-settings-general": {},
  };
  const discoverySecrets = new Map<string, string | undefined>();

  async function document<T extends SettingsDocument | CredentialDocument>(kind: "settings" | "credentials", signal: AbortSignal, mutate?: (current: T) => Promise<void>): Promise<T> {
    const path = kind === "settings" ? settingsPath : credentialPath;
    const key = host.dataDir === undefined ? `${path}:memory:${instance}` : path;
    const previous = chains.get(key) ?? Promise.resolve();
    let release!: () => void; const pending = new Promise<void>(done => { release = done; }); chains.set(key, pending);
    // The caller can leave promptly, but this slot cannot release ahead of
    // its predecessor. An aborted queued mutation still waits its turn inside
    // the private owner, checks cancellation, then releases without writing.
    const operation = (async (): Promise<T> => {
    await previous;
    try {
      signal.throwIfAborted(); let captured: T | undefined; let refusal: RemoteFailure | undefined;
      const definition: ToolDefinition = { name: `web_${kind}_${mutate === undefined ? "read" : "write"}`, description: "Access the fixed host configuration document",
        inputSchema: z.object({ path: z.literal(path) }).strict(), risk: mutate === undefined ? "readonly" : "side_effect",
        metadata: { name: `web_${kind}_${mutate === undefined ? "read" : "write"}`, version: "1", filesystem: true, sideEffect: mutate !== undefined, process: false, network: false, interactive: false, concurrencySafe: false, retry: mutate === undefined ? "safe" : "none" },
        async execute() {
          let current: T;
          if (host.dataDir === undefined) current = clone(kind === "settings" ? memorySettings : memoryCredentials) as T;
          else {
            try {
              const value: unknown = JSON.parse(await readDocument(path, kind, signal));
              current = validateDocument(kind, value) as T;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read private configuration document");
              current = clone(kind === "settings" ? { version: 1, namespaces: {} } : { version: 1, revision: 0, values: {} }) as T;
            }
          }
          try { await mutate?.(current); } catch (error) {
            if (error instanceof RemoteFailure) refusal = error;
            // Domain refusals are captured outside the tool; generic event errors cannot carry input values.
            throw new Error("Private configuration mutation was rejected");
          }
          signal.throwIfAborted();
          if (mutate !== undefined) {
            if (host.dataDir === undefined) { if (kind === "settings") memorySettings = clone(current as SettingsDocument); else memoryCredentials = clone(current as CredentialDocument); }
            else await save(path, current, signal);
          }
          captured = clone(current);
          // Raw credentials never enter a ToolResult, evidence preview, event, or Remote return.
          return { status: "success", output: { version: 1, ...(kind === "credentials" ? { revision: (current as CredentialDocument).revision } : {}) } };
        },
      };
      const result = await host.executeHostTool(undefined, definition, { path }, signal);
      if (result.status !== "success" || captured === undefined) throw refusal ?? new RemoteFailure(kind === "settings" ? "settings/rejected" : "credential/rejected", "Private configuration operation was refused");
      return captured;
    } finally { release(); if (chains.get(key) === pending) chains.delete(key); }
    })();
    return interruptible(operation, signal);
  }
  const instance = randomUUID();

  function namespace(ns: unknown): Namespace { const name = text(ns, "namespace", 100); if (!Object.hasOwn(schemas, name)) throw new RemoteFailure("settings/rejected", "Settings namespace is not registered", { ns: name }); return name as Namespace; }
  function view(ns: Namespace, document: SettingsDocument): NamespaceView {
    const row = document.namespaces[ns]; const base = clone(defaults[ns]);
    return { ns, autoGenerate: false, schema: schemas[ns].toJSON(),
      value: merge(base, row?.user ?? {}), base, ...(row === undefined ? {} : { user: clone(row.user) }), applies: "live", secrets: [], revision: row?.revision ?? 0 };
  }
  async function profiles(signal: AbortSignal): Promise<Record<string, ModelProfile>> {
    const current = await document<SettingsDocument>("settings", signal);
    return clone(view("llm-pi-ai", current).value.providers ?? {}) as Record<string, ModelProfile>;
  }
  function credential(ref: string, document: CredentialDocument) {
    if (ownString(environment, ref) !== undefined) return { configured: true, source: "env", writable: false };
    if (ownString(launchKeys, ref) !== undefined) return { configured: true, source: "launch", writable: false };
    return ownString(document.values, ref) !== undefined ? { configured: true, source: "file", writable: true } : { configured: false, writable: true };
  }
  async function resolvedModelProfiles(signal: AbortSignal): Promise<Record<string, ResolvedModelProfile>> {
    const current = await profiles(signal); const keys = await document<CredentialDocument>("credentials", signal);
    return Object.fromEntries(Object.entries(current).map(([name, profile]) => {
      const secret = profile.apiKeyEnv === undefined ? undefined : ownString(environment, profile.apiKeyEnv) ?? ownString(launchKeys, profile.apiKeyEnv) ?? ownString(keys.values, profile.apiKeyEnv);
      return [name, { ...profile, ...(secret === undefined ? {} : { apiKey: secret }) }];
    }));
  }
  async function writeSettings(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): Promise<NamespaceView> {
    const field = endpoint === "settings/update" ? "patch" : endpoint === "settings/replace" ? "section" : "ops";
    keys(args, ["ns", field], ["expectedRevision"]); const ns = namespace(args.ns);
    if (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0)) bad("Invalid settings revision");
    const current = await document<SettingsDocument>("settings", signal, async data => {
      const prior = data.namespaces[ns]; const revision = prior?.revision ?? 0;
      if (args.expectedRevision !== undefined && args.expectedRevision !== revision) throw new RemoteFailure("settings/conflict", "Settings revision changed", { ns, expected: Number(args.expectedRevision), actual: revision });
      let user: Record<string, unknown>;
      if (field === "ops") user = mutation(prior?.user ?? {}, args.ops);
      else { json(args[field]); user = field === "patch" ? merge(prior?.user ?? {}, object(args.patch)) : clone(object(args.section)); }
      if (!validation[ns].safeParse(user).success) throw new RemoteFailure("settings/rejected", "Configuration does not match the supported schema", { ns });
      const value = merge(defaults[ns], user);
      if (ns === "llm-pi-ai") {
        const selected = value.providers as Record<string, ModelProfile>;
        for (const [name, profile] of Object.entries(selected ?? {})) {
          if (!ROUTE.test(name) || UNSAFE.has(name)) throw new RemoteFailure("settings/rejected", "Invalid provider route", { ns });
          if (profile.baseURL !== undefined) endpointUrl(profile.baseURL);
          if (profile.models !== undefined && new Set(profile.models.map(model => model.id)).size !== profile.models.length) throw new RemoteFailure("settings/rejected", "Provider contains duplicate model ids", { ns });
          if (!providers.some(provider => provider.id === name) && (profile.baseURL === undefined || profile.api !== "openai-completions" || !profile.models?.length)) throw new RemoteFailure("settings/rejected", "A new provider requires its endpoint, supported protocol and models", { ns });
        }
        if (host.validateModelProfiles === undefined) throw new RemoteFailure("settings/rejected", "Fresh-session model configuration owner is unavailable", { ns });
        await host.validateModelProfiles(selected, signal);
      }
      data.namespaces[ns] = { revision: revision + 1, user };
    });
    const result = view(ns, current);
    host.publish?.("settings/document-updated", [ns, result.revision]);
    if (ns === "llm-pi-ai") host.publish?.("llm/adapters-updated", []);
    return result;
  }

  function endpointUrl(value: string): string { return endpoint(value); }
  async function modelCatalog(signal: AbortSignal) {
    // A declared route becomes selectable only after the production factory
    // can obtain the adapter's endpoint, protocol, model and actual credential.
    // The resolver's secret values remain host-only; only safe DTO fields below
    // enter the Remote catalog.
    const configured = await resolvedModelProfiles(signal);
    const groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> = [];
    const failures: Array<{ id: string; name: string; message: string }> = [];
    for (const provider of providers) {
      signal.throwIfAborted();
      try {
        const listed = await interruptible(provider.listModels(), signal); signal.throwIfAborted();
        const actual: ModelInfo[] = listed.filter(model => typeof model.id === "string" && model.id.length > 0);
        // An empty discovery API does not erase the actual deployment's explicitly configured route.
        if (provider.id === host.harness.config.model.providerId && !actual.some(model => model.id === host.harness.config.model.modelId)) actual.push({ id: host.harness.config.model.modelId });
        for (const model of configured[provider.id]?.models ?? []) if (!actual.some(item => item.id === model.id)) actual.push({ id: model.id, name: model.name });
        if (actual.length > 0) groups.push({ id: provider.id, name: configured[provider.id]?.displayName ?? provider.id, models: actual.map(model => ({ id: model.id, name: model.name ?? model.id })) });
      } catch { signal.throwIfAborted(); failures.push({ id: provider.id, name: provider.id, message: "Provider model catalog could not be loaded" }); }
    }
    if (host.validateModelProfiles !== undefined) for (const [name, profile] of Object.entries(configured)) {
      if (groups.some(group => group.id === name) || providers.some(provider => provider.id === name) || !profile.models?.length) continue;
      if (profile.api !== "openai-completions" || !profile.baseURL || !profile.apiKey) {
        failures.push({ id: name, name: profile.displayName ?? name, message: "The configured adapter or credential is unavailable" });
        continue;
      }
      groups.push({ id: name, name: profile.displayName ?? name, models: profile.models.map(model => ({ id: model.id, name: model.name ?? model.id })) });
    }
    return { default: { provider: host.harness.config.model.providerId, model: host.harness.config.model.modelId }, routableProviders: groups.map(group => group.id), groups, failures };
  }

  const discoveryTool: ToolDefinition = {
    name: "web_model_discovery", description: "Read a model catalog from one explicitly requested provider endpoint", risk: "readonly",
    inputSchema: z.object({ url: z.string().url(), ticket: z.string().uuid() }).strict(),
    metadata: { name: "web_model_discovery", version: "1", network: true, sideEffect: false, filesystem: false, process: false, interactive: false, concurrencySafe: true, retry: "safe" },
    async execute(input, context) {
      const { url, ticket } = input as { url: string; ticket: string };
      if (!discoverySecrets.has(ticket)) return { status: "failed", error: { code: "TOOL_SCHEMA_ERROR", message: "Discovery ticket is unavailable", retryable: false, safeToRetry: false } };
      const secret = discoverySecrets.get(ticket); const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
      try {
        const response = await fetch(url, { signal, redirect: "error", headers: secret === undefined ? {} : { Authorization: `Bearer ${secret}` } });
        if (!response.ok || response.body === null) throw new Error("Provider model discovery was refused");
        const chunks: Uint8Array[] = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.byteLength; if (size > MAX_DOCUMENT) throw new Error("Provider model catalog is too large"); chunks.push(chunk); }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!record(body) || !Array.isArray(body.data) || body.data.length > 1000) throw new Error("Invalid provider model catalog");
        const seen = new Set<string>(); const models: Array<{ id: string; name?: string }> = [];
        for (const item of body.data) {
          if (!record(item) || typeof item.id !== "string" || item.id.length === 0 || item.id.length > 200 || seen.has(item.id) || (secret !== undefined && item.id.includes(secret))) continue;
          seen.add(item.id); models.push({ id: item.id, ...(typeof item.name === "string" && item.name.length <= 200 && (secret === undefined || !item.name.includes(secret)) ? { name: item.name } : {}) });
        }
        return { status: "success", output: models };
      } catch { return { status: "failed", error: { code: "MODEL_ERROR", message: "Provider model discovery failed", retryable: false, safeToRetry: false } }; }
    },
  };
  host.registerTool?.(discoveryTool);

  const endpoints = ["settings/describe", "settings/update", "settings/replace", "settings/mutate", "settings/openSettingsDocument",
    "credentials/describe", "credentials/set", "credentials/unset", "llm/listProviders", "llm/listConfigurableProviders", "llm/discoverModels", "session/modelCatalog", "session/selectModel"];
  return { endpoints, resolvedModelProfiles,
    async call(name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
      signal.throwIfAborted(); const args = object(input ?? {});
      if (name === "settings/describe") { keys(args, []); const current = await document<SettingsDocument>("settings", signal); return { writable: true, hasDocument: host.dataDir !== undefined, namespaces: (Object.keys(schemas) as Namespace[]).map(ns => view(ns, current)) }; }
      if (["settings/update", "settings/replace", "settings/mutate"].includes(name)) return writeSettings(name, args, signal);
      if (name === "settings/openSettingsDocument") {
        keys(args, []);
        if (host.dataDir === undefined || host.openSettingsDocument === undefined) throw new RemoteFailure("gateway/internal", "The host has no native settings document opener");
        await document<SettingsDocument>("settings", signal, async () => {});
        await host.openSettingsDocument(settingsPath, signal); signal.throwIfAborted(); return { opened: true };
      }
      if (name === "credentials/describe") {
        keys(args, ["refs"]); if (!Array.isArray(args.refs) || args.refs.length > 64) bad("Credential description batch is too large");
        const names = args.refs.map(value => ref(value)); const current = await document<CredentialDocument>("credentials", signal);
        return Object.fromEntries(names.map(name => [name, credential(name, current)]));
      }
      if (name === "credentials/set" || name === "credentials/unset") {
        keys(args, ["ref"], name === "credentials/set" ? ["value"] : []); const nameRef = ref(args.ref);
        if (name === "credentials/set") { text(args.value, "credential value", 64_000); if (/[\r\n\u0000]/u.test(args.value as string)) bad("Credential must be a single-line value"); }
        const current = await document<CredentialDocument>("credentials", signal, async data => {
          if (!credential(nameRef, data).writable) throw new RemoteFailure("credential/rejected", "A read-only launch or environment source shadows this credential", { ref: nameRef });
          const prior = clone(data.values);
          if (name === "credentials/set") data.values[nameRef] = args.value as string; else delete data.values[nameRef];
          await host.validateCredentials?.(clone(data.values), prior, signal);
          data.revision++;
        });
        void current; host.publish?.("credentials/reference-updated", [nameRef]); return;
      }
      if (name === "llm/listProviders") {
        keys(args, []); const configured = await profiles(signal);
        const registered = providers.map(provider => ({ id: provider.id, name: configured[provider.id]?.displayName ?? provider.id }));
        if (host.validateModelProfiles !== undefined) for (const [id, profile] of Object.entries(configured)) {
          if (!registered.some(provider => provider.id === id)) registered.push({ id, name: profile.displayName ?? id });
        }
        return registered;
      }
      if (name === "llm/listConfigurableProviders") {
        keys(args, []); const configured = await profiles(signal); const names = [...new Set([...providers.map(provider => provider.id), ...Object.keys(configured)])];
        return names.map(provider => ({ provider, displayName: configured[provider]?.displayName ?? provider, settingsNs: "llm-pi-ai", settingsPath: ["providers", provider], declared: !providers.some(item => item.id === provider) }));
      }
      if (name === "session/modelCatalog") { keys(args, []); return modelCatalog(signal); }
      if (name === "session/selectModel") {
        keys(args, ["request"]); const request = object(args.request); keys(request, ["sessionId", "provider", "model"], ["reasoningEffort"]);
        const id = text(request.sessionId, "sessionId", 200); const provider = text(request.provider, "provider", 200); const model = text(request.model, "model", 200);
        if (request.reasoningEffort !== undefined) throw new RemoteFailure("session/model-unavailable", "This provider does not declare selectable reasoning efforts", { provider, model });
        const owner = await host.harness.store.getSession(id as SessionId);
        if (owner === undefined || owner.status === "failed") throw new RemoteFailure("session/not-found", "Session is unavailable", { sessionId: id });
        const catalog = await modelCatalog(signal);
        if (!catalog.groups.some(group => group.id === provider && group.models.some(item => item.id === model))) throw new RemoteFailure("session/model-unavailable", "The requested model is not configured", { provider, model });
        const selected = { provider, model };
        if (host.selectModel !== undefined) return { selected: await host.selectModel(id, selected, signal) };
        if (owner.model.providerId !== provider || owner.model.modelId !== model) throw new RemoteFailure("session/model-unavailable", "This native session has a frozen model identity; create a fresh session to change models", { provider, model });
        return { selected };
      }
      if (name === "llm/discoverModels") {
        keys(args, ["settingsNs", "request"]); if (args.settingsNs !== "llm-pi-ai") throw new RemoteFailure("llm/model-discovery-rejected", "No discovery adapter owns this namespace", { settingsNs: String(args.settingsNs) });
        const request = object(args.request); keys(request, [], ["provider", "baseURL", "api", "apiKey"]);
        if (request.api !== undefined && request.api !== "openai-completions") throw new RemoteFailure("llm/model-discovery-rejected", "Unsupported model discovery protocol", { settingsNs: "llm-pi-ai" });
        if (request.provider !== undefined) {
          const provider = text(request.provider, "provider", 200); const native = providers.find(item => item.id === provider);
          if (native !== undefined && request.baseURL === undefined) {
            try {
              const values = await interruptible(native.listModels(), signal); signal.throwIfAborted();
              return values.map(model => ({ id: model.id, ...(model.name === undefined ? {} : { name: model.name }), ...(model.contextSize === undefined ? {} : { contextWindow: model.contextSize }) }));
            } catch { signal.throwIfAborted(); throw new RemoteFailure("llm/model-discovery-rejected", "Provider model catalog could not be loaded", { settingsNs: "llm-pi-ai" }); }
          }
        }
        if (request.baseURL === undefined) throw new RemoteFailure("llm/model-discovery-rejected", "An unknown provider requires an endpoint", { settingsNs: "llm-pi-ai" });
        const url = `${endpoint(text(request.baseURL, "baseURL", 2000))}/models`;
        const secret = request.apiKey === undefined || request.apiKey === "" ? undefined : text(request.apiKey, "apiKey", 64_000);
        if (secret !== undefined && /[\r\n\u0000]/u.test(secret)) bad("Credential must be a single-line value");
        if (!host.registerTool || !host.executeTool) throw new RemoteFailure("llm/model-discovery-rejected", "Controlled network discovery is unavailable", { settingsNs: "llm-pi-ai" });
        const ticket = randomUUID(); discoverySecrets.set(ticket, secret);
        try {
          const result = await host.executeTool(undefined, discoveryTool.name, { url, ticket }, signal);
          if (result.status !== "success") throw new RemoteFailure("llm/model-discovery-rejected", "Provider discovery was refused by the host or failed", { settingsNs: "llm-pi-ai" });
          return result.output;
        } finally { discoverySecrets.delete(ticket); }
      }
      throw new RemoteFailure("gateway/not-found", "Unknown configuration endpoint");
    },
  };
}

function validateDocument(kind: "settings" | "credentials", value: unknown): SettingsDocument | CredentialDocument {
  if (!record(value) || value.version !== 1) throw new Error("Invalid configuration document");
  if (kind === "settings") {
    if (!record(value.namespaces) || Object.keys(value).some(key => !["version", "namespaces"].includes(key))) throw new Error("Invalid settings document");
    for (const [name, row] of Object.entries(value.namespaces)) {
      if (!Object.hasOwn(schemas, name) || !record(row) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !record(row.user)
        || Object.keys(row).some(key => !["revision", "user"].includes(key)) || !validation[name as Namespace].safeParse(row.user).success) throw new Error("Invalid settings namespace");
      json(row.user);
    }
  } else {
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !record(value.values) || Object.keys(value).some(key => !["version", "revision", "values"].includes(key))) throw new Error("Invalid credentials document");
    for (const [name, secret] of Object.entries(value.values)) if (!REF.test(name) || UNSAFE.has(name) || typeof secret !== "string" || !secret || secret.length > 64_000 || /[\r\n\u0000]/u.test(secret)) throw new Error("Invalid stored credential");
  }
  return value as unknown as SettingsDocument | CredentialDocument;
}
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function sameInode(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left: Stats, right: Stats): boolean {
  return sameInode(left, right) && left.size === right.size && left.mode === right.mode && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
/** Called only inside the private document tool. The fixed deepseek child may
 * not resolve through another directory, even if its filename looks safe. */
async function documentDirectory(path: string): Promise<{ path: string; stat: Stats }> {
  const directory = dirname(path), root = await realpath(dirname(directory));
  const actual = await realpath(directory), stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(actual, join(root, basename(directory)))) {
    throw new Error("Private configuration directory leaves its fixed owner");
  }
  return { path: actual, stat };
}
async function checkDirectory(path: string, original: { path: string; stat: Stats }): Promise<void> {
  const current = await documentDirectory(path);
  if (!samePath(current.path, original.path) || !sameInode(current.stat, original.stat)) throw new Error("Private configuration directory changed");
}
function privateFile(stat: Stats, kind: "settings" | "credentials"): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_DOCUMENT
    || (kind === "credentials" && process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Invalid private configuration file");
}
async function readDocument(path: string, kind: "settings" | "credentials", signal: AbortSignal): Promise<string> {
  const directory = await documentDirectory(path);
  const observed = await lstat(path); privateFile(observed, kind);
  // Only an initially absent document is a new document. A path removed or
  // replaced after this observation must not become a silent empty overwrite.
  try {
    const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const opened = await file.stat(); privateFile(opened, kind);
      if (!sameFile(observed, opened) || !samePath(await realpath(path), join(directory.path, basename(path)))) throw new Error("Private configuration file changed before opening");
      await checkDirectory(path, directory);
      const chunks: Buffer[] = []; let bytes = 0;
      while (bytes <= MAX_DOCUMENT) {
        signal.throwIfAborted(); const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_DOCUMENT + 1 - bytes));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break; bytes += bytesRead; chunks.push(buffer.subarray(0, bytesRead));
      }
      if (bytes > MAX_DOCUMENT) throw new Error("Private configuration document is too large");
      const finalOpened = await file.stat(), finalPath = await lstat(path);
      privateFile(finalOpened, kind); privateFile(finalPath, kind);
      if (!sameFile(opened, finalOpened) || !sameFile(opened, finalPath) || bytes !== opened.size
        || !samePath(await realpath(path), join(directory.path, basename(path)))) throw new Error("Private configuration file changed during reading");
      await checkDirectory(path, directory); signal.throwIfAborted();
      return Buffer.concat(chunks).toString("utf8");
    } finally { await file.close(); }
  } catch { throw new Error("Private configuration file could not be safely opened and read"); }
}
async function save(path: string, document: SettingsDocument | CredentialDocument, signal: AbortSignal): Promise<void> {
  const data = JSON.stringify(document);
  if (Buffer.byteLength(data) > MAX_DOCUMENT) throw new Error("Private configuration document is too large");
  const directory = dirname(path); await mkdir(directory, { recursive: true, mode: 0o700 });
  const original = await documentDirectory(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK), 0o600);
    try {
      const opened = await file.stat(); privateFile(opened, "credentials");
      await checkDirectory(path, original); signal.throwIfAborted();
      await file.writeFile(data); await file.sync();
      const written = await file.stat(), present = await lstat(temporary);
      privateFile(written, "credentials"); privateFile(present, "credentials");
      if (!sameInode(opened, written) || !sameFile(written, present) || written.size !== Buffer.byteLength(data)
        || !samePath(await realpath(temporary), join(original.path, basename(temporary)))) throw new Error("Private configuration temporary file changed");
      await checkDirectory(path, original); signal.throwIfAborted();
    } finally { await file.close(); }
    await checkDirectory(path, original); signal.throwIfAborted();
    await rename(temporary, path);
    await checkDirectory(path, original);
    if (process.platform !== "win32") { const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); } }
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
