/** Provider-owned wire compatibility, inspired by pi's MIT
 * packages/ai/src/api/openai-completions.ts (getCompat/buildParams).
 * See third_party/coding-prompts/pi-MIT.txt. Unknown gateways retain legacy
 * wire fields unless the deployment explicitly declares their capabilities. */
export interface OpenAIChatCompatibility {
  maxTokensField: "max_tokens" | "max_completion_tokens";
  supportsTemperature: boolean;
}

export function resolveOpenAIChatCompatibility(
  baseUrl: string,
  modelId: string,
  override?: unknown,
): OpenAIChatCompatibility {
  let official = false;
  try { official = new URL(baseUrl).hostname.toLowerCase() === "api.openai.com"; }
  catch { official = false; } // Invalid URLs retain fallback semantics; fetch reports the transport error.
  const reasoning = /^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(modelId) && !/-chat(?:-|$)/.test(modelId);
  const resolved: OpenAIChatCompatibility = {
    maxTokensField: official && reasoning ? "max_completion_tokens" : "max_tokens",
    supportsTemperature: !(official && reasoning),
  };
  if (override === undefined) return resolved;
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    throw new TypeError("chatCompatibility must be an object");
  }
  for (const [key, value] of Object.entries(override)) {
    if (key === "maxTokensField" && (value === "max_tokens" || value === "max_completion_tokens")) resolved.maxTokensField = value;
    else if (key === "supportsTemperature" && typeof value === "boolean") resolved.supportsTemperature = value;
    else throw new TypeError(`invalid chatCompatibility field: ${key}`);
  }
  return resolved;
}
