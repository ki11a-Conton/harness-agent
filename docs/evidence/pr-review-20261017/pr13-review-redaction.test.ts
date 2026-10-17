import { expect, it } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { redactSecrets } from "./gate-evidence-v2.js";

it("review PR13: retain redaction of valid JWTs whose JSON has whitespace", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "synthetic-review-user", role: "test" }, null, 2)).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", "synthetic-review-secret-not-a-real-key").update(input).digest("base64url");
  const token = `${input}.${signature}`;
  expect(JSON.parse(Buffer.from(payload, "base64url").toString()).sub).toBe("synthetic-review-user");
  expect(redactSecrets(`authorization-token ${token}`)).not.toContain(token);
});


it("review PR13: redact the private key material, not only its PEM header", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const body = pem.split("\n").filter(line => line && !line.startsWith("-----")).join("\n");
  expect(body.length).toBeGreaterThan(20);
  expect(redactSecrets(pem)).not.toContain(body);
});
