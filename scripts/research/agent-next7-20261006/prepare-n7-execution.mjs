/** Freeze a new execution lineage; leave both original N7 artifacts untouched. */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { arg, bindingDigest, environmentFacts, flag, freshDirectory, INFRASTRUCTURE_GATES, loadExperiment, main, REPO, sourceSnapshot, writeIndex, writeJson } from "./execution-common.mjs";

await main(async () => {
  sourceSnapshot(); // a dirty/unprovable checkout never creates a paid binding
  const command = process.platform === "win32" ? "cmd.exe" : "corepack";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "corepack pnpm exec tsc -b --force"] : ["pnpm", "exec", "tsc", "-b", "--force"];
  execFileSync(command, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const experiments = await Promise.all([loadExperiment("main"), loadExperiment("holdout")]);
  const environment = await environmentFacts({ allowInsecure: flag("allow-insecure-local-benchmark") });
  const binding = { schemaVersion: "n7-execution-binding-v1", lineage: "explicit-source-rebinding-original-preregistration-preserved",
    source: sourceSnapshot(), experiments: experiments.map(e => e.facts), provider: environment.provider,
    pricing: environment.pricing, isolation: environment.isolation, bootstrapSeed: 20261005,
    infrastructureGates: INFRASTRUCTURE_GATES,
    evidenceKind: "REAL_PROVIDER_REQUIRED", modelQuality: "NOT_RUN", promotion: "NOT_RUN" };
  binding.executionBindingDigest = bindingDigest(binding);
  const out = freshDirectory(resolve(arg("out", join(REPO, ".ci/n7/execution-binding"))));
  writeJson(join(out, "execution-binding.json"), binding);
  writeJson(join(out, "readiness.json"), { modelQuality: "NOT_RUN", paidProviderCalls: 0,
    blockers: [...(!environment.credentialPresent ? ["CREDENTIAL_MISSING"] : []), ...(binding.pricing === null ? ["PRICING_UNKNOWN"] : []),
      ...(binding.isolation.strength === "unavailable" ? ["STRONG_ISOLATION_REQUIRED"] : [])],
    note: "Original duration/token/tool/USD caps remain fixed; missing inputs require a fresh binding before a real soak." });
  writeIndex(out);
  process.stdout.write(`N7 execution binding ${binding.executionBindingDigest}; main=512 holdout=192 paidCalls=0\n`);
});
