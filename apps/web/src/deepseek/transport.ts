import { redactSecrets } from "@ar/security";

/** The transport needs lifecycle/framing only. Both real HTTP messages and
 * per-request socket responses implement this narrow boundary. */
export interface TransportRequest {
  readonly aborted: boolean;
  once(event: "aborted", listener: () => void): unknown;
  off(event: "aborted", listener: () => void): unknown;
}
export interface TransportResponse {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  readonly headersSent: boolean;
  once(event: "close" | "drain", listener: () => void): unknown;
  off(event: "close" | "drain", listener: () => void): unknown;
  writeHead(status: number, headers: Record<string, string>): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(chunk?: string): unknown;
}

export interface DeepseekService {
  readonly endpoints: readonly string[];
  call(endpoint: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  stream?(endpoint: string, args: unknown, signal: AbortSignal, uplink: AsyncIterable<unknown>): AsyncIterable<unknown>;
  close?(): Promise<void>;
}
export class RemoteFailure extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
export function remoteError(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown } | null;
  const code = error instanceof Error && error.name === "AbortError" ? "gateway/cancelled"
    : typeof candidate?.code === "string" && /^[a-z][a-z0-9/-]{0,100}$/.test(candidate.code) ? candidate.code : "gateway/internal";
  const message = redactSecrets(error instanceof Error ? error.message : String(error)).content;
  let details: unknown = {};
  if (candidate?.details !== null && typeof candidate?.details === "object" && !Array.isArray(candidate.details)) {
    // Diagnostic values must never make reporting the original failure fail.
    try {
      const parsed: unknown = JSON.parse(redactSecrets(JSON.stringify(candidate.details)).content);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed;
    } catch { details = {}; }
  }
  return { code, message, details };
}
export function wireEncode(value: unknown): string {
  // Buffer.toJSON runs before a JSON replacer. Inspect the original holder
  // value so Node's Uint8Array subtype shares the browser byte representation.
  return JSON.stringify(value, function(this: Record<string, unknown>, key, item: unknown) {
    const original = this[key];
    return original instanceof Uint8Array ? { $dshBytes: [...original] } : item;
  });
}
export function wireDecode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wireDecode);
  if (value !== null && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length === 1 && Object.hasOwn(item, "$dshBytes")) {
      if (!Array.isArray(item.$dshBytes) || item.$dshBytes.length > 32 * 1024 * 1024
        || item.$dshBytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new RemoteFailure("gateway/bad-request", "Invalid binary payload");
      return new Uint8Array(item.$dshBytes as number[]);
    }
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, wireDecode(child)]));
  }
  return value;
}

class Uplink implements AsyncIterable<unknown> {
  private values: unknown[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: unknown): void {
    if (this.ended) throw new RemoteFailure("gateway/cancelled", "Stream uplink is closed");
    if (this.values.length >= 128) throw new RemoteFailure("gateway/bad-request", "Stream uplink exceeded its queue limit");
    this.values.push(value); this.wake?.(); this.wake = undefined;
  }
  end(): void { this.ended = true; this.wake?.(); this.wake = undefined; }
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (!this.ended || this.values.length > 0) {
      if (this.values.length > 0) { yield this.values.shift(); continue; }
      await new Promise<void>(done => { this.wake = done; });
    }
  }
}
interface Active { kind: "call" | "open"; controller: AbortController; uplink?: Uplink }
const ID = /^[A-Za-z0-9_-]{16,128}$/;
const ROUTES = new Set(["call", "open", "uplink", "cancel"]);

/** Only explicitly registered domain endpoints can reach the local Harness. */
export class DeepseekTransport {
  private readonly services = new Map<string, DeepseekService>();
  private readonly active = new Map<string, Active>();
  private stopping = false;
  private stopResult?: Promise<void>;
  constructor(services: readonly DeepseekService[], private readonly options: { closeServices?: boolean } = {}) {
    for (const service of services) for (const endpoint of service.endpoints) {
      if (this.services.has(endpoint)) throw new Error(`Duplicate DeepSeek endpoint: ${endpoint}`);
      this.services.set(endpoint, service);
    }
  }
  stop(): Promise<void> {
    if (this.stopResult !== undefined) return this.stopResult;
    this.stopping = true;
    for (const active of this.active.values()) { active.controller.abort(); active.uplink?.end(); }
    return this.stopResult = this.options.closeServices === false ? Promise.resolve()
      : Promise.all([...new Set(this.services.values())].map(service => service.close?.())).then(() => undefined);
  }
  async handle(route: string, body: Record<string, unknown>, req: TransportRequest, res: TransportResponse): Promise<void> {
    if (!ROUTES.has(route)) { this.json(res, 404, { ok: false, error: { code: "gateway/not-found", message: "Unknown transport route", details: {} } }); return; }
    try {
      if (this.stopping) throw new RemoteFailure("gateway/cancelled", "Host is stopping");
      if (route === "cancel") {
        if (Object.keys(body).some(key => !["requestId", "streamId"].includes(key)) || Number(body.requestId !== undefined) + Number(body.streamId !== undefined) !== 1) throw new RemoteFailure("gateway/bad-request", "Provide one cancellation identifier");
        const id = this.id(body.requestId ?? body.streamId);
        const active = this.active.get(id);
        if (active !== undefined && active.kind !== (body.requestId === undefined ? "open" : "call")) throw new RemoteFailure("gateway/bad-request", "Cancellation identifier has the wrong request kind");
        active?.controller.abort(); active?.uplink?.end();
        this.json(res, 200, { ok: true, value: { cancelled: active !== undefined } }); return;
      }
      if (route === "uplink") {
        if (Object.keys(body).some(key => !["streamId", "item", "done"].includes(key)) || (Object.hasOwn(body, "item") === (body.done === true))) throw new RemoteFailure("gateway/bad-request", "Provide one uplink item or completion");
        const active = this.active.get(this.id(body.streamId));
        if (!active?.uplink || active.controller.signal.aborted) throw new RemoteFailure("gateway/cancelled", "Unknown or closed stream");
        if (body.done === true) active.uplink.end(); else active.uplink.push(wireDecode(body.item));
        this.json(res, 200, { ok: true, value: undefined }); return;
      }
      const identifier = route === "call" ? "requestId" : "streamId";
      if (Object.keys(body).some(key => !["endpoint", "args", identifier].includes(key)) || typeof body.endpoint !== "string") throw new RemoteFailure("gateway/bad-request", "Invalid Remote request");
      const service = this.services.get(body.endpoint);
      if (!service) throw new RemoteFailure("gateway/not-found", `Endpoint is not registered: ${body.endpoint}`);
      if (route === "open" && !service.stream) throw new RemoteFailure("gateway/bad-request", "Endpoint does not support streaming");
      const id = this.id(body[identifier]);
      if (this.active.has(id)) throw new RemoteFailure("gateway/bad-request", "Request identifier is already active");
      if (this.active.size >= 256) throw new RemoteFailure("gateway/bad-request", "Too many active requests");
      const active: Active = { kind: route === "call" ? "call" : "open", controller: new AbortController(), ...(route === "open" ? { uplink: new Uplink() } : {}) };
      this.active.set(id, active);
      const disconnected = () => { active.controller.abort(); active.uplink?.end(); };
      req.once("aborted", disconnected); res.once("close", disconnected);
      try {
        // The outer host may have parsed the body before a disconnect. Events
        // that fired before these listeners cannot authorize a fresh operation.
        if (req.aborted || res.destroyed || res.writableEnded) disconnected();
        active.controller.signal.throwIfAborted();
        const args = wireDecode(body.args);
        if (route === "call") {
          const value = await service.call(body.endpoint, args, active.controller.signal);
          active.controller.signal.throwIfAborted(); this.json(res, 200, { ok: true, value });
        } else {
          res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          res.flushHeaders();
          try {
            for await (const item of service.stream!(body.endpoint, args, active.controller.signal, active.uplink!)) {
              active.controller.signal.throwIfAborted();
              if (!res.write(wireEncode(item) + "\n")) await new Promise<void>((resolve, reject) => {
                const abort = () => { cleanup(); reject(new RemoteFailure("gateway/cancelled", "Stream disconnected")); };
                const drain = () => { cleanup(); resolve(); };
                const cleanup = () => { res.off("drain", drain); active.controller.signal.removeEventListener("abort", abort); };
                res.once("drain", drain); active.controller.signal.addEventListener("abort", abort, { once: true });
                if (active.controller.signal.aborted) abort();
              });
            }
          } catch (error) { if (!res.destroyed && !active.controller.signal.aborted) res.write(wireEncode({ __deepseek_transport_error__: remoteError(error) }) + "\n"); }
          if (!res.destroyed) res.end();
        }
      } finally {
        req.off("aborted", disconnected); res.off("close", disconnected); active.controller.abort(); active.uplink?.end(); this.active.delete(id);
      }
    } catch (error) { if (!res.destroyed && !res.headersSent) this.json(res, 400, { ok: false, error: remoteError(error) }); }
  }
  private id(value: unknown): string { if (typeof value !== "string" || !ID.test(value)) throw new RemoteFailure("gateway/bad-request", "Invalid request identifier"); return value; }
  private json(res: TransportResponse, status: number, value: unknown): void {
    // Prepare the complete envelope before committing headers. A bad service
    // value can then be reported normally rather than stranding a 200 response.
    const encoded = wireEncode(value);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(encoded);
  }
}
