import { describe, expect, it } from "vitest";
import { detectSecrets, redactSecrets } from "./secret-gate.js";
describe("detectSecrets (Issue 6b secret gate)", () => {
    it("detects AWS access keys", () => {
        const r = detectSecrets("credentials: AKIAIOSFODNN7EXAMPLE");
        expect(r.hasSecret).toBe(true);
        expect(r.secrets).toContain("aws-access-key");
    });
    it("detects provider API keys", () => {
        expect(detectSecrets("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx").hasSecret).toBe(true);
        expect(detectSecrets("github token ghp_0123456789abcdefghijklmnopqrstuv").hasSecret).toBe(true);
        expect(detectSecrets("stripe sk_live_REDACTED_FOR_PUSH_PROTECTION").hasSecret).toBe(true);
        expect(detectSecrets("google AIzaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").hasSecret).toBe(true);
    });
    it("detects JWTs and bearer tokens", () => {
        expect(detectSecrets("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz").hasSecret).toBe(true);
        expect(detectSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890").hasSecret).toBe(true);
    });
    it("detects PEM private key markers", () => {
        expect(detectSecrets("-----BEGIN RSA PRIVATE KEY-----").hasSecret).toBe(true);
        expect(detectSecrets("-----BEGIN OPENSSH PRIVATE KEY-----").hasSecret).toBe(true);
        expect(detectSecrets("-----BEGIN PRIVATE KEY-----").hasSecret).toBe(true);
    });
    it("detects credential assignments", () => {
        expect(detectSecrets("api_key = \"s3cret-api-key-value\"").hasSecret).toBe(true);
        expect(detectSecrets("password: 'sup3r-secret-pass'").hasSecret).toBe(true);
        expect(detectSecrets("token=\"abcdefghijklmnop\"").hasSecret).toBe(true);
    });
    it("detects database URLs with embedded credentials", () => {
        expect(detectSecrets("postgres://admin:hunter2-secret@db.example:5432/app").hasSecret).toBe(true);
        expect(detectSecrets("mongodb+srv://user:p4ss-w0rd@cluster.example.com/db").hasSecret).toBe(true);
    });
    it("does not flag plain words or prose", () => {
        const r = detectSecrets("the api key is stored in the vault and never committed");
        expect(r.hasSecret).toBe(false);
        expect(r.secrets).toEqual([]);
        const s = detectSecrets("run a password manager and rotate tokens quarterly");
        expect(s.hasSecret).toBe(false);
        expect(s.secrets).toEqual([]);
    });
    it("does not flag placeholder or environment-variable references", () => {
        expect(detectSecrets("token = \"$MY_TOKEN\"").hasSecret).toBe(false);
        expect(detectSecrets("apiKey: \"${API_KEY}\"").hasSecret).toBe(false);
        expect(detectSecrets("Authorization: Bearer <token>").hasSecret).toBe(false);
    });
    it("does not flag credential-free database URLs", () => {
        const r = detectSecrets("connect to mysql://localhost:3306/appdb or redis://127.0.0.1:6379");
        expect(r.hasSecret).toBe(false);
        expect(r.secrets).toEqual([]);
    });
    it("returns an empty report for empty or whitespace content", () => {
        expect(detectSecrets("")).toEqual({ hasSecret: false, secrets: [] });
        expect(detectSecrets("   \n  ")).toEqual({ hasSecret: false, secrets: [] });
    });
});
describe("redactSecrets (P0-7)", () => {
    it("replaces secret spans with [redacted] and reports the count", () => {
        const r = redactSecrets("key=sk-proj-abcdefghijklmnopqrstuvwx and Bearer abcdefghijklmnopqrstuvwxyz1234567890");
        expect(r.redacted).toBe(2);
        expect(r.content).not.toContain("sk-proj-");
        expect(r.content).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
        expect(r.content).toContain("[redacted]");
    });
    it("redacts multiple spans of the same family", () => {
        const r = redactSecrets("a=ghp_0123456789abcdefghijklmnopqrstuv b=ghp_9876543210zyxwvutsrqponmlkjihgfedcba");
        expect(r.redacted).toBe(2);
        expect(r.content).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    });
    it("redacts PEM private key blocks", () => {
        const r = redactSecrets("-----BEGIN RSA PRIVATE KEY-----");
        expect(r.redacted).toBe(1);
        expect(r.content).toContain("[redacted]");
    });
    it("redacts credential assignments and db URLs", () => {
        const r = redactSecrets('api_key = "s3cret-api-key-value" postgres://admin:hunter2-secret@db:5432/app');
        expect(r.redacted).toBe(2);
        expect(r.content).not.toContain("s3cret-api-key-value");
        expect(r.content).not.toContain("hunter2-secret");
    });
    it("is a no-op on benign content", () => {
        const r = redactSecrets("run a password manager and rotate tokens quarterly");
        expect(r.redacted).toBe(0);
        expect(r.content).toBe("run a password manager and rotate tokens quarterly");
    });
    it("empty content redacts nothing", () => {
        expect(redactSecrets("")).toEqual({ content: "", redacted: 0 });
    });
});
//# sourceMappingURL=secret-gate.test.js.map