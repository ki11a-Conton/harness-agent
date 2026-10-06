/**
 * N7 — FROZEN case data (part B) for the `context_safe_tool_call_efficiency_v2`
 * main experiment: the 10 `rehydrate` and 6 `partial` evidence-missing cases plus
 * the 16 controls (8 `visible`, 4 `changed`, 4 `diagnostic`).
 *
 * Part A + part B = the 64-case main set the pre-registration freezes. The
 * controls are deliberately authored as genuinely different small defects (each
 * with its own module, its own assertions and its own reference fix) so the
 * candidate cannot "win" the control group by pattern-matching one shape; the
 * `changed` cases carry a setup step that rewrites the file before the fix, and
 * the `diagnostic` cases ship a failing check the model is expected to re-run.
 */

import { partial, rehydrate } from "./n7-case-helpers.mjs";

const VISIBLE = (id, tags, request, expected, fixture, verifierScript, referenceFix) => ({
  id,
  condition: "visible",
  tags,
  request,
  expected,
  fixture,
  verifier: { command: "node", args: ["-e", verifierScript] },
  referenceFix,
});

const CHANGED = (id, tags, request, expected, fixture, verifierScript, referenceFix, referenceRun) => ({
  id,
  condition: "changed",
  tags,
  request,
  expected,
  fixture,
  verifier: { command: "node", args: ["-e", verifierScript] },
  referenceFix,
  referenceRun,
});

const DIAGNOSTIC = (id, tags, request, expected, fixture, referenceFix) => ({
  id,
  condition: "diagnostic",
  tags,
  request,
  expected,
  fixture,
  verifier: {
    command: "node",
    args: ["-e", `const {execFileSync}=require("node:child_process");execFileSync(process.execPath,["check.js"],{stdio:"inherit"});`],
  },
  referenceFix,
});

export const CASES_B = [
  // ---------------------------------------------------------------------
  // rehydrate (10) — a trivial write happens first; the pointer is restored,
  // the policy CONTENT is not
  // ---------------------------------------------------------------------
  rehydrate({
    id: "n7e-rehydrate-01-fence-tokens",
    modulePath: "src/lease.js",
    constName: "FENCE_TOKENS",
    exportName: "fenceTokens",
    placeholder: 1,
    value: 12,
    specFile: "spec/lease-policy.txt",
    specTitle: "Lease policy",
    specIntro: "Fencing protects against stale writers; the value below is binding.",
    keyLine: "fence_tokens = 12",
    companionFile: "spec/lease-notes.txt",
    companionTitle: "Lease notes",
    companionBody: "A lease is renewed, never silently extended beyond its fence.",
    markerPath: "src/contract-version.js",
    markerConstName: "CONTRACT_VERSION",
    markerExport: "contractVersion",
    markerValue: "3",
    request:
      "Two steps. First create src/contract-version.js exporting contractVersion as the string \"3\". Then read spec/lease-policy.txt and set src/lease.js so it exports fenceTokens equal to the documented value.",
    expected: "src/contract-version.js exports the string 3 and src/lease.js exports fenceTokens from spec/lease-policy.txt.",
  }),
  rehydrate({
    id: "n7e-rehydrate-02-batch-window",
    modulePath: "src/batch.js",
    constName: "BATCH_WINDOW_SECONDS",
    exportName: "batchWindowSeconds",
    placeholder: 30,
    value: 240,
    specFile: "spec/batch-policy.txt",
    specTitle: "Batch policy",
    specIntro: "Batch windows are contractual for the ingest tier; the value below is binding.",
    keyLine: "batch_window_seconds = 240",
    companionFile: "spec/batch-notes.txt",
    companionTitle: "Batch notes",
    companionBody: "A batch closes on the window or on the record cap, whichever comes first.",
    markerPath: "src/pipeline-stage.js",
    markerConstName: "PIPELINE_STAGE",
    markerExport: "pipelineStage",
    markerValue: "load",
    request:
      "Two steps. First create src/pipeline-stage.js exporting pipelineStage as the string \"load\". Then read spec/batch-policy.txt and make src/batch.js export the documented batch window in seconds.",
    expected: "src/pipeline-stage.js exports the string load and src/batch.js exports the documented batchWindowSeconds.",
  }),
  rehydrate({
    id: "n7e-rehydrate-03-handoff-bytes",
    modulePath: "src/handoff.js",
    constName: "HANDOFF_BYTES",
    exportName: "handoffBytes",
    placeholder: 4096,
    value: 524288,
    specFile: "spec/handoff-policy.txt",
    specTitle: "Handoff policy",
    specIntro: "Cross-service handoffs are size limited; the value below is binding.",
    keyLine: "handoff_bytes = 524288",
    companionFile: "spec/handoff-notes.txt",
    companionTitle: "Handoff notes",
    companionBody: "Oversized handoffs are streamed, never buffered whole.",
    markerPath: "src/schema-tag.js",
    markerConstName: "SCHEMA_TAG",
    markerExport: "schemaTag",
    markerValue: "C",
    request:
      "Two steps. First create src/schema-tag.js exporting schemaTag as the string \"C\". Then read spec/handoff-policy.txt and set src/handoff.js so it exports the documented handoff size in bytes.",
    expected: "src/schema-tag.js exports the string C and src/handoff.js exports the documented handoffBytes.",
  }),
  rehydrate({
    id: "n7e-rehydrate-04-drain-timeout",
    modulePath: "src/drain.js",
    constName: "DRAIN_TIMEOUT_SECONDS",
    exportName: "drainTimeoutSeconds",
    placeholder: 20,
    value: 120,
    specFile: "spec/drain-policy.txt",
    specTitle: "Drain policy",
    specIntro: "Connection draining has a fixed grace period; the value below is binding.",
    keyLine: "drain_timeout_seconds = 120",
    companionFile: "spec/drain-notes.txt",
    companionTitle: "Drain notes",
    companionBody: "Draining starts before the load balancer is told to stop routing.",
    markerPath: "src/release-tag.js",
    markerConstName: "RELEASE_TAG",
    markerExport: "releaseTag",
    markerValue: "rc1",
    request:
      "Two steps. First create src/release-tag.js exporting releaseTag as the string \"rc1\". Then read spec/drain-policy.txt and make src/drain.js export the documented drain timeout.",
    expected: "src/release-tag.js exports the string rc1 and src/drain.js exports the documented drainTimeoutSeconds.",
  }),
  rehydrate({
    id: "n7e-rehydrate-05-shard-keys",
    modulePath: "src/shard.js",
    constName: "SHARD_KEYS",
    exportName: "shardKeys",
    placeholder: 512,
    value: 4096,
    specFile: "spec/shard-policy.txt",
    specTitle: "Shard policy",
    specIntro: "The key space per shard is published; the value below is binding.",
    keyLine: "shard_keys = 4096",
    companionFile: "spec/shard-notes.txt",
    companionTitle: "Shard notes",
    companionBody: "Keys are hashed before mapping; the space is not resized in place.",
    markerPath: "src/build-channel.js",
    markerConstName: "BUILD_CHANNEL",
    markerExport: "buildChannel",
    markerValue: "nightly",
    request:
      "Two steps. First create src/build-channel.js exporting buildChannel as the string \"nightly\". Then read spec/shard-policy.txt and set src/shard.js so it exports the documented key space.",
    expected: "src/build-channel.js exports the string nightly and src/shard.js exports the documented shardKeys.",
  }),
  rehydrate({
    id: "n7e-rehydrate-06-token-budget",
    modulePath: "src/budget.js",
    constName: "TOKEN_BUDGET",
    exportName: "tokenBudget",
    placeholder: 20000,
    value: 100000,
    specFile: "spec/budget-policy.txt",
    specTitle: "Budget policy",
    specIntro: "Per-request model token budgets are fixed; the value below is binding.",
    keyLine: "token_budget = 100000",
    companionFile: "spec/budget-notes.txt",
    companionTitle: "Budget notes",
    companionBody: "A budget overrun fails the request; it is never silently truncated.",
    markerPath: "src/api-revision.js",
    markerConstName: "API_REVISION",
    markerExport: "apiRevision",
    markerValue: "r7",
    request:
      "Two steps. First create src/api-revision.js exporting apiRevision as the string \"r7\". Then read spec/budget-policy.txt and make src/budget.js export the documented token budget.",
    expected: "src/api-revision.js exports the string r7 and src/budget.js exports the documented tokenBudget.",
  }),
  rehydrate({
    id: "n7e-rehydrate-07-quantile",
    modulePath: "src/quantile.js",
    constName: "QUANTILE_BP",
    exportName: "quantileBp",
    placeholder: 9500,
    value: 9990,
    specFile: "spec/quantile-policy.txt",
    specTitle: "Quantile policy",
    specIntro: "Latency objectives are defined at a specific quantile; the value below is binding.",
    keyLine: "quantile_bp = 9990",
    companionFile: "spec/quantile-notes.txt",
    companionTitle: "Quantile notes",
    companionBody: "Quantiles are computed from histograms, never from sampled logs.",
    markerPath: "src/config-schema.js",
    markerConstName: "CONFIG_SCHEMA",
    markerExport: "configSchema",
    markerValue: "v4",
    request:
      "Two steps. First create src/config-schema.js exporting configSchema as the string \"v4\". Then read spec/quantile-policy.txt and set src/quantile.js so it exports the documented quantile in basis points.",
    expected: "src/config-schema.js exports the string v4 and src/quantile.js exports the documented quantileBp.",
  }),
  rehydrate({
    id: "n7e-rehydrate-08-throttle-burst",
    modulePath: "src/throttle.js",
    constName: "THROTTLE_BURST",
    exportName: "throttleBurst",
    placeholder: 10,
    value: 75,
    specFile: "spec/throttle-policy.txt",
    specTitle: "Throttle policy",
    specIntro: "Burst allowances accompany the steady-state rate; the value below is binding.",
    keyLine: "throttle_burst = 75",
    companionFile: "spec/throttle-notes.txt",
    companionTitle: "Throttle notes",
    companionBody: "Burst credit refills continuously; it does not accumulate across windows.",
    markerPath: "src/runtime-tier.js",
    markerConstName: "RUNTIME_TIER",
    markerExport: "runtimeTier",
    markerValue: "standard",
    request:
      "Two steps. First create src/runtime-tier.js exporting runtimeTier as the string \"standard\". Then read spec/throttle-policy.txt and make src/throttle.js export the documented burst allowance.",
    expected: "src/runtime-tier.js exports the string standard and src/throttle.js exports the documented throttleBurst.",
  }),
  rehydrate({
    id: "n7e-rehydrate-09-scrub-interval",
    modulePath: "src/scrub.js",
    constName: "SCRUB_INTERVAL_HOURS",
    exportName: "scrubIntervalHours",
    placeholder: 24,
    value: 168,
    specFile: "spec/scrub-policy.txt",
    specTitle: "Scrub policy",
    specIntro: "Integrity scrubbing runs on a fixed cadence; the value below is binding.",
    keyLine: "scrub_interval_hours = 168",
    companionFile: "spec/scrub-notes.txt",
    companionTitle: "Scrub notes",
    companionBody: "Scrubbing is read-only; repairs are a separate operation.",
    markerPath: "src/migration-id.js",
    markerConstName: "MIGRATION_ID",
    markerExport: "migrationId",
    markerValue: "m9",
    request:
      "Two steps. First create src/migration-id.js exporting migrationId as the string \"m9\". Then read spec/scrub-policy.txt and set src/scrub.js so it exports the documented scrub interval in hours.",
    expected: "src/migration-id.js exports the string m9 and src/scrub.js exports the documented scrubIntervalHours.",
  }),
  rehydrate({
    id: "n7e-rehydrate-10-commit-delay",
    modulePath: "src/commit.js",
    constName: "COMMIT_DELAY_MS",
    exportName: "commitDelayMs",
    placeholder: 50,
    value: 900,
    specFile: "spec/commit-policy.txt",
    specTitle: "Commit policy",
    specIntro: "Group commit waits a fixed delay before flushing; the value below is binding.",
    keyLine: "commit_delay_ms = 900",
    companionFile: "spec/commit-notes.txt",
    companionTitle: "Commit notes",
    companionBody: "The delay is a ceiling: a full group commits earlier.",
    markerPath: "src/deploy-ring.js",
    markerConstName: "DEPLOY_RING",
    markerExport: "deployRing",
    markerValue: "inner",
    request:
      "Two steps. First create src/deploy-ring.js exporting deployRing as the string \"inner\". Then read spec/commit-policy.txt and make src/commit.js export the documented commit delay.",
    expected: "src/deploy-ring.js exports the string inner and src/commit.js exports the documented commitDelayMs.",
  }),

  // ---------------------------------------------------------------------
  // partial (6) — the orientation document survives, only the binding one is
  // dropped, and only the binding one carries the value the edit needs
  // ---------------------------------------------------------------------
  partial({
    id: "n7e-partial-01-topology-and-limit",
    modulePath: "src/ingest-rate.js",
    constName: "MAX_INGEST_RATE",
    exportName: "maxIngestRate",
    placeholder: 100,
    value: 1800,
    visibleFile: "spec/topology.txt",
    visibleTitle: "Service topology",
    visibleBody: "The ingest service fronts the bus and enforces the binding rate kept in spec/rate-limits.txt.",
    bindingFile: "spec/rate-limits.txt",
    specTitle: "Binding rate limits",
    specIntro: "The edge enforces this rate; the value below is binding.",
    keyLine: "max_ingest_rate = 1800",
    request:
      "src/ingest-rate.js allows the wrong request rate. spec/topology.txt orients you (read it for context) and spec/rate-limits.txt holds the binding limit; read both, then correct src/ingest-rate.js.",
    expected: "src/ingest-rate.js exports maxIngestRate equal to the value in spec/rate-limits.txt.",
  }),
  partial({
    id: "n7e-partial-02-index-and-ceiling",
    modulePath: "src/queue.js",
    constName: "QUEUE_CEILING",
    exportName: "queueCeiling",
    placeholder: 256,
    value: 6400,
    visibleFile: "spec/index.txt",
    visibleTitle: "Specification index",
    visibleBody: "Documents: queue-limits.txt (binding). Nothing else defines the queue ceiling.",
    bindingFile: "spec/queue-limits.txt",
    specTitle: "Queue limits",
    specIntro: "The ceiling is fixed for the current broker; the value below is binding.",
    keyLine: "queue_ceiling = 6400",
    request:
      "src/queue.js caps the broker queue incorrectly. spec/index.txt lists the documents (read it for orientation); the binding ceiling is in spec/queue-limits.txt. Read both and fix src/queue.js.",
    expected: "src/queue.js exports queueCeiling equal to the value in spec/queue-limits.txt.",
  }),
  partial({
    id: "n7e-partial-03-overview-and-ttl",
    modulePath: "src/object.js",
    constName: "OBJECT_TTL_DAYS",
    exportName: "objectTtlDays",
    placeholder: 30,
    value: 120,
    visibleFile: "spec/overview.txt",
    visibleTitle: "Object storage overview",
    visibleBody: "The overview describes tiers; the binding lifetime lives in spec/object-limits.txt.",
    bindingFile: "spec/object-limits.txt",
    specTitle: "Object limits",
    specIntro: "Object lifetimes are enforced at read time; the value below is binding.",
    keyLine: "object_ttl_days = 120",
    request:
      "src/object.js expires stored objects too early. Read spec/overview.txt for orientation and spec/object-limits.txt for the binding lifetime, then correct src/object.js.",
    expected: "src/object.js exports objectTtlDays equal to the value in spec/object-limits.txt.",
  }),
  partial({
    id: "n7e-partial-04-roadmap-and-batch",
    modulePath: "src/mailer.js",
    constName: "MAIL_BATCH",
    exportName: "mailBatch",
    placeholder: 50,
    value: 350,
    visibleFile: "spec/roadmap.txt",
    visibleTitle: "Delivery roadmap",
    visibleBody: "The roadmap describes future work; the binding batch size is kept in spec/mailer-limits.txt.",
    bindingFile: "spec/mailer-limits.txt",
    specTitle: "Mailer limits",
    specIntro: "Batch sizes are agreed with the delivery provider; the value below is binding.",
    keyLine: "mail_batch = 350",
    request:
      "src/mailer.js batches messages with the wrong size. spec/roadmap.txt gives context; spec/mailer-limits.txt carries the binding value. Read both and fix src/mailer.js.",
    expected: "src/mailer.js exports mailBatch equal to the value in spec/mailer-limits.txt.",
  }),
  partial({
    id: "n7e-partial-05-dependency-and-pool",
    modulePath: "src/db.js",
    constName: "DB_POOL_SIZE",
    exportName: "dbPoolSize",
    placeholder: 8,
    value: 64,
    visibleFile: "spec/dependencies.txt",
    visibleTitle: "Dependency map",
    visibleBody: "The map lists callers; the binding database pool size is kept in spec/db-limits.txt.",
    bindingFile: "spec/db-limits.txt",
    specTitle: "Database limits",
    specIntro: "Pool sizes are fixed per database role; the value below is binding.",
    keyLine: "db_pool_size = 64",
    request:
      "src/db.js opens the wrong number of pooled connections. Read spec/dependencies.txt for orientation and spec/db-limits.txt for the binding pool size, then correct src/db.js.",
    expected: "src/db.js exports dbPoolSize equal to the value in spec/db-limits.txt.",
  }),
  partial({
    id: "n7e-partial-06-operations-and-timeout",
    modulePath: "src/gateway-timeout.js",
    constName: "GATEWAY_TIMEOUT_MS",
    exportName: "gatewayTimeoutMs",
    placeholder: 1000,
    value: 4200,
    visibleFile: "spec/operations.txt",
    visibleTitle: "Operations guide",
    visibleBody: "The guide explains escalation; the binding gateway timeout is kept in spec/gateway-limits.txt.",
    bindingFile: "spec/gateway-limits.txt",
    specTitle: "Gateway limits",
    specIntro: "The timeout is agreed with the client team; the value below is binding.",
    keyLine: "gateway_timeout_ms = 4200",
    request:
      "src/gateway-timeout.js cuts requests off too early. spec/operations.txt gives context and spec/gateway-limits.txt holds the binding timeout; read both and fix src/gateway-timeout.js.",
    expected: "src/gateway-timeout.js exports gatewayTimeoutMs equal to the value in spec/gateway-limits.txt.",
  }),

  // ---------------------------------------------------------------------
  // control: visible (8) — everything needed stays in context
  // ---------------------------------------------------------------------
  VISIBLE(
    "n7e-control-01-chunk-tail",
    ["n7", "control", "visible"],
    "src/chunk.js drops the final partial chunk: chunk([1,2,3,4,5], 2) must be [[1,2],[3,4],[5]]. Fix src/chunk.js.",
    "src/chunk.js chunk keeps the trailing partial chunk.",
    {
      "src/chunk.js": `"use strict";\nfunction chunk(xs, size) {\n  const out = [];\n  for (let i = 0; i + size < xs.length; i += size) out.push(xs.slice(i, i + size));\n  return out;\n}\nmodule.exports = { chunk };\n`,
    },
    `const {chunk}=require("./src/chunk.js");const r=chunk([1,2,3,4,5],2);if(JSON.stringify(r)!==JSON.stringify([[1,2],[3,4],[5]])||chunk([],2).length!==0){console.error("n7 verifier failed: chunk");process.exit(1);}`,
    {
      "src/chunk.js": `"use strict";\nfunction chunk(xs, size) {\n  const out = [];\n  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));\n  return out;\n}\nmodule.exports = { chunk };\n`,
    },
  ),
  VISIBLE(
    "n7e-control-02-clamp-bounds",
    ["n7", "control", "visible"],
    "src/clamp.js clamps in the wrong direction: clamp(5, 0, 10) must be 5. Fix src/clamp.js.",
    "src/clamp.js clamp returns the value inside the bounds and the bound outside them.",
    {
      "src/clamp.js": `"use strict";\nfunction clamp(value, low, high) {\n  if (value > low) return low;\n  if (value < high) return high;\n  return value;\n}\nmodule.exports = { clamp };\n`,
    },
    `const {clamp}=require("./src/clamp.js");if(clamp(5,0,10)!==5||clamp(-3,0,10)!==0||clamp(42,0,10)!==10){console.error("n7 verifier failed: clamp");process.exit(1);}`,
    {
      "src/clamp.js": `"use strict";\nfunction clamp(value, low, high) {\n  if (value < low) return low;\n  if (value > high) return high;\n  return value;\n}\nmodule.exports = { clamp };\n`,
    },
  ),
  VISIBLE(
    "n7e-control-03-merge-defaults",
    ["n7", "control", "visible"],
    "src/merge.js only copies keys that already exist in the defaults, so mergeDefaults({a:1},{b:2}) loses b. Fix src/merge.js.",
    "src/merge.js mergeDefaults keeps keys that appear only in the overrides.",
    {
      "src/merge.js": `"use strict";\nfunction mergeDefaults(defaults, overrides) {\n  const out = { ...defaults };\n  for (const key of Object.keys(defaults)) {\n    if (overrides[key] !== undefined) out[key] = overrides[key];\n  }\n  return out;\n}\nmodule.exports = { mergeDefaults };\n`,
    },
    `const {mergeDefaults}=require("./src/merge.js");const a=mergeDefaults({a:1},{b:2});const b=mergeDefaults({a:1},{a:3});if(JSON.stringify(a)!==JSON.stringify({a:1,b:2})||JSON.stringify(b)!==JSON.stringify({a:3})){console.error("n7 verifier failed: mergeDefaults");process.exit(1);}`,
    {
      "src/merge.js": `"use strict";\nfunction mergeDefaults(defaults, overrides) {\n  const out = { ...defaults };\n  for (const key of Object.keys(overrides)) {\n    if (overrides[key] !== undefined) out[key] = overrides[key];\n  }\n  return out;\n}\nmodule.exports = { mergeDefaults };\n`,
    },
  ),
  VISIBLE(
    "n7e-control-04-unique-order",
    ["n7", "control", "visible"],
    "src/unique.js removes duplicates but returns the survivors in reverse order: unique([3,1,3,2]) must be [3,1,2]. Fix src/unique.js.",
    "src/unique.js unique keeps first-seen order.",
    {
      "src/unique.js": `"use strict";\nfunction unique(xs) {\n  const seen = new Set();\n  const out = [];\n  for (let i = xs.length - 1; i >= 0; i -= 1) {\n    if (!seen.has(xs[i])) {\n      seen.add(xs[i]);\n      out.push(xs[i]);\n    }\n  }\n  return out;\n}\nmodule.exports = { unique };\n`,
    },
    `const {unique}=require("./src/unique.js");const r=unique([3,1,3,2]);if(JSON.stringify(r)!==JSON.stringify([3,1,2])){console.error("n7 verifier failed: unique");process.exit(1);}`,
    {
      "src/unique.js": `"use strict";\nfunction unique(xs) {\n  const seen = new Set();\n  const out = [];\n  for (const x of xs) {\n    if (!seen.has(x)) {\n      seen.add(x);\n      out.push(x);\n    }\n  }\n  return out;\n}\nmodule.exports = { unique };\n`,
    },
  ),
  VISIBLE(
    "n7e-control-05-format-bytes",
    ["n7", "control", "visible"],
    "src/bytes.js formats sizes with a decimal divisor and never leaves the KB unit: formatBytes(2048) must be \"2.0 KB\" and formatBytes(1048576) must be \"1.0 MB\". Fix src/bytes.js.",
    "src/bytes.js formatBytes uses 1024-based units and switches to MB at 1 MiB.",
    {
      "src/bytes.js": `"use strict";\nfunction formatBytes(bytes) {\n  return (bytes / 1000).toFixed(1) + " KB";\n}\nmodule.exports = { formatBytes };\n`,
    },
    `const {formatBytes}=require("./src/bytes.js");if(formatBytes(2048)!=="2.0 KB"||formatBytes(1048576)!=="1.0 MB"){console.error("n7 verifier failed: formatBytes");process.exit(1);}`,
    {
      "src/bytes.js": `"use strict";\nfunction formatBytes(bytes) {\n  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";\n  return (bytes / 1024).toFixed(1) + " KB";\n}\nmodule.exports = { formatBytes };\n`,
    },
  ),
  VISIBLE(
    "n7e-control-06-word-count",
    ["n7", "control", "visible"],
    "src/words.js counts empty fragments: countWords(\"alpha  beta gamma\") must be 3 and countWords(\"\") must be 0. Fix src/words.js.",
    "src/words.js countWords ignores runs of whitespace and never counts an empty string as a word.",
    {
      "src/words.js": `"use strict";\nfunction countWords(text) {\n  return text.split(" ").length;\n}\nmodule.exports = { countWords };\n`,
    },
    `const {countWords}=require("./src/words.js");if(countWords("alpha  beta gamma")!==3||countWords("")!==0||countWords("  ")!==0){console.error("n7 verifier failed: countWords");process.exit(1);}`,
    {
      "src/words.js": `"use strict";\nfunction countWords(text) {\n  const trimmed = text.trim();\n  if (trimmed === "") return 0;\n  return trimmed.split(/\\s+/).length;\n}\nmodule.exports = { countWords };\n`,
    },
  ),
  VISIBLE(
    "n7e-control-07-truncate-suffix",
    ["n7", "control", "visible"],
    "src/truncate.js cuts text to exactly the limit with no marker, so a reader cannot tell it was shortened and the result can exceed the limit once a marker is added. truncate(\"abcdefgh\", 8) must be \"abcdefgh\" and truncate(\"abcdefgh\", 5) must be \"ab...\". Fix src/truncate.js.",
    "src/truncate.js returns short text unchanged and otherwise marks the cut while staying within the limit.",
    {
      "src/truncate.js": `"use strict";\nfunction truncate(text, limit) {\n  return text.slice(0, limit);\n}\nmodule.exports = { truncate };\n`,
    },
    `const {truncate}=require("./src/truncate.js");const a=truncate("abcdefgh",8);const b=truncate("abcdefgh",5);if(a!=="abcdefgh"||b!=="ab..."||b.length>5){console.error("n7 verifier failed: truncate");process.exit(1);}`,
    {
      "src/truncate.js": `"use strict";\nfunction truncate(text, limit) {\n  if (text.length <= limit) return text;\n  return text.slice(0, Math.max(0, limit - 3)) + "...";\n}\nmodule.exports = { truncate };\n`,
    },
  ),
  VISIBLE(
    "n7e-control-08-key-order-equal",
    ["n7", "control", "visible"],
    "src/equal.js compares objects by JSON text, so equal({a:1,b:2},{b:2,a:1}) is false. Fix src/equal.js so key order does not matter.",
    "src/equal.js equal is insensitive to key order and still detects different values.",
    {
      "src/equal.js": `"use strict";\nfunction equal(a, b) {\n  return JSON.stringify(a) === JSON.stringify(b);\n}\nmodule.exports = { equal };\n`,
    },
    `const {equal}=require("./src/equal.js");if(equal({a:1,b:2},{b:2,a:1})!==true||equal({a:1},{a:2})!==false||equal({a:{b:1}},{a:{b:1}})!==true){console.error("n7 verifier failed: equal");process.exit(1);}`,
    {
      "src/equal.js": `"use strict";\nfunction equal(a, b) {\n  if (a === b) return true;\n  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;\n  const ka = Object.keys(a).sort();\n  const kb = Object.keys(b).sort();\n  if (ka.length !== kb.length) return false;\n  return ka.every((key, i) => key === kb[i] && equal(a[key], b[key]));\n}\nmodule.exports = { equal };\n`,
    },
  ),

  // ---------------------------------------------------------------------
  // control: changed (4) — a setup command rewrites the file first, so any
  // earlier read is stale; re-reading is already legal
  // ---------------------------------------------------------------------
  CHANGED(
    "n7e-control-09-changed-region",
    ["n7", "control", "changed"],
    "Step 1: run `node setup.js` — it rewrites src/region.js and prints the new region. Step 2: make src/region.js export the region setup.js wrote. A value read before setup.js runs is stale.",
    "src/region.js exports the region that setup.js wrote.",
    {
      "src/region.js": `"use strict";\nmodule.exports = { region: "us-east" };\n`,
      "setup.js": `"use strict";\nconst fs = require("node:fs");\nconst next = "eu-west";\nfs.writeFileSync("src/region.js", '"use strict";\\nmodule.exports = { region: ' + JSON.stringify(next) + " };\\n");\nconsole.log("region=" + next);\n`,
    },
    `const {region}=require("./src/region.js");if(region!=="eu-west"){console.error("n7 verifier failed: region");process.exit(1);}`,
    {},
    ["setup.js"],
  ),
  CHANGED(
    "n7e-control-10-changed-token-ttl",
    ["n7", "control", "changed"],
    "Step 1: run `node rotate.js` — it rewrites config/token.json with a new ttl_seconds. Step 2: make src/load.js return that ttl_seconds, read from the file at call time.",
    "src/load.js tokenTtlSeconds returns the ttl_seconds that rotate.js wrote.",
    {
      "src/load.js": `"use strict";\nfunction tokenTtlSeconds() {\n  return 0;\n}\nmodule.exports = { tokenTtlSeconds };\n`,
      "config/token.json": `{"ttl_seconds":0}\n`,
      "rotate.js": `"use strict";\nconst fs = require("node:fs");\nconst ttl = 900;\nfs.writeFileSync("config/token.json", JSON.stringify({ ttl_seconds: ttl }));\nconsole.log("ttl=" + ttl);\n`,
    },
    `const {tokenTtlSeconds}=require("./src/load.js");if(tokenTtlSeconds()!==900){console.error("n7 verifier failed: tokenTtlSeconds");process.exit(1);}`,
    {
      "src/load.js": `"use strict";\nconst fs = require("node:fs");\nfunction tokenTtlSeconds() {\n  return JSON.parse(fs.readFileSync("config/token.json", "utf8")).ttl_seconds;\n}\nmodule.exports = { tokenTtlSeconds };\n`,
    },
    ["rotate.js"],
  ),
  CHANGED(
    "n7e-control-11-changed-shard-map",
    ["n7", "control", "changed"],
    "Step 1: run `node setup.js` — it rewrites data/shards.json with the shard map. Step 2: make src/lookup.js shardOf(name) return the mapped shard id for that name.",
    "src/lookup.js shardOf returns the shard id recorded in the rewritten data/shards.json.",
    {
      "src/lookup.js": `"use strict";\nfunction shardOf(name) {\n  return -1;\n}\nmodule.exports = { shardOf };\n`,
      "data/shards.json": `{"shards":{}}\n`,
      "setup.js": `"use strict";\nconst fs = require("node:fs");\nconst shards = { alpha: 3, beta: 7 };\nfs.writeFileSync("data/shards.json", JSON.stringify({ shards }));\nconsole.log("shards=" + Object.keys(shards).length);\n`,
    },
    `const {shardOf}=require("./src/lookup.js");if(shardOf("beta")!==7||shardOf("alpha")!==3){console.error("n7 verifier failed: shardOf");process.exit(1);}`,
    {
      "src/lookup.js": `"use strict";\nconst fs = require("node:fs");\nfunction shardOf(name) {\n  return JSON.parse(fs.readFileSync("data/shards.json", "utf8")).shards[name];\n}\nmodule.exports = { shardOf };\n`,
    },
    ["setup.js"],
  ),
  CHANGED(
    "n7e-control-12-changed-retention",
    ["n7", "control", "changed"],
    "Step 1: run `node rotate.js` — it rewrites policy/retention.json. Step 2: make src/policy.js retentionDays return the days recorded in that file.",
    "src/policy.js retentionDays returns the days rotate.js wrote into policy/retention.json.",
    {
      "src/policy.js": `"use strict";\nfunction retentionDays() {\n  return 0;\n}\nmodule.exports = { retentionDays };\n`,
      "policy/retention.json": `{"days":0}\n`,
      "rotate.js": `"use strict";\nconst fs = require("node:fs");\nconst days = 365;\nfs.writeFileSync("policy/retention.json", JSON.stringify({ days }));\nconsole.log("days=" + days);\n`,
    },
    `const {retentionDays}=require("./src/policy.js");if(retentionDays()!==365){console.error("n7 verifier failed: retentionDays");process.exit(1);}`,
    {
      "src/policy.js": `"use strict";\nconst fs = require("node:fs");\nfunction retentionDays() {\n  return JSON.parse(fs.readFileSync("policy/retention.json", "utf8")).days;\n}\nmodule.exports = { retentionDays };\n`,
    },
    ["rotate.js"],
  ),

  // ---------------------------------------------------------------------
  // control: diagnostic (4) — a shipped check fails; re-running it is legal
  // ---------------------------------------------------------------------
  DIAGNOSTIC(
    "n7e-control-13-failing-fee-check",
    ["n7", "control", "diagnostic"],
    "`node check.js` fails. Read its output, repair src/fee.js, and rerun the same command until it exits 0. The verifier is that same command.",
    "node check.js exits 0 after the repair.",
    {
      "src/fee.js": `"use strict";\nfunction fee(cents) {\n  return Math.floor((cents * 3) / 100);\n}\nmodule.exports = { fee };\n`,
      "check.js": `"use strict";\nconst { fee } = require("./src/fee.js");\nconst got = fee(10000);\nif (got !== 290) {\n  console.error("expected 290 for 10000 cents at 2.9 percent, got " + got);\n  process.exit(1);\n}\nconsole.log("ok");\n`,
    },
    {
      "src/fee.js": `"use strict";\nfunction fee(cents) {\n  return Math.round((cents * 29) / 1000);\n}\nmodule.exports = { fee };\n`,
    },
  ),
  DIAGNOSTIC(
    "n7e-control-14-failing-ranges-check",
    ["n7", "control", "diagnostic"],
    "`node check.js` reports a failing assertion. Inspect the message, repair src/ranges.js, and rerun the same command until it passes.",
    "node check.js exits 0 after the repair.",
    {
      "src/ranges.js": `"use strict";\nfunction mergeIntervals(xs) {\n  return xs.slice();\n}\nmodule.exports = { mergeIntervals };\n`,
      "check.js": `"use strict";\nconst assert = require("node:assert");\nconst { mergeIntervals } = require("./src/ranges.js");\nassert.deepStrictEqual(mergeIntervals([[1, 3], [2, 6], [8, 10], [15, 18]]), [[1, 6], [8, 10], [15, 18]]);\nconsole.log("ok");\n`,
    },
    {
      "src/ranges.js": `"use strict";\nfunction mergeIntervals(xs) {\n  const sorted = [...xs].sort((a, b) => a[0] - b[0]);\n  const out = [];\n  for (const [start, end] of sorted) {\n    const last = out[out.length - 1];\n    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);\n    else out.push([start, end]);\n  }\n  return out;\n}\nmodule.exports = { mergeIntervals };\n`,
    },
  ),
  DIAGNOSTIC(
    "n7e-control-15-failing-checksum-check",
    ["n7", "control", "diagnostic"],
    "`node check.js` fails on a checksum assertion. Inspect its output, repair src/checksum.js, and rerun the same command until it exits 0.",
    "node check.js exits 0 after the repair.",
    {
      "src/checksum.js": `"use strict";\nfunction checksum(text) {\n  let total = 0;\n  for (const ch of text) total += ch.charCodeAt(0);\n  return total;\n}\nmodule.exports = { checksum };\n`,
      "check.js": `"use strict";\nconst { checksum } = require("./src/checksum.js");\nconst got = checksum("abc");\nif (got !== 43430) {\n  console.error("expected 43430 for abc, got " + got);\n  process.exit(1);\n}\nconsole.log("ok");\n`,
    },
    {
      "src/checksum.js": `"use strict";\nfunction checksum(text) {\n  let h = 0;\n  for (const ch of text) h = (h * 33 + ch.charCodeAt(0)) % 65536;\n  return h;\n}\nmodule.exports = { checksum };\n`,
    },
  ),
  DIAGNOSTIC(
    "n7e-control-16-failing-template-check",
    ["n7", "control", "diagnostic"],
    "`node check.js` fails. The renderer must replace EVERY placeholder occurrence and leave unknown placeholders untouched. Repair src/template.js and rerun the same command until it exits 0.",
    "node check.js exits 0 after the repair.",
    {
      "src/template.js": `"use strict";\nfunction render(text, values) {\n  return text.replace(/\\{\\{(\\w+)\\}\\}/, (whole, key) => (values[key] === undefined ? "" : String(values[key])));\n}\nmodule.exports = { render };\n`,
      "check.js": `"use strict";\nconst { render } = require("./src/template.js");\nconst got = render("a {{x}} b {{x}} c {{y}}", { x: 1 });\nif (got !== "a 1 b 1 c {{y}}") {\n  console.error("unexpected render output: " + JSON.stringify(got));\n  process.exit(1);\n}\nconsole.log("ok");\n`,
    },
    {
      "src/template.js": `"use strict";\nfunction render(text, values) {\n  return text.replace(/\\{\\{(\\w+)\\}\\}/g, (whole, key) =>\n    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,\n  );\n}\nmodule.exports = { render };\n`,
    },
  ),
];
