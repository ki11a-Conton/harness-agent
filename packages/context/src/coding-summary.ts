import { DEFAULT_TOKEN_ESTIMATOR } from "./tokenizer.js";
import { detectPromptInjection } from "@ar/security";
import { createHash } from "node:crypto";

export interface CodingSummaryPolicy {
  mode: "structured-v1" | "external-v1";
  /** Required implementation identity for external callbacks; session frozen. */
  implementationId?: string;
  /** Computed from callback source by the host, never accepted on trust. */
  readonly implementationSha256?: string;
  maxTokens?: number;
  minTokens?: number;
  maxInputTokens?: number;
  timeoutMs?: number;
  /** Host owns any model call, its billing/budget and cancellation. */
  summarize?: (content: string, signal: AbortSignal) => string | Promise<string>;
}

const protectedSections = new Set(["Goal", "Constraints", "Decisions", "Files Changed", "Commands Run", "Tests", "Failures", "Open Tasks", "Important Facts", "Artifacts", "Child Agents"]);
function protectedFacts(content: string): string[] {
  const facts: string[] = [];
  let protectedSection = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) protectedSection = protectedSections.has(line.slice(3).trim());
    if (protectedSection && line.trim()) facts.push(line);
  }
  return facts;
}

/** Conservative, factual summary: never trade the current goal, pending work
 * or failed checks for token savings. Failure falls back to the full digest. */
export function createCodingSummaryAdapter(policy: CodingSummaryPolicy): (content: string) => Promise<string> {
  const max = policy.maxTokens ?? 1200, min = policy.minTokens ?? 600;
  const maxInput = policy.maxInputTokens ?? 16000, timeout = policy.timeoutMs ?? 5000;
  if (![max, min, maxInput, timeout].every(n => Number.isSafeInteger(n) && n > 0)
    || max > maxInput || min > max || timeout > 60000) throw new TypeError("invalid coding summary budgets");
  if (policy.mode !== "structured-v1" && policy.mode !== "external-v1") throw new TypeError("unsupported coding summary mode");
  if (policy.mode === "external-v1" && (!policy.implementationId?.trim() || !policy.summarize)) throw new TypeError("external summary requires implementationId and a budgeted host callback");
  return async content => {
    const size = DEFAULT_TOKEN_ESTIMATOR.estimate(content);
    if (size < min || size > maxInput) return content;
    let candidate: string;
    if (policy.mode === "structured-v1") {
      let section = "";
      const seen = new Set<string>();
      const lines = content.split("\n").filter(line => {
        if (line.startsWith("## ")) { section = line.slice(3); seen.clear(); }
        if (!line.startsWith("- ")) return true;
        const key = section + "\0" + line;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      const completed = lines.indexOf("## Completed Work");
      if (completed >= 0 && DEFAULT_TOKEN_ESTIMATOR.estimate(lines.join("\n")) > max) {
        let end = completed + 1;
        while (end < lines.length && !lines[end]!.startsWith("## ")) end += 1;
        const recent = lines.slice(completed + 1, end).filter(line => line.startsWith("- ")).slice(-6);
        lines.splice(completed + 1, end - completed - 1, "[older completed items omitted from this summary]", ...recent, "");
      }
      candidate = lines.join("\n");
    } else {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        candidate = await Promise.race([
          Promise.resolve().then(() => policy.summarize!(content, controller.signal)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("summary deadline")); }, timeout); }),
        ]);
      } catch { return content; }
      finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
    }
    const candidateLines = new Set(typeof candidate === "string" ? candidate.split("\n") : []);
    if (typeof candidate !== "string" || !candidate.trim() || candidate.length >= content.length
      || DEFAULT_TOKEN_ESTIMATOR.estimate(candidate) > max
      || protectedFacts(content).some(fact => !candidateLines.has(fact))
      || detectPromptInjection(candidate).hasInjection) return content;
    return candidate;
  };
}

/** Capture actual callback text in resume identity in addition to the host's
 * declared identity (which must cover captured model/configuration values). */
export function normalizeCodingSummaryPolicy(policy: CodingSummaryPolicy): CodingSummaryPolicy {
  createCodingSummaryAdapter(policy); // pure startup validation, before resources open
  return policy.mode === "external-v1"
    ? { ...policy, implementationSha256: createHash("sha256").update(Function.prototype.toString.call(policy.summarize)).digest("hex") }
    : { ...policy };
}

export function resolveCodingSummaryPolicy(value?: string): CodingSummaryPolicy | undefined {
  if (value === undefined || value === "off") return undefined;
  if (value === "structured-v1") return { mode: "structured-v1" };
  throw new TypeError("HARNESS_CONTEXT_SUMMARY must be off or structured-v1");
}
