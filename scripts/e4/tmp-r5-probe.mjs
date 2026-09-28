// TEMPORARY R5 probe (deleted before commit): why does a write_file call not land?
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const ARM = process.argv[2] ?? join(process.env.TEMP ?? "/tmp", "r97-arms-n1pair", "baseline");
const CASE = process.argv[3] ?? "regression/reg-12-csv-parse";

const mod = await import(pathToFileURL(join(REPO_ROOT, "packages/evaluation/dist/index.js")).href);
const identityMod = await import(pathToFileURL(join(REPO_ROOT, "apps/cli/dist/prereg-execution-identity.js")).href);
const cli = await import(pathToFileURL(join(ARM, "apps/cli/dist/benchmark-command.js")).href);
const armModel = await import(pathToFileURL(join(ARM, "packages/model/dist/index.js")).href);

const [suite, caseId] = CASE.split("/");
const caseDef = await mod.loadBenchmarkCase(join(REPO_ROOT, "benchmarks", suite, caseId));
const profile = identityMod.formalExecutionProfile({});
const SP = armModel.ScriptedModelProvider;

const content = process.argv[4] ?? "export function parse_csv(line) {\n  return line.split(',').map((f) => f.trim());\n}\n";
const events = [
  ...SP.toolCall("write_file", { path: "src/csv.js", content }),
  ...SP.text("wrote src/csv.js"),
  ...Array.from({ length: 8 }, () => SP.text("nothing further to do")).flat(),
];
const provider = new SP(events);
console.log("provider id", provider.id, "scripts", events.length);
const outcome = await cli.runOneCase(caseDef, { provider, modelId: profile.provider.modelId, budgetTokens: profile.budgetTokens, armId: "baseline", repetition: 1, attempt: 1 }, caseDef.suite ?? "regression");
console.log("status", outcome.status, "actualStatus", outcome.actualStatus);
console.log("violations", outcome.violations);
console.log("failureCategory", outcome.failureCategory);
console.log("metrics.tool_call_count", outcome.metrics?.tool_call_count, "verification_failures", outcome.metrics?.verification_failures);
const interesting = (outcome.events ?? []).filter((e) => /^model\.|^turn\.|^run\./.test(String(e.type)));
console.log("event types", [...new Set((outcome.events ?? []).map((e) => e.type))].join(","));
for (const e of interesting.slice(0, 12)) console.log("EV", e.type, JSON.stringify(e.payload ?? e).slice(0, 700));
