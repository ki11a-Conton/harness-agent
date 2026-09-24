// E4-R92 — produce the authorization-ready plan and run the offline rehearsal.
//
// This is the deliverable driver for plan §R92. It:
//   1. runs the full fake-provider rehearsal matrix against the REAL paired
//      executor (0 external requests, structurally — it constructs its own
//      in-process providers and is handed no credentials);
//   2. builds the authorization envelope from real repository facts;
//   3. writes the approval package for the user to decide on.
//
// It NEVER executes the paid A/B. Its only outputs are the plan, the rehearsal
// verdict and an exit code that says whether the plan is authorization-ready.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// On Windows an absolute path is not a valid ESM specifier, so it must be
// converted to a file:// URL before a dynamic import.
const evaluation = await import(
  pathToFileURL(join(repoRoot, "packages", "evaluation", "dist", "index.js")).href
);

const {
  buildR92AuthorizationPlan,
  runR92Rehearsal,
  R92_REHEARSAL_SCHEMA,
} = evaluation;

const outDir = join(repoRoot, ".ci", "r92-auth");
await mkdir(outDir, { recursive: true });

// ---- 1. Rehearsal ---------------------------------------------------------
const rehearsalDir = join(outDir, "rehearsal");
const rehearsal = await runR92Rehearsal({ workDir: rehearsalDir });

const failed = rehearsal.scenarios.filter((s) => !s.stoppedAsAgreed);
const lines = [];
lines.push(`E4-R92 offline rehearsal — schema ${rehearsal.schemaVersion}`);
lines.push(`external requests declared: ${rehearsal.externalRequests}`);
lines.push(`fake provider requests made: ${rehearsal.providerRequests}`);
lines.push(`real scores: ${rehearsal.realScores}  ·  pass-rate claim: ${rehearsal.passRateClaim}`);
lines.push("");
lines.push("scenario                              authorized  run       code                          stopped-as-agreed  provider-reqs");
for (const s of rehearsal.scenarios) {
  lines.push(
    [
      s.id.padEnd(36),
      String(s.authorizedToExecute).padEnd(11),
      s.runStatus.padEnd(9),
      String(s.code ?? "-").padEnd(29),
      String(s.stoppedAsAgreed).padEnd(18),
      String(s.providerRequests),
    ].join(" "),
  );
}
lines.push("");
lines.push(`scenarios: ${rehearsal.scenarios.length}  ·  failed: ${failed.length}`);
if (failed.length > 0) {
  lines.push("");
  lines.push("FAILED SCENARIOS:");
  for (const s of failed) lines.push(`  - ${s.id}: ${s.proves}`);
}
const rehearsalText = lines.join("\n");
console.log(rehearsalText);

if (rehearsal.schemaVersion !== R92_REHEARSAL_SCHEMA) {
  console.error(`unexpected rehearsal schema: ${rehearsal.schemaVersion}`);
  process.exit(1);
}
if (failed.length > 0) {
  console.error("\nE4-R92: rehearsal FAILED — refusing to present the plan for authorization.");
  process.exit(1);
}

// ---- 2. Authorization plan ------------------------------------------------
const plan = await buildR92AuthorizationPlan({ repoRoot });

// ---- 3. Approval package --------------------------------------------------
await writeFile(join(outDir, "approval-package.md"), plan.approvalMarkdown, "utf8");
await writeFile(
  join(outDir, "authorization.json"),
  `${JSON.stringify(
    {
      authorization: plan.authorization,
      planDigest: plan.planDigest,
      facts: plan.facts,
      realScores: plan.realScores,
      passRateClaim: plan.passRateClaim,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await writeFile(join(outDir, "rehearsal.txt"), `${rehearsalText}\n`, "utf8");

console.log("");
console.log("=".repeat(72));
console.log("E4-R92 AUTHORIZATION REQUEST");
console.log("=".repeat(72));
console.log(`plan digest : ${plan.planDigest}`);
console.log(`expires     : ${plan.authorization.expiresAt}`);
console.log(`baseline    : ${plan.authorization.arms.baseline.sha}`);
console.log(`candidate   : ${plan.authorization.arms.candidate.sha}`);
console.log(`cases       : ${plan.authorization.caseIds.length} (non-holdout dev set)`);
console.log(`shim verifs : ${plan.facts.shimAffectedVerifiers} (0 = H2 delta not confounded by R91)`);
console.log(`output dir  : ${plan.authorization.outputDir}`);
console.log("");
console.log("status      : READY_FOR_AUTHORIZATION / NOT_RUN");
console.log("Nothing has been executed. Approve the digest above to authorize the run.");
console.log("");
console.log(`artifacts written to: ${outDir}`);
