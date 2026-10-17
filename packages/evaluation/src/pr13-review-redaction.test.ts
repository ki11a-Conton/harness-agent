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

it("redacts actual private material and whitespace-encoded JWTs before saving logs, selecting failure lines or summarizing runner exceptions", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { runGateV2, buildGateErrorSummary } = await import("./gate-evidence-v2.js");
  const dir = await mkdtemp(join(tmpdir(), "redaction-material-"));
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const material = pem.split("\n").find(line => line && !line.startsWith("-----"))!;
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }, null, 2)).toString("base64url");
    const p = Buffer.from(JSON.stringify({ sub: "local-only" }, null, 2)).toString("base64url");
    const token = `${h}.${p}.${createHmac("sha256", "synthetic-key").update(`${h}.${p}`).digest("base64url")}`;
    const stdout = `Error: generated private key\n${pem.replace(material, `Error: ${material}`)}`;
    const stderr = `Error: synthetic JWT ${token}`;
    const evidence = await runGateV2({ gate: "redaction", command: ["local-fake-runner"], cwd: dir, toolVersion: "test",
      logDir: join(dir, "logs"), run: async () => ({ exitCode: 1, stdout, stderr,
        failure: { kind: "runner_error", detail: `${pem}\n${token}` } }) });
    expect(evidence.logRef?.path).toBeTruthy();
    const saved = await readFile(join(dir, evidence.logRef!.path), "utf8");
    for (const surface of [saved, JSON.stringify(evidence), buildGateErrorSummary({ exitCode: 1, stdout, stderr, maxChars: 120 })]) {
      expect(surface).not.toContain(material);
      expect(surface).not.toContain(token);
    }
    expect(redactSecrets("sk-abcdefgh")).not.toContain("sk-abcdefgh");
    expect(redactSecrets(pem.slice(0, -30))).not.toContain(material);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
