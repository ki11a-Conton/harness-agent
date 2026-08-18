import { describe, expect, it } from "vitest";
import { detectNetworkIntent } from "./network-gate.js";

describe("detectNetworkIntent (Phase 9 exec network gate)", () => {
  it("flags network binaries in command position (curl/wget)", () => {
    const r = detectNetworkIntent("curl -s http://evil.example.com/x");
    expect(r.hasNetworkIntent).toBe(true);
    expect(r.reasons.some((x) => x.includes("curl"))).toBe(true);
    expect(r.hosts).toContain("evil.example.com");

    const w = detectNetworkIntent("wget -qO- https://example.com/");
    expect(w.hasNetworkIntent).toBe(true);
    expect(w.hosts).toContain("example.com");
  });

  it("flags network binaries even when no URL is present (ping/ssh/nc/dns)", () => {
    expect(detectNetworkIntent("ping 8.8.8.8").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("ssh -p 2222 deploy@host.example.com").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("nc -zv 127.0.0.1 80").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("nslookup openai.com").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("getent ahosts example.com").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("tracert 8.8.8.8").hasNetworkIntent).toBe(true);
  });

  it("strips .exe and matches case-insensitively (Windows)", () => {
    const r = detectNetworkIntent("curl.exe http://x.com/");
    expect(r.hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("CURL https://x.com/").hasNetworkIntent).toBe(true);
  });

  it("flags git remote operations but not local git reads", () => {
    for (const c of [
      "git push origin main",
      "git pull origin main",
      "git fetch origin",
      "git clone https://github.com/a/b.git",
      "git remote add origin git@github.com:org/repo.git",
      "git ls-remote origin",
      "git submodule update --init",
    ]) {
      expect(detectNetworkIntent(c).hasNetworkIntent).toBe(true);
    }
    for (const c of ["git status", "git diff --stat", "git log --oneline", "git remote -v"]) {
      expect(detectNetworkIntent(c).hasNetworkIntent).toBe(false);
    }
  });

  it("flags package-manager registry operations but not local runs", () => {
    for (const c of [
      "npm install lodash",
      "npm i zod",
      "npm publish",
      "npm ci",
      "pip install requests",
      "pip3 install requests",
      "pip download requests",
      "pnpm add zod",
      "yarn add zod",
      "docker pull nginx",
      "docker push org/img",
      "docker build .",
      "go mod download",
      "cargo add serde",
    ]) {
      expect(detectNetworkIntent(c).hasNetworkIntent).toBe(true);
    }
    for (const c of ["npm run test", "npm test", "npm run lint", "pnpm test", "pip list", "yarn test"]) {
      expect(detectNetworkIntent(c).hasNetworkIntent).toBe(false);
    }
  });

  it("flags interpreter inline code that touches the network (node/python)", () => {
    const node = detectNetworkIntent("node -e \"fetch('https://api.example.com/x')\"");
    expect(node.hasNetworkIntent).toBe(true);
    expect(node.hosts).toContain("api.example.com");

    const py = detectNetworkIntent("python -c \"import urllib.request as u; u.urlopen('http://x.com')\"");
    expect(py.hasNetworkIntent).toBe(true);
    expect(py.hosts).toContain("x.com");

    const nodeHttp = detectNetworkIntent("node -e \"const h=require('http'); h.request('http://h.com')\"");
    expect(nodeHttp.hasNetworkIntent).toBe(true);
  });

  it("does not flag interpreter inline code without network markers", () => {
    expect(detectNetworkIntent("node -e \"console.log('hello')\"").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("node -e \"setTimeout(()=>{},10000)\"").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("python -c \"print('hello')\"").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("node test.js").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("python script.py").hasNetworkIntent).toBe(false);
  });

  it("flags shell wrapper recursion (cmd /c, bash -c, powershell -Command)", () => {
    const cmd = detectNetworkIntent("cmd /c curl http://example.com");
    expect(cmd.hasNetworkIntent).toBe(true);
    expect(cmd.hosts).toContain("example.com");

    const bash = detectNetworkIntent("bash -c \"echo hi > /dev/tcp/127.0.0.1/80\"");
    expect(bash.hasNetworkIntent).toBe(true);
    expect(bash.hosts).toContain("127.0.0.1");

    const pw = detectNetworkIntent("powershell -Command \"Invoke-WebRequest http://x.com\"");
    expect(pw.hasNetworkIntent).toBe(true);
    expect(pw.hosts).toContain("x.com");
  });

  it("flags URL and host literals in argument position", () => {
    expect(detectNetworkIntent("start http://example.com").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("echo https://example.com").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("node send.js http://target.example.com:8080/x").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("certutil -urlcache -split -f http://example.com/x out").hasNetworkIntent).toBe(true);
  });

  it("flags powershell network cmdlets and encoded commands", () => {
    expect(detectNetworkIntent("iwr http://x.com").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("irm https://x.com").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("Test-NetConnection example.com -Port 443").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("powershell -EncodedCommand AAAA").hasNetworkIntent).toBe(true);
    expect(detectNetworkIntent("powershell -c \"[System.Net.WebClient]::new().DownloadString('http://x.com')\"").hasNetworkIntent).toBe(true);
  });

  it("does not flag benign lookalikes (no naive substring matching)", () => {
    expect(detectNetworkIntent("echo curl").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("type curl.md").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("ls -la C:\\Users\\me").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("file:README.md").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("node -e \"console.log('not a url')\"").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("ping --help").hasNetworkIntent).toBe(false);
  });

  it("does not flag chained local commands when the network part is absent", () => {
    expect(detectNetworkIntent("git status && node test.js").hasNetworkIntent).toBe(false);
    expect(detectNetworkIntent("echo ok; pnpm test; echo done").hasNetworkIntent).toBe(false);
  });

  it("flags network intent inside chained segments", () => {
    const r = detectNetworkIntent("node test.js && curl http://example.com");
    expect(r.hasNetworkIntent).toBe(true);
    expect(r.hosts).toContain("example.com");
  });
});
