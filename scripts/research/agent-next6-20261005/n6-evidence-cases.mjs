/**
 * N6 / N2 — the FROZEN case data for the `context_safe_tool_call_efficiency_v1`
 * main experiment (24 cases: 16 evidence-missing + 8 control).
 *
 * Why this file exists: the main experiment may only be pre-registered against
 * cases that are frozen BEFORE any model result. The cases are therefore
 * generated from this single data module, and the generated on-disk bytes are
 * checked against it (`generate-n6-cases.mjs --check`), so a later edit that
 * silently changes a case is refused instead of quietly changing what was
 * evaluated.
 *
 * Condition classes (the plan's 16 missing cases):
 *   compact-drop   6 — a case-local `contextBudgetTokens` makes the context
 *                     compact after the authoritative spec has been read. The
 *                     runtime's tool-result blocks are `ephemeral`, so
 *                     compaction drops the spec TEXT (the digest only records
 *                     files WRITTEN, never files read). The edit still needs
 *                     the spec value, so it must be re-read.
 *   preview        4 — one evidence file is larger than the 16 KiB inline
 *                     budget, so the model sees head+tail only and the needed
 *                     value sits in the DROPPED middle. Re-acquiring it needs a
 *                     bounded lookup (the existing grep_search), never an
 *                     invented offset/limit read parameter.
 *   rehydrate      4 — a first, trivial write happens before the real edit, so
 *                     rehydration's "Files in play" names the WRITTEN file while
 *                     the spec value stays unavailable: the pointer is restored,
 *                     the content is not.
 *   partial        2 — two evidence files, one still visible and one dropped;
 *                     only the dropped one carries the value the edit needs.
 *
 * Control classes (the 8 controls — the candidate must not cost anything here):
 *   visible        4 — everything stays visible and unchanged; the fix is
 *                     self-evident from what is already in context.
 *   changed        2 — a setup command rewrites the file first, so an earlier
 *                     read is stale and must be re-read (v2 already allows this).
 *   diagnostic     2 — the workspace ships a failing check; re-running that same
 *                     command after a repair is legitimate (v2 already allows it).
 *
 * Every case has its own fixture bytes, its own task text and its own command
 * verifier; `n6-evidence-cases.test.ts` refuses duplicate fixture content or
 * duplicate task text, and proves each verifier DISCRIMINATES (it fails on the
 * shipped fixture and passes on the reference fix). No case is a renamed copy
 * of another.
 */

import {
  assertExport,
  companion,
  EXPECTED_COMPOSITION,
  largeSpec,
  mediumSpec,
  verifier,
} from "./n6-case-helpers.mjs";

export { EXPECTED_COMPOSITION };

export const CASES = [
  // ---------------------------------------------------------------------
  // compact-drop (6)
  // ---------------------------------------------------------------------
  {
    id: "n6e-compact-01-retry-base",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "compact-drop"],
    request:
      "src/backoff.js exports baseMs, but the shipped constant is a placeholder. The authoritative base delay is defined by the retry policy in spec/retry-policy.txt; read that policy, then make src/backoff.js export the correct baseMs. Do not guess the number.",
    expected: "src/backoff.js exports baseMs equal to the base_delay_ms value defined in spec/retry-policy.txt.",
    fixture: {
      "src/backoff.js": `"use strict";\n// Placeholder: the retry policy defines the authoritative base delay.\nconst BASE_MS = 100;\nmodule.exports = { baseMs: BASE_MS };\n`,
      "spec/retry-policy.txt": mediumSpec(
        "Retry policy",
        "This policy is the single source of truth for the retry ladder.",
        "base_delay_ms = 250",
      ),
      "spec/runbook.txt": companion(
        "Runbook",
        "Operators must not tune the retry ladder by hand; the policy file above is authoritative.",
      ),
    },
    verifier: verifier(assertExport("./src/backoff.js", "m.baseMs === 250")),
    referenceFix: {
      "src/backoff.js": `"use strict";\nconst BASE_MS = 250;\nmodule.exports = { baseMs: BASE_MS };\n`,
    },
  },
  {
    id: "n6e-compact-02-page-size",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "compact-drop"],
    request:
      "src/pagination.js returns the wrong default page size. The API limits document in spec/api-limits.txt states the default page size this service must use; read it and correct src/pagination.js. Never invent the number.",
    expected: "src/pagination.js exports defaultPageSize equal to the value in spec/api-limits.txt.",
    fixture: {
      "src/pagination.js": `"use strict";\nconst DEFAULT_PAGE_SIZE = 20;\nmodule.exports = { defaultPageSize: DEFAULT_PAGE_SIZE };\n`,
      "spec/api-limits.txt": mediumSpec(
        "API limits",
        "Limits agreed with the platform team; the default page size below is binding.",
        "default_page_size = 37",
      ),
      "spec/changelog.txt": companion(
        "Changelog",
        "The previous default was retired; only the limits document above is current.",
      ),
    },
    verifier: verifier(assertExport("./src/pagination.js", "m.defaultPageSize === 37")),
    referenceFix: { "src/pagination.js": `"use strict";\nconst DEFAULT_PAGE_SIZE = 37;\nmodule.exports = { defaultPageSize: DEFAULT_PAGE_SIZE };\n` },
  },
  {
    id: "n6e-compact-03-request-timeout",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "compact-drop"],
    request:
      "src/http.js hardcodes a request timeout that no longer matches the service level objective. Read spec/slo.txt to obtain the required timeout, then set it in src/http.js.",
    expected: "src/http.js exports timeoutMs equal to the timeout recorded in spec/slo.txt.",
    fixture: {
      "src/http.js": `"use strict";\nconst TIMEOUT_MS = 5000;\nmodule.exports = { timeoutMs: TIMEOUT_MS };\n`,
      "spec/slo.txt": mediumSpec(
        "Service level objective",
        "The objectives below are measured monthly; the timeout is a hard requirement.",
        "request_timeout_ms = 12500",
      ),
      "spec/oncall.txt": companion("On-call notes", "Escalate before changing anything in the objective file above."),
    },
    verifier: verifier(assertExport("./src/http.js", "m.timeoutMs === 12500")),
    referenceFix: { "src/http.js": `"use strict";\nconst TIMEOUT_MS = 12500;\nmodule.exports = { timeoutMs: TIMEOUT_MS };\n` },
  },
  {
    id: "n6e-compact-04-max-attempts",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "compact-drop"],
    request:
      "src/queue.js retries too few times. spec/queue-policy.txt defines how many attempts a job gets; read the policy and update src/queue.js accordingly.",
    expected: "src/queue.js exports maxAttempts equal to the attempt count defined in spec/queue-policy.txt.",
    fixture: {
      "src/queue.js": `"use strict";\nconst MAX_ATTEMPTS = 3;\nmodule.exports = { maxAttempts: MAX_ATTEMPTS };\n`,
      "spec/queue-policy.txt": mediumSpec(
        "Queue policy",
        "The attempt budget is agreed with the data platform; it is not a local tuning knob.",
        "max_attempts = 7",
      ),
      "spec/queue-faq.txt": companion("Queue FAQ", "A job that exhausts its attempts is parked, never dropped."),
    },
    verifier: verifier(assertExport("./src/queue.js", "m.maxAttempts === 7")),
    referenceFix: { "src/queue.js": `"use strict";\nconst MAX_ATTEMPTS = 7;\nmodule.exports = { maxAttempts: MAX_ATTEMPTS };\n` },
  },
  {
    id: "n6e-compact-05-cache-ttl",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "compact-drop"],
    request:
      "src/cache.js uses a stale time to live. spec/cache-policy.txt records the current TTL in seconds; read it and set src/cache.js to that value.",
    expected: "src/cache.js exports ttlSeconds equal to the TTL recorded in spec/cache-policy.txt.",
    fixture: {
      "src/cache.js": `"use strict";\nconst TTL_SECONDS = 60;\nmodule.exports = { ttlSeconds: TTL_SECONDS };\n`,
      "spec/cache-policy.txt": mediumSpec(
        "Cache policy",
        "The TTL below was renegotiated with the origin owners.",
        "ttl_seconds = 900",
      ),
      "spec/cache-notes.txt": companion("Cache notes", "Purging is manual; the policy file above is the only TTL source."),
    },
    verifier: verifier(assertExport("./src/cache.js", "m.ttlSeconds === 900")),
    referenceFix: { "src/cache.js": `"use strict";\nconst TTL_SECONDS = 900;\nmodule.exports = { ttlSeconds: TTL_SECONDS };\n` },
  },
  {
    id: "n6e-compact-06-batch-width",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "compact-drop"],
    request:
      "src/batch.js batches more rows than the warehouse accepts. spec/etl-limits.txt states the maximum batch width; read it and correct src/batch.js.",
    expected: "src/batch.js exports batchSize equal to the maximum width in spec/etl-limits.txt.",
    fixture: {
      "src/batch.js": `"use strict";\nconst BATCH_SIZE = 100;\nmodule.exports = { batchSize: BATCH_SIZE };\n`,
      "spec/etl-limits.txt": mediumSpec(
        "ETL limits",
        "The warehouse rejects oversized batches; the limit below is enforced upstream.",
        "max_batch_rows = 64",
      ),
      "spec/etl-runbook.txt": companion("ETL runbook", "Splitting a batch is preferred over retrying a rejected one."),
    },
    verifier: verifier(assertExport("./src/batch.js", "m.batchSize === 64")),
    referenceFix: { "src/batch.js": `"use strict";\nconst BATCH_SIZE = 64;\nmodule.exports = { batchSize: BATCH_SIZE };\n` },
  },

  // ---------------------------------------------------------------------
  // preview (4) — the value sits in the middle of a >16 KiB file
  // ---------------------------------------------------------------------
  {
    id: "n6e-preview-01-frame-limit",
    condition: "preview",
    tags: ["n6", "evidence-missing", "preview"],
    request:
      "src/framing.js advertises a maximum frame size that is wrong. The protocol specification spec/protocol.txt defines max_frame_bytes; read the specification and correct src/framing.js.",
    expected: "src/framing.js exports maxFrameBytes equal to max_frame_bytes in spec/protocol.txt.",
    fixture: {
      "src/framing.js": `"use strict";\nconst MAX_FRAME_BYTES = 4096;\nmodule.exports = { maxFrameBytes: MAX_FRAME_BYTES };\n`,
      "spec/protocol.txt": largeSpec(
        "Wire protocol specification",
        "This document is normative. Values are spread through the document.",
        "max_frame_bytes = 6144",
        "End of specification.",
      ),
    },
    verifier: verifier(assertExport("./src/framing.js", "m.maxFrameBytes === 6144")),
    referenceFix: { "src/framing.js": `"use strict";\nconst MAX_FRAME_BYTES = 6144;\nmodule.exports = { maxFrameBytes: MAX_FRAME_BYTES };\n` },
  },
  {
    id: "n6e-preview-02-shard-count",
    condition: "preview",
    tags: ["n6", "evidence-missing", "preview"],
    request:
      "src/topology.js declares the wrong shard count. spec/topology.txt is the authoritative topology document; read it and fix src/topology.js.",
    expected: "src/topology.js exports shardCount equal to shard_count in spec/topology.txt.",
    fixture: {
      "src/topology.js": `"use strict";\nconst SHARD_COUNT = 8;\nmodule.exports = { shardCount: SHARD_COUNT };\n`,
      "spec/topology.txt": largeSpec(
        "Topology document",
        "Owned by the storage team; the shard count is binding.",
        "shard_count = 23",
        "End of topology document.",
      ),
    },
    verifier: verifier(assertExport("./src/topology.js", "m.shardCount === 23")),
    referenceFix: { "src/topology.js": `"use strict";\nconst SHARD_COUNT = 23;\nmodule.exports = { shardCount: SHARD_COUNT };\n` },
  },
  {
    id: "n6e-preview-03-burst-quota",
    condition: "preview",
    tags: ["n6", "evidence-missing", "preview"],
    request:
      "src/quota.js allows the wrong burst. spec/quota.txt defines burst_quota; read the document and set src/quota.js to the documented value.",
    expected: "src/quota.js exports burstQuota equal to burst_quota in spec/quota.txt.",
    fixture: {
      "src/quota.js": `"use strict";\nconst BURST_QUOTA = 100;\nmodule.exports = { burstQuota: BURST_QUOTA };\n`,
      "spec/quota.txt": largeSpec(
        "Quota document",
        "Ratified by the capacity board; the burst quota below is enforced.",
        "burst_quota = 480",
        "End of quota document.",
      ),
    },
    verifier: verifier(assertExport("./src/quota.js", "m.burstQuota === 480")),
    referenceFix: { "src/quota.js": `"use strict";\nconst BURST_QUOTA = 480;\nmodule.exports = { burstQuota: BURST_QUOTA };\n` },
  },
  {
    id: "n6e-preview-04-service-port",
    condition: "preview",
    tags: ["n6", "evidence-missing", "preview"],
    request:
      "src/network.js listens on the wrong port. spec/network.txt records the assigned service port; read it and correct src/network.js.",
    expected: "src/network.js exports servicePort equal to service_port in spec/network.txt.",
    fixture: {
      "src/network.js": `"use strict";\nconst SERVICE_PORT = 8080;\nmodule.exports = { servicePort: SERVICE_PORT };\n`,
      "spec/network.txt": largeSpec(
        "Network allocation",
        "Port assignments are centrally managed; the entry below is the assignment.",
        "service_port = 8642",
        "End of network allocation.",
      ),
    },
    verifier: verifier(assertExport("./src/network.js", "m.servicePort === 8642")),
    referenceFix: { "src/network.js": `"use strict";\nconst SERVICE_PORT = 8642;\nmodule.exports = { servicePort: SERVICE_PORT };\n` },
  },

  // ---------------------------------------------------------------------
  // rehydrate (4) — a trivial write first, then the real edit
  // ---------------------------------------------------------------------
  {
    id: "n6e-rehydrate-01-lease-fence",
    condition: "rehydrate",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "rehydrate"],
    request:
      "Two steps. First create src/version.js exporting version as the string \"2\". Then read spec/lease-policy.txt and set the fence value in src/lease.js so that it exports fenceTokens equal to the documented value.",
    expected: "src/version.js exports the string 2 and src/lease.js exports fenceTokens from spec/lease-policy.txt.",
    fixture: {
      "src/lease.js": `"use strict";\nconst FENCE_TOKENS = 1;\nmodule.exports = { fenceTokens: FENCE_TOKENS };\n`,
      "spec/lease-policy.txt": mediumSpec(
        "Lease policy",
        "Fencing protects against stale writers; the value below is binding.",
        "fence_tokens = 12",
      ),
      "spec/lease-notes.txt": companion("Lease notes", "A lease is renewed, never silently extended."),
    },
    verifier: verifier(
      `${assertExport("./src/lease.js", "m.fenceTokens === 12")}\nconst v=require("./src/version.js");if(v.version!=="2"){console.error("n6 verifier failed: version");process.exit(1);}`,
    ),
    referenceFix: {
      "src/lease.js": `"use strict";\nconst FENCE_TOKENS = 12;\nmodule.exports = { fenceTokens: FENCE_TOKENS };\n`,
      "src/version.js": `"use strict";\nmodule.exports = { version: "2" };\n`,
    },
  },
  {
    id: "n6e-rehydrate-02-window",
    condition: "rehydrate",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "rehydrate"],
    request:
      "Two steps. First create src/manifest.js exporting schema as \"B\". Then read spec/window-policy.txt and set src/window.js so it exports windowSeconds equal to the documented value.",
    expected: "src/manifest.js exports schema B and src/window.js exports the documented windowSeconds.",
    fixture: {
      "src/window.js": `"use strict";\nconst WINDOW_SECONDS = 30;\nmodule.exports = { windowSeconds: WINDOW_SECONDS };\n`,
      "spec/window-policy.txt": mediumSpec(
        "Window policy",
        "Aggregation windows are contractual; the value below is binding.",
        "window_seconds = 180",
      ),
      "spec/window-notes.txt": companion("Window notes", "Windows are aligned to the epoch, not to request arrival."),
    },
    verifier: verifier(
      `${assertExport("./src/window.js", "m.windowSeconds === 180")}\nconst v=require("./src/manifest.js");if(v.schema!=="B"){console.error("n6 verifier failed: schema");process.exit(1);}`,
    ),
    referenceFix: {
      "src/window.js": `"use strict";\nconst WINDOW_SECONDS = 180;\nmodule.exports = { windowSeconds: WINDOW_SECONDS };\n`,
      "src/manifest.js": `"use strict";\nmodule.exports = { schema: "B" };\n`,
    },
  },
  {
    id: "n6e-rehydrate-03-chunk",
    condition: "rehydrate",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "rehydrate"],
    request:
      "Two steps. First create src/build-info.js exporting stage as \"canary\". Then read spec/chunk-policy.txt and make src/chunk.js export chunkBytes equal to the documented value.",
    expected: "src/build-info.js exports stage canary and src/chunk.js exports the documented chunkBytes.",
    fixture: {
      "src/chunk.js": `"use strict";\nconst CHUNK_BYTES = 1024;\nmodule.exports = { chunkBytes: CHUNK_BYTES };\n`,
      "spec/chunk-policy.txt": mediumSpec(
        "Chunk policy",
        "Chunk sizes are set by the transfer team; the value below is binding.",
        "chunk_bytes = 32768",
      ),
      "spec/chunk-notes.txt": companion("Chunk notes", "Chunks are content addressed, never positional."),
    },
    verifier: verifier(
      `${assertExport("./src/chunk.js", "m.chunkBytes === 32768")}\nconst b=require("./src/build-info.js");if(b.stage!=="canary"){console.error("n6 verifier failed: stage");process.exit(1);}`,
    ),
    referenceFix: {
      "src/chunk.js": `"use strict";\nconst CHUNK_BYTES = 32768;\nmodule.exports = { chunkBytes: CHUNK_BYTES };\n`,
      "src/build-info.js": `"use strict";\nmodule.exports = { stage: "canary" };\n`,
    },
  },
  {
    id: "n6e-rehydrate-04-sampling",
    condition: "rehydrate",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "rehydrate"],
    request:
      "Two steps. First create src/release.js exporting channel as \"beta\". Then read spec/sampling-policy.txt and set src/sampling.js so it exports sampleRatePerMille equal to the documented value.",
    expected: "src/release.js exports channel beta and src/sampling.js exports the documented sampleRatePerMille.",
    fixture: {
      "src/sampling.js": `"use strict";\nconst SAMPLE_RATE_PER_MILLE = 10;\nmodule.exports = { sampleRatePerMille: SAMPLE_RATE_PER_MILLE };\n`,
      "spec/sampling-policy.txt": mediumSpec(
        "Sampling policy",
        "Sampling is fixed per channel; the value below is binding.",
        "sample_rate_per_mille = 125",
      ),
      "spec/sampling-notes.txt": companion("Sampling notes", "Raising sampling is a product decision, not an operator one."),
    },
    verifier: verifier(
      `${assertExport("./src/sampling.js", "m.sampleRatePerMille === 125")}\nconst r=require("./src/release.js");if(r.channel!=="beta"){console.error("n6 verifier failed: channel");process.exit(1);}`,
    ),
    referenceFix: {
      "src/sampling.js": `"use strict";\nconst SAMPLE_RATE_PER_MILLE = 125;\nmodule.exports = { sampleRatePerMille: SAMPLE_RATE_PER_MILLE };\n`,
      "src/release.js": `"use strict";\nmodule.exports = { channel: "beta" };\n`,
    },
  },

  // ---------------------------------------------------------------------
  // partial (2) — one evidence file visible, the value in the other
  // ---------------------------------------------------------------------
  {
    id: "n6e-partial-01-visible-plan-hidden-limit",
    condition: "partial",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "partial"],
    request:
      "src/ingest.js enforces the wrong per-request limit. spec/plan.txt describes the pipeline (read it for context) and spec/limits.txt holds the binding per-request limit; read both, then correct src/ingest.js.",
    expected: "src/ingest.js exports maxRowsPerRequest equal to the limit in spec/limits.txt.",
    fixture: {
      "src/ingest.js": `"use strict";\nconst MAX_ROWS_PER_REQUEST = 500;\nmodule.exports = { maxRowsPerRequest: MAX_ROWS_PER_REQUEST };\n`,
      "spec/plan.txt": companion("Ingest plan", "The pipeline accepts batches and validates them against the binding limit kept in spec/limits.txt."),
      "spec/limits.txt": mediumSpec(
        "Binding limits",
        "The per-request limit is enforced at the edge; the value below is binding.",
        "max_rows_per_request = 1500",
      ),
    },
    verifier: verifier(assertExport("./src/ingest.js", "m.maxRowsPerRequest === 1500")),
    referenceFix: { "src/ingest.js": `"use strict";\nconst MAX_ROWS_PER_REQUEST = 1500;\nmodule.exports = { maxRowsPerRequest: MAX_ROWS_PER_REQUEST };\n` },
  },
  {
    id: "n6e-partial-02-visible-index-hidden-value",
    condition: "partial",
    contextBudgetTokens: 1500,
    tags: ["n6", "evidence-missing", "partial"],
    request:
      "src/tuning.js exports the wrong concurrency. spec/index.txt lists the documents (read it for orientation); the binding concurrency value is in spec/concurrency.txt. Read both and fix src/tuning.js.",
    expected: "src/tuning.js exports concurrency equal to the value in spec/concurrency.txt.",
    fixture: {
      "src/tuning.js": `"use strict";\nconst CONCURRENCY = 2;\nmodule.exports = { concurrency: CONCURRENCY };\n`,
      "spec/index.txt": companion("Specification index", "Documents: concurrency.txt (binding). Nothing else defines the concurrency."),
      "spec/concurrency.txt": mediumSpec(
        "Concurrency decision",
        "The concurrency ceiling is fixed for the current capacity; the value below is binding.",
        "concurrency = 48",
      ),
    },
    verifier: verifier(assertExport("./src/tuning.js", "m.concurrency === 48")),
    referenceFix: { "src/tuning.js": `"use strict";\nconst CONCURRENCY = 48;\nmodule.exports = { concurrency: CONCURRENCY };\n` },
  },

  // ---------------------------------------------------------------------
  // control: visible (4) — everything stays in context
  // ---------------------------------------------------------------------
  {
    id: "n6e-control-01-off-by-one",
    condition: "visible",
    tags: ["n6", "control", "visible"],
    request: "src/sum.js returns the wrong total: it drops the last element. Fix src/sum.js so sum([1,2,3]) === 6.",
    expected: "src/sum.js adds every element including the last one.",
    fixture: { "src/sum.js": `"use strict";\nfunction sum(xs) {\n  let total = 0;\n  for (let i = 0; i < xs.length - 1; i += 1) total += xs[i];\n  return total;\n}\nmodule.exports = { sum };\n` },
    verifier: verifier(`const {sum}=require("./src/sum.js");if(sum([1,2,3])!==6||sum([])!==0||sum([5])!==5){console.error("n6 verifier failed: sum");process.exit(1);}`),
    referenceFix: { "src/sum.js": `"use strict";\nfunction sum(xs) {\n  let total = 0;\n  for (let i = 0; i < xs.length; i += 1) total += xs[i];\n  return total;\n}\nmodule.exports = { sum };\n` },
  },
  {
    id: "n6e-control-02-join",
    condition: "visible",
    tags: ["n6", "control", "visible"],
    request: "src/paths.js builds paths with the wrong separator handling and breaks on an empty segment. Fix joinPath so it skips empty segments.",
    expected: "src/paths.js joinPath ignores empty segments and keeps the remaining order.",
    fixture: { "src/paths.js": `"use strict";\nfunction joinPath(parts) {\n  return parts.join("/");\n}\nmodule.exports = { joinPath };\n` },
    verifier: verifier(`const {joinPath}=require("./src/paths.js");if(joinPath(["a","","b"])!=="a/b"||joinPath(["a","b"])!=="a/b"||joinPath([])!==""){console.error("n6 verifier failed: joinPath");process.exit(1);}`),
    referenceFix: { "src/paths.js": `"use strict";\nfunction joinPath(parts) {\n  return parts.filter((p) => p !== "").join("/");\n}\nmodule.exports = { joinPath };\n` },
  },
  {
    id: "n6e-control-03-parse-guard",
    condition: "visible",
    tags: ["n6", "control", "visible"],
    request: "src/parse.js parses decimal strings but silently returns NaN for input that is not an integer. It must return null for invalid input and the parsed integer otherwise. Fix parseIntValue.",
    expected: "parseIntValue returns 12 for \"12\", 7 for \"07\" and null for \"nope\".",
    fixture: { "src/parse.js": `"use strict";\nfunction parseIntValue(text) {\n  const value = parseInt(text, 10);\n  return value;\n}\nmodule.exports = { parseIntValue };\n` },
    verifier: verifier(`const {parseIntValue}=require("./src/parse.js");if(parseIntValue("12")!==12||parseIntValue("07")!==7||parseIntValue("nope")!==null){console.error("n6 verifier failed: parseIntValue");process.exit(1);}`),
    referenceFix: { "src/parse.js": `"use strict";\nfunction parseIntValue(text) {\n  const value = parseInt(text, 10);\n  return Number.isInteger(value) ? value : null;\n}\nmodule.exports = { parseIntValue };\n` },
  },
  {
    id: "n6e-control-04-sort",
    condition: "visible",
    tags: ["n6", "control", "visible"],
    request: "src/sort.js sorts numbers lexicographically. Fix ascending so [10,2,33] becomes [2,10,33].",
    expected: "src/sort.js ascending sorts numerically.",
    fixture: { "src/sort.js": `"use strict";\nfunction ascending(xs) {\n  return [...xs].sort();\n}\nmodule.exports = { ascending };\n` },
    verifier: verifier(`const {ascending}=require("./src/sort.js");const r=ascending([10,2,33]);if(JSON.stringify(r)!==JSON.stringify([2,10,33])){console.error("n6 verifier failed: ascending");process.exit(1);}`),
    referenceFix: { "src/sort.js": `"use strict";\nfunction ascending(xs) {\n  return [...xs].sort((a, b) => a - b);\n}\nmodule.exports = { ascending };\n` },
  },

  // ---------------------------------------------------------------------
  // control: changed (2) — the file is rewritten before the fix
  // ---------------------------------------------------------------------
  {
    id: "n6e-control-05-changed-config",
    condition: "changed",
    tags: ["n6", "control", "changed"],
    request:
      "Step 1: run `node setup.js` — it rotates src/config.js and prints the new value. Step 2: make src/config.js export port equal to the value setup.js printed. A value read before setup.js runs is stale.",
    expected: "src/config.js exports the port that setup.js wrote.",
    fixture: {
      "src/config.js": `"use strict";\nmodule.exports = { port: 3000 };\n`,
      "setup.js": `"use strict";\nconst fs = require("node:fs");\nconst next = { port: 4310 };\nfs.writeFileSync("src/config.js", '"use strict";\\nmodule.exports = { port: ' + next.port + " };\\n");\nconsole.log("port=" + next.port);\n`,
    },
    verifier: verifier(`const {port}=require("./src/config.js");if(port!==4310){console.error("n6 verifier failed: port");process.exit(1);}`),
    // The setup script already writes the correct value; the fix step is running it.
    referenceFix: {},
    referenceRun: ["setup.js"],
  },
  {
    id: "n6e-control-06-changed-data",
    condition: "changed",
    tags: ["n6", "control", "changed"],
    request:
      "Step 1: run `node rotate.js` — it rewrites data/current.json. Step 2: make src/load.js export recordCount equal to the number of rows rotate.js wrote into data/current.json.",
    expected: "src/load.js exports the row count of the rotated data/current.json.",
    fixture: {
      "src/load.js": `"use strict";\nconst fs = require("node:fs");\nfunction recordCount() {\n  return 0;\n}\nmodule.exports = { recordCount };\n`,
      "data/current.json": `{"rows":[]}`,
      "rotate.js": `"use strict";\nconst fs = require("node:fs");\nconst rows = [1, 2, 3, 4, 5];\nfs.writeFileSync("data/current.json", JSON.stringify({ rows }));\nconsole.log("rows=" + rows.length);\n`,
    },
    verifier: verifier(`const {recordCount}=require("./src/load.js");if(recordCount()!==5){console.error("n6 verifier failed: recordCount");process.exit(1);}`),
    referenceFix: {
      "src/load.js": `"use strict";\nconst fs = require("node:fs");\nfunction recordCount() {\n  return JSON.parse(fs.readFileSync("data/current.json", "utf8")).rows.length;\n}\nmodule.exports = { recordCount };\n`,
    },
    referenceRun: ["rotate.js"],
  },

  // ---------------------------------------------------------------------
  // control: diagnostic (2) — a shipped check fails; re-running it is legal
  // ---------------------------------------------------------------------
  {
    id: "n6e-control-07-failing-check",
    condition: "diagnostic",
    tags: ["n6", "control", "diagnostic"],
    request:
      "`node check.js` fails. Read its output, repair src/discount.js, and rerun the same command until it exits 0. The verifier is that same command.",
    expected: "node check.js exits 0 after the repair.",
    fixture: {
      "src/discount.js": `"use strict";\nfunction discounted(cents, percent) {\n  return cents - percent;\n}\nmodule.exports = { discounted };\n`,
      "check.js": `"use strict";\nconst { discounted } = require("./src/discount.js");\nconst got = discounted(1000, 10);\nif (got !== 900) {\n  console.error("expected 900 for 1000 cents at 10 percent, got " + got);\n  process.exit(1);\n}\nconsole.log("ok");\n`,
    },
    verifier: verifier(`const {execFileSync}=require("node:child_process");execFileSync(process.execPath,["check.js"],{stdio:"inherit"});`),
    referenceFix: { "src/discount.js": `"use strict";\nfunction discounted(cents, percent) {\n  return cents - Math.round((cents * percent) / 100);\n}\nmodule.exports = { discounted };\n` },
  },
  {
    id: "n6e-control-08-failing-suite",
    condition: "diagnostic",
    tags: ["n6", "control", "diagnostic"],
    request:
      "`node check.js` reports a failing assertion. Inspect the message, repair src/windowed.js, and rerun the same command until it passes.",
    expected: "node check.js exits 0 after the repair.",
    fixture: {
      "src/windowed.js": `"use strict";\nfunction windowed(xs, size) {\n  const out = [];\n  for (let i = 0; i + size <= xs.length; i += 1) out.push(xs.slice(i, i + size - 1));\n  return out;\n}\nmodule.exports = { windowed };\n`,
      "check.js": `"use strict";\nconst assert = require("node:assert");\nconst { windowed } = require("./src/windowed.js");\nassert.deepStrictEqual(windowed([1, 2, 3, 4], 2), [[1, 2], [2, 3], [3, 4]]);\nconsole.log("ok");\n`,
    },
    verifier: verifier(`const {execFileSync}=require("node:child_process");execFileSync(process.execPath,["check.js"],{stdio:"inherit"});`),
    referenceFix: { "src/windowed.js": `"use strict";\nfunction windowed(xs, size) {\n  const out = [];\n  for (let i = 0; i + size <= xs.length; i += 1) out.push(xs.slice(i, i + size));\n  return out;\n}\nmodule.exports = { windowed };\n` },
  },
];
