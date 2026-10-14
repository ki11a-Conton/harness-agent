import { protectToolOutputText } from "@ar/core";
import { redactSecrets } from "@ar/security";

/** Production event logs must never retain raw tool output. A credential may
 * span arbitrary frames, and a pre-truncated preview may cut its signature.
 * The canonical terminal result is inspected in full by Runtime before it
 * reaches model/history/artifact views. These events retain progress metadata. */
export function protectToolEventPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const candidate = { ...payload };
  if ((type === "tool.output" || type === "tool.progress") && typeof candidate.text === "string") {
    candidate.bytes = Buffer.byteLength(candidate.text, "utf8");
    candidate.withheld = true;
    delete candidate.text;
  }
  if (typeof candidate.outputPreview === "string") {
    candidate.previewWithheld = true;
    delete candidate.outputPreview;
  }
  try {
    const protectedText = protectToolOutputText(JSON.stringify(candidate), { redact: redactSecrets });
    const value: unknown = JSON.parse(protectedText.content);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Persist an observable fallback without logging an exception that may
    // contain the unprocessed tool output itself.
    return { withheld: true, reason: "tool-event-security" };
  }
  return { withheld: true, reason: "tool-event-security" };
}
