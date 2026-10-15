import { createHash } from "node:crypto";

export interface RequestPrefixObservation {
  version: "wire-prefix-v1";
  sessionHash: string;
  requestSha256: string;
  systemSha256: string;
  toolsSha256: string;
  requestBytes: number;
  systemBytes: number;
  systemCommonPrefixBytes?: number;
  unchangedLeadingMessages?: number;
  toolsUnchanged?: boolean;
  /** Raw-byte diagnostics are not provider tokens or KV-cache measurements. */
  providerCacheHitRate: "not-measured";
}
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
interface Previous { system: Buffer; messages: string[]; tools: string }

/** Bounded, per-session observations of the actual wire payload. No prompts,
 * source, arguments, auth headers or session IDs are emitted to observers. */
export class RequestPrefixObserver {
  private readonly previous = new Map<string, Previous>();
  constructor(private readonly onObservation: (value: RequestPrefixObservation) => void) {}
  observe(body: Record<string, unknown>, serialized: string, sessionId: string): void {
    const sessionHash = digest(sessionId);
    const messages = Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : [];
    const system = Buffer.from(messages.filter(message => message.role === "system").map(message => String(message.content ?? "")).join(""));
    const messageHashes = messages.map(message => digest(JSON.stringify(message)));
    const tools = digest(JSON.stringify(body.tools ?? []));
    const old = this.previous.get(sessionHash);
    const observation: RequestPrefixObservation = { version: "wire-prefix-v1", sessionHash,
      requestSha256: digest(serialized), systemSha256: digest(system), toolsSha256: tools,
      requestBytes: Buffer.byteLength(serialized), systemBytes: system.length, providerCacheHitRate: "not-measured" };
    if (old) {
      let prefix = 0, leading = 0;
      while (prefix < system.length && prefix < old.system.length && system[prefix] === old.system[prefix]) prefix++;
      while (leading < messageHashes.length && leading < old.messages.length && messageHashes[leading] === old.messages[leading]) leading++;
      observation.systemCommonPrefixBytes = prefix; observation.unchangedLeadingMessages = leading;
      observation.toolsUnchanged = old.tools === tools;
    }
    this.previous.delete(sessionHash);
    if (system.length <= 256 * 1024 && messageHashes.length <= 4096) this.previous.set(sessionHash, { system, messages: messageHashes, tools });
    if (this.previous.size > 16) this.previous.delete(this.previous.keys().next().value!);
    try { this.onObservation(observation); } catch { /* Diagnostics cannot trigger retries or affect a model request. */ }
  }
}
