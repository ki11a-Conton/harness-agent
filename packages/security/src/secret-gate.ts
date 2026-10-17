/**
 * Issue 6b: secret detection gate for memory persistence.
 *
 * Structured patterns for API keys, tokens, private keys, and credential
 * assignments. Mirror of the injection-gate discipline: word-boundary,
 * case-insensitive, structured (not naive substring).
 */

export interface SecretReport {
  hasSecret: boolean;
  /** Matched secret-family names (empty when allowed). */
  secrets: string[];
}

type Pattern = { name: string; re: RegExp; accepts?: (span: string) => boolean };

function isJwt(span: string): boolean {
  // Preserve the existing structured guard, including its synthetic fixtures.
  if (/^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(span)) return true;
  // JSON can legally contain whitespace before/between keys. Recognize those
  // encodings without classifying qualified code symbols as credentials.
  try {
    const [header, claims] = span.split(".");
    const h: unknown = JSON.parse(Buffer.from(header!, "base64url").toString("utf8"));
    const c: unknown = JSON.parse(Buffer.from(claims!, "base64url").toString("utf8"));
    return h !== null && typeof h === "object" && !Array.isArray(h)
      && typeof (h as Record<string, unknown>).alg === "string"
      && c !== null && typeof c === "object" && !Array.isArray(c);
  } catch { return false; } // Invalid JSON is a code/text candidate, not a JWT.
}

function globalPattern(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

const SECRET_PATTERNS: Pattern[] = [
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "stripe-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt-token", re: /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{8,}\b/, accepts: isJwt },
  { name: "private-key", re: /-----BEGIN ((?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?(?:-----END \1-----|$)/ },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/ },
  { name: "credential-assignment", re: /\b(?:api[_-]?key|secret|token|password|passwd|auth_token)["']?\s*[:=]\s*["'](?!\$)(?![^"']*\$\{)[^"'\s]{8,}["']/ },
  { name: "db-credentials", re: /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s/]+@/ },
];

export function detectSecrets(content: string): SecretReport {
  const secrets: string[] = [];
  const seen = new Set<string>();

  for (const { name, re, accepts } of SECRET_PATTERNS) {
    for (const match of content.matchAll(globalPattern(re))) {
      if (accepts !== undefined && !accepts(match[0])) continue;
      if (!seen.has(name)) { seen.add(name); secrets.push(name); }
      break;
    }
  }

  return { hasSecret: secrets.length > 0, secrets };
}

/**
 * P0-7: replace every matched secret span with "[redacted]" so secret-bearing
 * content can safely cross boundaries (tool-output artifacts, provider error
 * summaries). Returns the redacted content and how many spans were replaced.
 * Patterns are applied in registration order; an already-redacted span cannot
 * match any later pattern, so replacements never stack.
 */
export function redactSecrets(content: string): { content: string; redacted: number } {
  let out = content;
  let redacted = 0;
  for (const { re, accepts } of SECRET_PATTERNS) {
    out = out.replace(globalPattern(re), span => {
      if (accepts !== undefined && !accepts(span)) return span;
      redacted++;
      return "[redacted]";
    });
  }
  return { content: out, redacted };
}