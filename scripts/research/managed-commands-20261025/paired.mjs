// Engineering protocol comparison only; actual model quality is NOT_PROVEN.
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const out = resolve(process.argv[2] ?? ".ci/managed-commands");
await mkdir(out, { recursive: true });
const { createHarness } = await import(
  pathToFileURL(join(root, "packages/harness/dist/index.js"))
);
const { ScriptedModelProvider } = await import(
  pathToFileURL(join(root, "packages/model/dist/index.js"))
);
const { z } = await import(
  pathToFileURL(join(root, "packages/tools/node_modules/zod/index.js"))
);
const { DeterministicPermissionEngine } = await import(
  pathToFileURL(join(root, "packages/security/dist/index.js"))
);
const networkRules = [
  { action: "exec", resource: "network", effect: "deny" },
  {
    action: "exec",
    resource: "network",
    pattern: "http://127.0.0.1:*/**",
    effect: "allow",
  },
];
for (const [target, expected] of [
  ["http://127.0.0.1:12345/health", "allow"],
  ["http://example.invalid/health", "deny"],
])
  assert.equal(
    (
      await new DeterministicPermissionEngine().evaluate(
        {
          action: "exec",
          resource: "network",
          target,
          agentId: "agent_fixture",
          sessionId: "session_fixture",
        },
        { rules: networkRules },
      )
    ).effect,
    expected,
  );
const source = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], {
  cwd: root,
  encoding: "utf8",
});
if (dirty)
  throw new Error("freeze a clean candidate commit before paired acceptance");
const registration = {
  source,
  scriptSha256: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  kinds: ["overlap-check", "failure-repair", "http-service"],
  pairsPerKind: 8,
  order: "AB BA alternating within each kind",
  budget: {
    turnMs: 15000,
    toolCalls: 30,
    iterations: 30,
    processMs: 5000,
    retainedBytes: 65536,
  },
  paidModelCalls: 0,
  networkPreflight: {
    loopback: "allow",
    external: "deny",
    pattern: "http://127.0.0.1:*/**",
  },
};
await writeFile(
  join(out, "registration.json"),
  JSON.stringify(registration, null, 2) + "\n",
  { flag: "wx" },
);
const all = [];
for (const kind of registration.kinds)
  for (let pair = 0; pair < 8; pair++)
    for (const arm of pair % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"]) {
      const id = `${kind}-${pair + 1}-${arm}`;
      const cwd = await realpath(
        await mkdtemp(join(tmpdir(), "managed-pair-")),
      );
      let h;
      const timeline = [],
        requests = [];
      let stage = "start",
        jobId,
        token = 0,
        failedId,
        state;
      const check = { command: process.execPath, args: ["check.cjs"] };
      await writeFile(
        join(cwd, "source.cjs"),
        "module.exports=" + (kind === "failure-repair" ? "0" : "1") + ";\n",
      );
      await writeFile(
        join(cwd, "check.cjs"),
        "const fs=require('node:fs');fs.appendFileSync('starts.jsonl',JSON.stringify({pid:process.pid,at:Date.now()})+'\\n');console.log('STARTED');setTimeout(()=>{const ok=require('./source.cjs')===1;fs.appendFileSync('exits.jsonl',JSON.stringify({code:ok?0:1,at:Date.now()})+'\\n');console.log(ok?'CHECK_OK':'CHECK_FAILED');process.exitCode=ok?0:1},2000);\n",
      );
      await writeFile(
        join(cwd, "server.cjs"),
        "const fs=require('node:fs'),http=require('node:http');fs.appendFileSync('starts.jsonl',JSON.stringify({pid:process.pid,at:Date.now()})+'\\n');const server=http.createServer((req,res)=>{fs.writeFileSync('api-observed.json',JSON.stringify({url:req.url,at:Date.now()}));res.end('ACTUAL_API_OK')});server.listen(0,'127.0.0.1',()=>{fs.writeFileSync('port.txt',String(server.address().port));console.log('LISTENING '+server.address().port)});process.on('exit',()=>fs.appendFileSync('exits.jsonl',JSON.stringify({code:process.exitCode??0,at:Date.now()})+'\\n'));setTimeout(()=>server.close(),4500);\n",
      );
      const independent = {
        command: process.execPath,
        args: [
          "-e",
          kind === "http-service"
            ? "const assert=require('node:assert/strict'),fs=require('node:fs');assert.equal(JSON.parse(fs.readFileSync('api-observed.json')).url,'/health')"
            : "require('node:assert/strict').equal(require('./source.cjs'),1);require('node:assert/strict').equal(JSON.parse(require('node:fs').readFileSync('exits.jsonl','utf8').trim().split('\\n').at(-1)).code,0)",
        ],
      };
      for (const args of [
        ["init", "-q"],
        ["config", "user.name", "Harness Acceptance"],
        ["config", "user.email", "harness-acceptance@example.invalid"],
        ["add", "."],
        ["commit", "-qm", "fixed engineering fixture"],
      ])
        execFileSync("git", args, { cwd });
      const command =
        kind === "http-service"
          ? { command: process.execPath, args: ["server.cjs"] }
          : check;
      const provider = {
        id: "managed-paired-script",
        listModels: async () => [
          { id: "offline", capabilities: { contextWindowTokens: 128000 } },
        ],
        createClient: () => ({
          async *generate(request) {
            requests.push(structuredClone(request));
            const last =
              request.messages.filter((m) => m.role === "tool").at(-1)
                ?.content ?? "";
            let data;
            try {
              data = JSON.parse(last);
            } catch {}
            if (data?.jobId) {
              jobId = data.jobId;
              token = data.pollToken;
              state = data.state;
            }
            timeline.push({
              event: "model",
              stage,
              at: Date.now(),
              observedState: state,
              toolBody: last,
            });
            const call = (name, args) =>
              ScriptedModelProvider.toolCall(name, args);
            if (stage === "start") {
              stage = arm === "candidate" ? "ready" : "read";
              yield* call(arm === "candidate" ? "exec_start" : "exec", {
                ...command,
                ...(arm === "candidate" ? { yieldMs: 50 } : {}),
              });
              return;
            }
            if (stage === "ready") {
              if (
                !request.messages.some(
                  (m) =>
                    m.role === "tool" &&
                    (m.content.includes("STARTED") ||
                      m.content.includes("LISTENING")),
                )
              ) {
                yield* call("exec_poll", {
                  jobId,
                  pollToken: token,
                  waitMs: 50,
                });
                return;
              }
              stage = "read";
            }
            if (stage === "read") {
              stage = "observe";
              yield* call("read_file", {
                path: kind === "http-service" ? "port.txt" : "source.cjs",
              });
              return;
            }
            if (kind === "http-service" && stage === "observe") {
              let port = Number(last.trim());
              if (!port && arm === "candidate") {
                yield* call("read_file", { path: "port.txt" });
                return;
              }
              stage = "stop";
              yield* call("http_probe", {
                url: `http://127.0.0.1:${port}/health`,
              });
              return;
            }
            if (kind === "http-service" && stage === "stop") {
              stage = "finish";
              if (arm === "candidate") {
                yield* call("exec_cancel", { jobId, pollToken: token });
                return;
              }
            }
            if (kind !== "http-service" && stage === "observe") {
              if (arm === "candidate" && state === "running") {
                yield* call("exec_poll", {
                  jobId,
                  pollToken: token,
                  waitMs: 1000,
                });
                return;
              }
              if (kind === "failure-repair") {
                failedId = jobId;
                stage = "retry";
                yield* call("edit_file", {
                  path: "source.cjs",
                  oldText: "module.exports=0;",
                  newText: "module.exports=1;",
                });
                return;
              }
              stage = "finish";
            }
            if (stage === "retry") {
              stage = "recheck";
              yield* call(arm === "candidate" ? "exec_start" : "exec", {
                ...check,
                ...(arm === "candidate"
                  ? { yieldMs: 50, supersedes: failedId }
                  : {}),
              });
              return;
            }
            if (
              stage === "recheck" &&
              arm === "candidate" &&
              state === "running"
            ) {
              yield* call("exec_poll", {
                jobId,
                pollToken: token,
                waitMs: 1000,
              });
              return;
            }
            stage = "finish";
            yield* ScriptedModelProvider.text(
              "Engineering protocol finished; use the actual verification result.",
            );
          },
        }),
      };
      const startedAt = Date.now();
      const report = {
        id,
        arm,
        kind,
        pair,
        source,
        startedAt,
        paidModelCalls: 0,
        userInterventions: 0,
      };
      try {
        h = await createHarness({
          cwd,
          profile: "test",
          dataDir: join(cwd, ".state"),
          modelProvider: provider,
          model: { providerId: provider.id, modelId: "offline" },
          featureFlags: {
            skills: false,
            memory: false,
            mcp: false,
            delegation: false,
          },
          limits: { maxDurationMs: 15000, maxToolCalls: 30 },
          maxIterationsPerTurn: 30,
          sandboxPolicy: {
            filesystem: { mode: "workspace-write", allowedPaths: [cwd] },
            network: { mode: "allowlist", hosts: ["127.0.0.1"] },
            process: { timeoutMs: 5000, maxOutputBytes: 65536 },
          },
          task: {
            id: "paired",
            goal: kind,
            completionPolicy: { requiresVerification: true },
            verification: [{ kind: "command", ...independent }],
          },
          ...(arm === "candidate"
            ? { managedCommands: { enabled: true, maxJobMs: 5000 } }
            : {}),
        });
        h.registry.register({
          name: "http_probe",
          description: "Read the fixture local HTTP health endpoint",
          inputSchema: z.object({ url: z.string().url() }),
          risk: "readonly",
          metadata: {
            name: "http_probe",
            version: "1",
            sideEffect: false,
            process: false,
            filesystem: false,
            network: true,
            interactive: false,
            retry: "safe",
            concurrencySafe: false,
          },
          execute: async ({ url }, context) => {
            try {
              const response = await fetch(url, {
                signal: AbortSignal.any([
                  context.signal,
                  AbortSignal.timeout(1000),
                ]),
              });
              return {
                status: response.ok ? "success" : "failed",
                output: (await response.text()).slice(0, 4096),
              };
            } catch (err) {
              return {
                status: "failed",
                error: {
                  code: "NETWORK_ERROR",
                  message: err.message,
                  retryable: false,
                  safeToRetry: false,
                },
              };
            }
          },
        });
        h.agents[0].tools.allow.push("http_probe");
        h.agents[0].permissions.rules.unshift({
          action: "exec",
          resource: "network",
          pattern: "http://127.0.0.1:*/**",
          effect: "allow",
        });
        const session = await h.runtime.createSession({
          agent: h.agents[0],
          cwd,
        });
        const turn = await h.runtime.startTurn(session.id, kind);
        const outcome = await h.runtime.runTurn(
          session.id,
          turn.id,
          new AbortController().signal,
        );
        report.outcome = outcome;
        report.events = await h.events.list(session.id);
        report.requests = requests;
        report.timeline = timeline;
        try {
          execFileSync(independent.command, independent.args, {
            cwd,
            stdio: "pipe",
            timeout: 5000,
          });
          report.independentExit = 0;
        } catch (err) {
          report.independentExit = err.status ?? -1;
          report.independentError = err.stderr?.toString();
        }
        report.starts = (
          await readFile(join(cwd, "starts.jsonl"), "utf8").catch(() => "")
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
        report.exits = (
          await readFile(join(cwd, "exits.jsonl"), "utf8").catch(() => "")
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
        const readAt = timeline.find((e) => e.stage === "observe")?.at;
        report.overlapObserved =
          !!readAt &&
          report.starts.some(
            (s) =>
              s.at < readAt &&
              (report.exits.find((e) => e.at >= s.at)?.at ?? Infinity) > readAt,
          );
        report.outputBytes = requests.reduce(
          (n, r) =>
            n +
            r.messages
              .filter((m) => m.role === "tool")
              .reduce((s, m) => s + Buffer.byteLength(m.content), 0),
          0,
        );
        report.toolCalls = outcome.toolCalls;
        report.expectedStarts = kind === "failure-repair" ? 2 : 1;
        report.duplicateStarts = Math.max(
          0,
          report.starts.length - report.expectedStarts,
        );
      } catch (err) {
        report.error = String(err.stack ?? err);
        report.independentExit = -1;
      } finally {
        if (h)
          await h.close().catch((err) => {
            report.cleanupError = String(err);
          });
        report.cleanupAlive = (report.starts ?? [])
          .filter((s) => {
            try {
              process.kill(s.pid, 0);
              return true;
            } catch {
              return false;
            }
          })
          .map((s) => s.pid);
        report.durationMs = Date.now() - startedAt;
        await writeFile(
          join(out, id + ".json"),
          JSON.stringify(report, null, 2) + "\n",
          { flag: "wx" },
        );
        await rm(cwd, { recursive: true, force: true });
      }
      all.push(report);
      console.log(
        JSON.stringify({
          id,
          exit: report.independentExit,
          overlap: report.overlapObserved,
          starts: report.starts?.length,
          durationMs: report.durationMs,
          error: report.error,
        }),
      );
    }
const summary = {
  ...registration,
  arms: all.length,
  baselinePass: all.filter(
    (r) => r.arm === "baseline" && r.independentExit === 0,
  ).length,
  candidatePass: all.filter(
    (r) => r.arm === "candidate" && r.independentExit === 0,
  ).length,
  candidateOverlap: all.filter(
    (r) =>
      r.arm === "candidate" && r.kind !== "http-service" && r.overlapObserved,
  ).length,
  duplicateStarts: all.reduce((s, r) => s + (r.duplicateStarts ?? 0), 0),
  failures: all
    .filter(
      (r) =>
        r.error ||
        r.cleanupError ||
        r.cleanupAlive.length ||
        (r.arm === "candidate" && r.independentExit !== 0),
    )
    .map((r) => r.id),
  paidModelCalls: 0,
  modelQuality: "NOT_PROVEN",
};
await writeFile(
  join(out, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
  { flag: "wx" },
);
assert.equal(summary.arms, 48);
assert.equal(summary.failures.length, 0);
assert.equal(summary.candidatePass, 24);
assert(summary.candidatePass >= summary.baselinePass);
assert.equal(summary.duplicateStarts, 0);
assert.equal(summary.candidateOverlap, 16);
