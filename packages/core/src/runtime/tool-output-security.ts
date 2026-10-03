export interface ToolOutputSecurityHooks {
  redact?: (content: string) => { content: string; redacted: number };
  detect?: (content: string) => { hasInjection: boolean; reasons: string[] };
}

interface StringToken { start: number; end: number; decoded: string; safe?: string }

/** Inspect the original strings before changing any text. Parsing an entire
 * object would discard duplicate keys and round numeric lexemes; rewriting
 * only string-token spans preserves both, and keeps the caller's result intact.
 * JSON.parse is used only for a single string literal or syntax validation. */
export function protectToolOutputText(raw: string, hooks: ToolOutputSecurityHooks): {
  content: string; redacted: number; injection: { hasInjection: boolean; reasons: string[] };
} {
  if (hooks.redact === undefined && hooks.detect === undefined) {
    return { content: raw, redacted: 0, injection: { hasInjection: false, reasons: [] } };
  }
  let redacted = 0;
  const reasons = new Set<string>();
  let denied = false;
  const scan = (text: string): string => {
    const safe = hooks.redact?.(text) ?? { content: text, redacted: 0 };
    redacted += safe.redacted;
    const report = hooks.detect?.(safe.content);
    if (report?.hasInjection) {
      denied = true;
      for (const reason of report.reasons) reasons.add(reason);
    }
    return safe.content;
  };
  const withhold = (): string => {
    denied = true;
    reasons.add("structured-output-security-depth");
    return "[tool output withheld: nested data exceeds security limit]";
  };
  const structured = (text: string): boolean => {
    // Failure rendering keeps its status prefix, but its captured payload has
    // exactly the same decoded-string safety boundary as a successful result.
    const body = text.startsWith("[failed] ") ? text.slice(9) : text;
    if (!/^[\s]*[\[{"]/.test(body)) return false;
    try { JSON.parse(body); return true; } catch { return false; }
  };
  const tokensOf = (text: string): StringToken[] => {
    const tokens: StringToken[] = [];
    const quoted = /"(?:[^"\\]|\\[\s\S])*"/g;
    for (const match of text.matchAll(quoted)) {
      try {
        const decoded: unknown = JSON.parse(match[0]);
        if (typeof decoded === "string") {
          tokens.push({ start: match.index, end: match.index + match[0].length, decoded });
        }
      } catch {
        // Quoted prose need not be a JSON literal. The whole-text scanner
        // has already inspected it; continue with the other original tokens.
        continue;
      }
    }
    return tokens;
  };
  const rewrite = (text: string, layers: number): string => {
    const wholeSafe = scan(text);
    const tokens = tokensOf(text);
    if (tokens.length === 0) return wholeSafe;
    if (layers >= 8) return withhold();
    // Bound object/array nesting independently of escaped capture layers. This
    // lexical check ignores delimiters inside strings and never walks an AST.
    let nesting = 0;
    let position = 0;
    for (const token of [...tokens, { start: text.length, end: text.length }]) {
      for (; position < token.start; position++) {
        if (text[position] === "{" || text[position] === "[") {
          if (++nesting > 128) return withhold();
        } else if (text[position] === "}" || text[position] === "]") nesting--;
      }
      position = token.end;
    }
    // All original values are inspected, including values that will subsequently
    // be replaced by a credential-assignment redaction. No first/last-key wins.
    for (const token of tokens) token.safe = rewrite(token.decoded, layers + 1);
    for (let index = 0; index + 1 < tokens.length; index++) {
      const key = tokens[index]!;
      const value = tokens[index + 1]!;
      if (!/^\s*:\s*$/.test(text.slice(key.end, value.start))) continue;
      // A policy may recognize a credential only together with its field name.
      // Use the decoded key and value, so Unicode-escaped keys cannot bypass it.
      // Keep a sanitized key in that context: a key can contain both a secret
      // token and a credential name, and redacting one must not hide the other.
      const prefix = `${JSON.stringify(key.safe)}:`;
      const pair = prefix + JSON.stringify(value.decoded);
      const safePair = scan(pair);
      let firstChange = 0;
      while (firstChange < pair.length && pair[firstChange] === safePair[firstChange]) firstChange++;
      if (safePair !== pair && firstChange < prefix.length) value.safe = "[redacted]";
    }
    let positionIn = 0;
    const pieces: string[] = [];
    for (const token of tokens) {
      pieces.push(text.slice(positionIn, token.start));
      pieces.push(token.safe === token.decoded ? text.slice(token.start, token.end) : JSON.stringify(token.safe));
      positionIn = token.end;
    }
    pieces.push(text.slice(positionIn));
    const mapped = pieces.join("");
    if (!structured(text)) return scan(mapped);
    // The whole-text hook can also match outside a string. Honor a rewrite that
    // preserves structured syntax, without parsing/reserializing its contents.
    // Credential-assignment policies often replace key+colon+value together,
    // breaking JSON. Those fields were safely replaced above, in their value
    // spans; do not use that malformed whole-text rewrite as the model view.
    const mappedSafe = scan(mapped);
    if (structured(mappedSafe)) return mappedSafe;
    // Some assignment policies match their own replacement marker. Only
    // disregard malformed rewrites when every change is exactly a rewrite of
    // a field whose value is already the safe marker. Other unmappable host
    // redactions must fail closed rather than falling back to plaintext.
    const mappedTokens = tokensOf(mapped);
    const explained: string[] = [];
    let explainedEnd = 0;
    for (let index = 0; index + 1 < mappedTokens.length; index++) {
      const key = mappedTokens[index]!;
      const value = mappedTokens[index + 1]!;
      if (value.decoded !== "[redacted]" || !/^\s*:\s*$/.test(mapped.slice(key.end, value.start))) continue;
      const pair = mapped.slice(key.start, value.end);
      const safePair = scan(pair);
      let firstChange = 0;
      while (firstChange < pair.length && pair[firstChange] === safePair[firstChange]) firstChange++;
      if (safePair === pair || firstChange >= value.start - key.start) continue;
      explained.push(mapped.slice(explainedEnd, key.start), safePair);
      explainedEnd = value.end;
    }
    explained.push(mapped.slice(explainedEnd));
    if (explained.join("") === mappedSafe) return mapped;
    denied = true;
    reasons.add("tool-output-redaction-unmappable");
    return "[tool output withheld: host redaction cannot preserve structured data]";
  };
  try {
    const content = rewrite(raw, 0);
    return { content, redacted, injection: { hasInjection: denied, reasons: [...reasons] } };
  } catch {
    // A broken host scanner cannot place unprocessed content in an artifact.
    return { content: "[tool output withheld: security hook failed]", redacted,
      injection: { hasInjection: true, reasons: ["tool-output-security-hook-failed"] } };
  }
}
