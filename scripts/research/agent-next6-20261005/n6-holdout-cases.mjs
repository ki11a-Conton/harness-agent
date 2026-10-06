/**
 * N6 / N2 — the FROZEN case data for the INDEPENDENT HOLDOUT set (24 cases:
 * 16 evidence-missing + 8 control).
 *
 * Independence is the point of this set:
 *   - it lives in its own suite (`benchmarks/n6-holdout`) with its own manifest,
 *     its own digests and its own pre-registration;
 *   - its repositories, file types, task shapes and evidence carriers are a
 *     DIFFERENT family from the main set (main: ops/infra prose specs against
 *     small JS modules; holdout: a ledger/warehouse/telemetry service whose
 *     evidence arrives as CSV rows, JSON payloads, service logs and policy
 *     tables);
 *   - the candidate strategy text was frozen BEFORE this file existed (see
 *     `packages/evaluation/src/mechanism-guidance.ts` and the N3 commit), so the
 *     holdout could not have been used to tune the prompt.
 *
 * The condition CLASSES mirror the main set (that is what the plan's
 * group-level gates compare), but no case content is reused: the generator
 * refuses duplicate fixture digests or duplicate task text WITHIN a set, and
 * `n6-evidence-cases.regressions.test.ts` additionally refuses any holdout case
 * whose fixture bytes or task text collide with a main-set case.
 */

import { companion, filler, mediumSpec, verifier, assertExport } from "./n6-case-helpers.mjs";

/** A >16 KiB CSV whose needed row sits in the middle. */
function largeCsv(header, keyRow, tailNote) {
  const rows = [];
  for (let i = 0; i < 320; i += 1) {
    rows.push(`${String(i + 1).padStart(3, "0")},filler_column_${i},routine,no_decision_depends_on_this_row`);
  }
  const half = Math.floor(rows.length / 2);
  return [[header, ...rows.slice(0, half), keyRow, ...rows.slice(half), tailNote].join("\n"), ""].join("\n");
}

/** A >16 KiB JSON document whose needed value sits in the middle. */
function largeJson(kind, key, value, note) {
  const entries = [];
  for (let i = 0; i < 320; i += 1) {
    entries.push({ id: `entry-${String(i).padStart(3, "0")}`, note: "routine housekeeping; no decision depends on this entry" });
  }
  const half = Math.floor(entries.length / 2);
  const payload = {
    kind,
    entries: [...entries.slice(0, half), { id: "authoritative", [key]: value, note }, ...entries.slice(half)],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** A >16 KiB service log whose authoritative line sits in the middle. */
function largeLog(keyLine) {
  const head = filler("2026-10-05T00:00:00Z INFO service", 80, 1);
  const tail = filler("2026-10-05T12:00:00Z INFO service", 80, 1000);
  return [`2026-10-05T00:00:00Z INFO boot: retention policy follows`, "", head, "", keyLine, "", tail, ""].join("\n");
}

export const HOLDOUT_CASES = [
  // ---------------------------------------------------------------------
  // compact-drop (6)
  // ---------------------------------------------------------------------
  {
    id: "n6h-compact-01-ledger-minor-units",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "compact-drop"],
    request:
      "src/money.js exposes minorUnits with a placeholder. The ledger rules in spec/ledger-rules.txt state how many minor units make one major unit; read them and set src/money.js to that number.",
    expected: "src/money.js exports minorUnits equal to minor_units in spec/ledger-rules.txt.",
    fixture: {
      "src/money.js": `"use strict";\nconst MINOR_UNITS = 100;\nmodule.exports = { minorUnits: MINOR_UNITS };\n`,
      "spec/ledger-rules.txt": mediumSpec(
        "Ledger rules",
        "The ledger is the system of record; the minor-unit scale below is binding.",
        "minor_units = 1000",
      ),
      "spec/ledger-notes.txt": companion("Ledger notes", "Postings are append-only; nothing is rewritten in place."),
    },
    verifier: verifier(assertExport("./src/money.js", "m.minorUnits === 1000")),
    referenceFix: { "src/money.js": `"use strict";\nconst MINOR_UNITS = 1000;\nmodule.exports = { minorUnits: MINOR_UNITS };\n` },
  },
  {
    id: "n6h-compact-02-fx-rate-scale",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "compact-drop"],
    request:
      "src/fx.js uses the wrong scale for quoted rates. spec/fx-policy.txt records the scale the treasury publishes; read it and correct src/fx.js.",
    expected: "src/fx.js exports rateScale equal to rate_scale in spec/fx-policy.txt.",
    fixture: {
      "src/fx.js": `"use strict";\nconst RATE_SCALE = 10000;\nmodule.exports = { rateScale: RATE_SCALE };\n`,
      "spec/fx-policy.txt": mediumSpec(
        "FX policy",
        "Quoted rates are integers scaled below; the treasury publishes this scale.",
        "rate_scale = 1000000",
      ),
      "spec/fx-notes.txt": companion("FX notes", "Rates are re-quoted hourly and cached read-only."),
    },
    verifier: verifier(assertExport("./src/fx.js", "m.rateScale === 1000000")),
    referenceFix: { "src/fx.js": `"use strict";\nconst RATE_SCALE = 1000000;\nmodule.exports = { rateScale: RATE_SCALE };\n` },
  },
  {
    id: "n6h-compact-03-sla-target",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "compact-drop"],
    request:
      "src/sla.js carries a stale service target. spec/sla-table.txt defines the resolution target in minutes; read it and update src/sla.js.",
    expected: "src/sla.js exports resolutionMinutes equal to resolution_minutes in spec/sla-table.txt.",
    fixture: {
      "src/sla.js": `"use strict";\nconst RESOLUTION_MINUTES = 60;\nmodule.exports = { resolutionMinutes: RESOLUTION_MINUTES };\n`,
      "spec/sla-table.txt": mediumSpec(
        "SLA table",
        "Targets are contractual and measured monthly; the value below is binding.",
        "resolution_minutes = 45",
      ),
      "spec/sla-notes.txt": companion("SLA notes", "Pausing the clock requires an incident reference."),
    },
    verifier: verifier(assertExport("./src/sla.js", "m.resolutionMinutes === 45")),
    referenceFix: { "src/sla.js": `"use strict";\nconst RESOLUTION_MINUTES = 45;\nmodule.exports = { resolutionMinutes: RESOLUTION_MINUTES };\n` },
  },
  {
    id: "n6h-compact-04-parcel-weight",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "compact-drop"],
    request:
      "src/parcel.js allows parcels above the carrier limit. spec/carrier-rules.txt states the maximum weight in grams; read it and correct src/parcel.js.",
    expected: "src/parcel.js exports maxWeightGrams equal to max_weight_grams in spec/carrier-rules.txt.",
    fixture: {
      "src/parcel.js": `"use strict";\nconst MAX_WEIGHT_GRAMS = 20000;\nmodule.exports = { maxWeightGrams: MAX_WEIGHT_GRAMS };\n`,
      "spec/carrier-rules.txt": mediumSpec(
        "Carrier rules",
        "The carrier rejects overweight parcels at intake; the limit below is binding.",
        "max_weight_grams = 31500",
      ),
      "spec/carrier-notes.txt": companion("Carrier notes", "Rejected parcels return to the origin hub."),
    },
    verifier: verifier(assertExport("./src/parcel.js", "m.maxWeightGrams === 31500")),
    referenceFix: { "src/parcel.js": `"use strict";\nconst MAX_WEIGHT_GRAMS = 31500;\nmodule.exports = { maxWeightGrams: MAX_WEIGHT_GRAMS };\n` },
  },
  {
    id: "n6h-compact-05-route-hops",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "compact-drop"],
    request:
      "src/routing.js permits too many hops. spec/routing-policy.txt defines the hop ceiling; read the policy and fix src/routing.js.",
    expected: "src/routing.js exports maxHops equal to max_hops in spec/routing-policy.txt.",
    fixture: {
      "src/routing.js": `"use strict";\nconst MAX_HOPS = 4;\nmodule.exports = { maxHops: MAX_HOPS };\n`,
      "spec/routing-policy.txt": mediumSpec(
        "Routing policy",
        "Hops are capped to bound latency; the ceiling below is binding.",
        "max_hops = 9",
      ),
      "spec/routing-notes.txt": companion("Routing notes", "Loops are detected by hop count, not by node identity."),
    },
    verifier: verifier(assertExport("./src/routing.js", "m.maxHops === 9")),
    referenceFix: { "src/routing.js": `"use strict";\nconst MAX_HOPS = 9;\nmodule.exports = { maxHops: MAX_HOPS };\n` },
  },
  {
    id: "n6h-compact-06-stock-reserve",
    condition: "compact-drop",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "compact-drop"],
    request:
      "src/stock.js reserves the wrong share of inventory. spec/warehouse-policy.txt records the reserve percentage; read it and correct src/stock.js.",
    expected: "src/stock.js exports reservePercent equal to reserve_percent in spec/warehouse-policy.txt.",
    fixture: {
      "src/stock.js": `"use strict";\nconst RESERVE_PERCENT = 5;\nmodule.exports = { reservePercent: RESERVE_PERCENT };\n`,
      "spec/warehouse-policy.txt": mediumSpec(
        "Warehouse policy",
        "The reserve keeps a buffer for priority orders; the share below is binding.",
        "reserve_percent = 12",
      ),
      "spec/warehouse-notes.txt": companion("Warehouse notes", "Reserves are recomputed per replenishment cycle."),
    },
    verifier: verifier(assertExport("./src/stock.js", "m.reservePercent === 12")),
    referenceFix: { "src/stock.js": `"use strict";\nconst RESERVE_PERCENT = 12;\nmodule.exports = { reservePercent: RESERVE_PERCENT };\n` },
  },

  // ---------------------------------------------------------------------
  // preview (4) — >16 KiB evidence of four different file types
  // ---------------------------------------------------------------------
  {
    id: "n6h-preview-01-csv-column-order",
    condition: "preview",
    tags: ["n6", "holdout", "evidence-missing", "preview"],
    request:
      "src/schema.js exports the wrong position for the dispatch column. data/schema.csv lists every column with its position; read the CSV and set dispatchColumnOrder to the position recorded for dispatch_window_minutes.",
    expected: "src/schema.js exports dispatchColumnOrder equal to the position recorded for dispatch_window_minutes in data/schema.csv.",
    fixture: {
      "src/schema.js": `"use strict";\nconst DISPATCH_COLUMN_ORDER = 0;\nmodule.exports = { dispatchColumnOrder: DISPATCH_COLUMN_ORDER };\n`,
      "data/schema.csv": largeCsv(
        "position,column,owner,note",
        "009,dispatch_window_minutes,logistics,authoritative position for the dispatch column",
        "010,trailer,logistics,end of table",
      ),
    },
    verifier: verifier(assertExport("./src/schema.js", "m.dispatchColumnOrder === 9")),
    referenceFix: { "src/schema.js": `"use strict";\nconst DISPATCH_COLUMN_ORDER = 9;\nmodule.exports = { dispatchColumnOrder: DISPATCH_COLUMN_ORDER };\n` },
  },
  {
    id: "n6h-preview-02-json-flag",
    condition: "preview",
    tags: ["n6", "holdout", "evidence-missing", "preview"],
    request:
      "src/features.js ships the wrong default for the audit flag. spec/features.json documents the defaults; read it and set auditDefault to the documented value for the audit entry.",
    expected: "src/features.js exports auditDefault equal to the audit entry's value in spec/features.json.",
    fixture: {
      "src/features.js": `"use strict";\nconst AUDIT_DEFAULT = false;\nmodule.exports = { auditDefault: AUDIT_DEFAULT };\n`,
      "spec/features.json": largeJson(
        "feature-defaults",
        "enabled",
        true,
        "authoritative default for the audit feature",
      ),
    },
    verifier: verifier(assertExport("./src/features.js", "m.auditDefault === true")),
    referenceFix: { "src/features.js": `"use strict";\nconst AUDIT_DEFAULT = true;\nmodule.exports = { auditDefault: AUDIT_DEFAULT };\n` },
  },
  {
    id: "n6h-preview-03-log-retention",
    condition: "preview",
    tags: ["n6", "holdout", "evidence-missing", "preview"],
    request:
      "src/logging.js keeps logs for the wrong number of days. spec/service.log records the retention decision; read the log and set retentionDays to the recorded value.",
    expected: "src/logging.js exports retentionDays equal to the value on the retention decision line in spec/service.log.",
    fixture: {
      "src/logging.js": `"use strict";\nconst RETENTION_DAYS = 7;\nmodule.exports = { retentionDays: RETENTION_DAYS };\n`,
      "spec/service.log": largeLog("2026-10-05T06:00:00Z INFO policy: retention_days = 120 (authoritative decision)"),
    },
    verifier: verifier(assertExport("./src/logging.js", "m.retentionDays === 120")),
    referenceFix: { "src/logging.js": `"use strict";\nconst RETENTION_DAYS = 120;\nmodule.exports = { retentionDays: RETENTION_DAYS };\n` },
  },
  {
    id: "n6h-preview-04-upload-chunk",
    condition: "preview",
    tags: ["n6", "holdout", "evidence-missing", "preview"],
    request:
      "src/upload.js uses a chunk size the gateway rejects. spec/manifest.txt records the accepted chunk size in bytes; read it and correct src/upload.js.",
    expected: "src/upload.js exports chunkBytes equal to upload_chunk_bytes in spec/manifest.txt.",
    fixture: {
      "src/upload.js": `"use strict";\nconst CHUNK_BYTES = 65536;\nmodule.exports = { chunkBytes: CHUNK_BYTES };\n`,
      "spec/manifest.txt": [
        "# Upload manifest specification",
        "",
        "Normative. The accepted chunk size is stated in the middle of this document.",
        "",
        filler("NOTE", 90, 1),
        "",
        "upload_chunk_bytes = 262144",
        "",
        filler("NOTE", 90, 1000),
        "",
        "End of upload manifest specification.",
        "",
      ].join("\n"),
    },
    verifier: verifier(assertExport("./src/upload.js", "m.chunkBytes === 262144")),
    referenceFix: { "src/upload.js": `"use strict";\nconst CHUNK_BYTES = 262144;\nmodule.exports = { chunkBytes: CHUNK_BYTES };\n` },
  },

  // ---------------------------------------------------------------------
  // rehydrate (4) — a trivial write first, then the real edit
  // ---------------------------------------------------------------------
  {
    id: "n6h-rehydrate-01-session-ttl",
    condition: "rehydrate",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "rehydrate"],
    request:
      "Two steps. First create src/state.js exporting phase as the string \"warm\". Then read spec/session-policy.txt and set src/session.js so sessionTtlSeconds equals the documented value.",
    expected: "src/state.js exports phase warm and src/session.js exports the documented sessionTtlSeconds.",
    fixture: {
      "src/session.js": `"use strict";\nconst SESSION_TTL_SECONDS = 600;\nmodule.exports = { sessionTtlSeconds: SESSION_TTL_SECONDS };\n`,
      "spec/session-policy.txt": mediumSpec(
        "Session policy",
        "Session lifetime is set by the platform team; the value below is binding.",
        "session_ttl_seconds = 7200",
      ),
      "spec/session-notes.txt": companion("Session notes", "Sessions are rotated, never extended in place."),
    },
    verifier: verifier(
      `${assertExport("./src/session.js", "m.sessionTtlSeconds === 7200")}\nconst s=require("./src/state.js");if(s.phase!=="warm"){console.error("n6 verifier failed: phase");process.exit(1);}`,
    ),
    referenceFix: {
      "src/session.js": `"use strict";\nconst SESSION_TTL_SECONDS = 7200;\nmodule.exports = { sessionTtlSeconds: SESSION_TTL_SECONDS };\n`,
      "src/state.js": `"use strict";\nmodule.exports = { phase: "warm" };\n`,
    },
  },
  {
    id: "n6h-rehydrate-02-quorum",
    condition: "rehydrate",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "rehydrate"],
    request:
      "Two steps. First create src/tag.js exporting build as \"rc3\". Then read spec/consensus-policy.txt and set src/consensus.js so quorumSize equals the documented value.",
    expected: "src/tag.js exports build rc3 and src/consensus.js exports the documented quorumSize.",
    fixture: {
      "src/consensus.js": `"use strict";\nconst QUORUM_SIZE = 3;\nmodule.exports = { quorumSize: QUORUM_SIZE };\n`,
      "spec/consensus-policy.txt": mediumSpec(
        "Consensus policy",
        "Quorum is sized for the current failure domain; the value below is binding.",
        "quorum_size = 5",
      ),
      "spec/consensus-notes.txt": companion("Consensus notes", "A quorum is a count of distinct nodes, not of votes."),
    },
    verifier: verifier(
      `${assertExport("./src/consensus.js", "m.quorumSize === 5")}\nconst t=require("./src/tag.js");if(t.build!=="rc3"){console.error("n6 verifier failed: build");process.exit(1);}`,
    ),
    referenceFix: {
      "src/consensus.js": `"use strict";\nconst QUORUM_SIZE = 5;\nmodule.exports = { quorumSize: QUORUM_SIZE };\n`,
      "src/tag.js": `"use strict";\nmodule.exports = { build: "rc3" };\n`,
    },
  },
  {
    id: "n6h-rehydrate-03-throttle",
    condition: "rehydrate",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "rehydrate"],
    request:
      "Two steps. First create src/marker.js exporting marker as \"m1\". Then read spec/throttle-policy.txt and make src/throttle.js export requestsPerSecond equal to the documented value.",
    expected: "src/marker.js exports marker m1 and src/throttle.js exports the documented requestsPerSecond.",
    fixture: {
      "src/throttle.js": `"use strict";\nconst REQUESTS_PER_SECOND = 50;\nmodule.exports = { requestsPerSecond: REQUESTS_PER_SECOND };\n`,
      "spec/throttle-policy.txt": mediumSpec(
        "Throttle policy",
        "Limits are enforced at the edge; the value below is binding.",
        "requests_per_second = 240",
      ),
      "spec/throttle-notes.txt": companion("Throttle notes", "Bursts borrow from the next window, never beyond it."),
    },
    verifier: verifier(
      `${assertExport("./src/throttle.js", "m.requestsPerSecond === 240")}\nconst k=require("./src/marker.js");if(k.marker!=="m1"){console.error("n6 verifier failed: marker");process.exit(1);}`,
    ),
    referenceFix: {
      "src/throttle.js": `"use strict";\nconst REQUESTS_PER_SECOND = 240;\nmodule.exports = { requestsPerSecond: REQUESTS_PER_SECOND };\n`,
      "src/marker.js": `"use strict";\nmodule.exports = { marker: "m1" };\n`,
    },
  },
  {
    id: "n6h-rehydrate-04-retention",
    condition: "rehydrate",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "rehydrate"],
    request:
      "Two steps. First create src/notes.js exporting note as \"n1\". Then read spec/retention-policy.txt and set src/retention.js so retentionDays equals the documented value.",
    expected: "src/notes.js exports note n1 and src/retention.js exports the documented retentionDays.",
    fixture: {
      "src/retention.js": `"use strict";\nconst RETENTION_DAYS = 30;\nmodule.exports = { retentionDays: RETENTION_DAYS };\n`,
      "spec/retention-policy.txt": mediumSpec(
        "Retention policy",
        "Retention is contractual for this tenant; the value below is binding.",
        "retention_days = 400",
      ),
      "spec/retention-notes.txt": companion("Retention notes", "Deletion is scheduled, never immediate."),
    },
    verifier: verifier(
      `${assertExport("./src/retention.js", "m.retentionDays === 400")}\nconst n=require("./src/notes.js");if(n.note!=="n1"){console.error("n6 verifier failed: note");process.exit(1);}`,
    ),
    referenceFix: {
      "src/retention.js": `"use strict";\nconst RETENTION_DAYS = 400;\nmodule.exports = { retentionDays: RETENTION_DAYS };\n`,
      "src/notes.js": `"use strict";\nmodule.exports = { note: "n1" };\n`,
    },
  },

  // ---------------------------------------------------------------------
  // partial (2)
  // ---------------------------------------------------------------------
  {
    id: "n6h-partial-01-visible-overview-hidden-value",
    condition: "partial",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "partial"],
    request:
      "src/partitions.js allows too many partitions. spec/overview.txt explains the layout (read it for orientation); the binding ceiling is in spec/partition-limits.txt. Read both and correct src/partitions.js.",
    expected: "src/partitions.js exports maxPartitions equal to the ceiling in spec/partition-limits.txt.",
    fixture: {
      "src/partitions.js": `"use strict";\nconst MAX_PARTITIONS = 64;\nmodule.exports = { maxPartitions: MAX_PARTITIONS };\n`,
      "spec/overview.txt": companion("Layout overview", "The ceiling lives in spec/partition-limits.txt and nowhere else."),
      "spec/partition-limits.txt": mediumSpec(
        "Partition limits",
        "The broker enforces this ceiling; the value below is binding.",
        "max_partitions = 512",
      ),
    },
    verifier: verifier(assertExport("./src/partitions.js", "m.maxPartitions === 512")),
    referenceFix: { "src/partitions.js": `"use strict";\nconst MAX_PARTITIONS = 512;\nmodule.exports = { maxPartitions: MAX_PARTITIONS };\n` },
  },
  {
    id: "n6h-partial-02-visible-readme-hidden-quota",
    condition: "partial",
    contextBudgetTokens: 1500,
    tags: ["n6", "holdout", "evidence-missing", "partial"],
    request:
      "src/quota.js enforces the wrong daily quota. spec/readme.txt orients you (read it); the binding quota is in spec/quota-table.txt. Read both and set src/quota.js accordingly.",
    expected: "src/quota.js exports dailyQuotaUnits equal to the quota in spec/quota-table.txt.",
    fixture: {
      "src/quota.js": `"use strict";\nconst DAILY_QUOTA_UNITS = 20000;\nmodule.exports = { dailyQuotaUnits: DAILY_QUOTA_UNITS };\n`,
      "spec/readme.txt": companion("Quota readme", "Only spec/quota-table.txt defines the daily quota."),
      "spec/quota-table.txt": mediumSpec(
        "Quota table",
        "The quota resets at 00:00 UTC; the value below is binding.",
        "daily_quota_units = 75000",
      ),
    },
    verifier: verifier(assertExport("./src/quota.js", "m.dailyQuotaUnits === 75000")),
    referenceFix: { "src/quota.js": `"use strict";\nconst DAILY_QUOTA_UNITS = 75000;\nmodule.exports = { dailyQuotaUnits: DAILY_QUOTA_UNITS };\n` },
  },

  // ---------------------------------------------------------------------
  // control: visible (4)
  // ---------------------------------------------------------------------
  {
    id: "n6h-control-01-mean",
    condition: "visible",
    tags: ["n6", "holdout", "control", "visible"],
    request: "src/stats.js computes the mean with the wrong denominator. Fix mean so mean([2,4,6]) === 4.",
    expected: "src/stats.js mean divides by the number of elements.",
    fixture: { "src/stats.js": `"use strict";\nfunction mean(xs) {\n  let total = 0;\n  for (const x of xs) total += x;\n  return total / (xs.length - 1);\n}\nmodule.exports = { mean };\n` },
    verifier: verifier(`const {mean}=require("./src/stats.js");if(mean([2,4,6])!==4||mean([5])!==5){console.error("n6 verifier failed: mean");process.exit(1);}`),
    referenceFix: { "src/stats.js": `"use strict";\nfunction mean(xs) {\n  let total = 0;\n  for (const x of xs) total += x;\n  return total / xs.length;\n}\nmodule.exports = { mean };\n` },
  },
  {
    id: "n6h-control-02-clamp",
    condition: "visible",
    tags: ["n6", "holdout", "control", "visible"],
    request: "src/clamp.js clamps in the wrong direction. Fix clamp so clamp(5,1,3) === 3 and clamp(-1,0,10) === 0.",
    expected: "src/clamp.js confines its input to [min, max].",
    fixture: { "src/clamp.js": `"use strict";\nfunction clamp(value, min, max) {\n  return Math.min(min, Math.max(max, value));\n}\nmodule.exports = { clamp };\n` },
    verifier: verifier(`const {clamp}=require("./src/clamp.js");if(clamp(5,1,3)!==3||clamp(-1,0,10)!==0||clamp(2,0,10)!==2){console.error("n6 verifier failed: clamp");process.exit(1);}`),
    referenceFix: { "src/clamp.js": `"use strict";\nfunction clamp(value, min, max) {\n  return Math.max(min, Math.min(max, value));\n}\nmodule.exports = { clamp };\n` },
  },
  {
    id: "n6h-control-03-unique",
    condition: "visible",
    tags: ["n6", "holdout", "control", "visible"],
    request: "src/uniq.js returns duplicates. Fix uniq so uniq([1,1,2]) deep-equals [1,2] while keeping first-seen order.",
    expected: "src/uniq.js removes duplicates preserving order.",
    fixture: { "src/uniq.js": `"use strict";\nfunction uniq(xs) {\n  return [...xs];\n}\nmodule.exports = { uniq };\n` },
    verifier: verifier(`const {uniq}=require("./src/uniq.js");if(JSON.stringify(uniq([1,1,2]))!==JSON.stringify([1,2])||JSON.stringify(uniq(["b","a","b"]))!==JSON.stringify(["b","a"])){console.error("n6 verifier failed: uniq");process.exit(1);}`),
    referenceFix: { "src/uniq.js": `"use strict";\nfunction uniq(xs) {\n  return [...new Set(xs)];\n}\nmodule.exports = { uniq };\n` },
  },
  {
    id: "n6h-control-04-truncate",
    condition: "visible",
    tags: ["n6", "holdout", "control", "visible"],
    request: "src/text.js truncates one character too long. Fix truncate so truncate(\"abcdef\", 3) === \"abc\".",
    expected: "src/text.js truncate keeps at most the requested number of characters.",
    fixture: { "src/text.js": `"use strict";\nfunction truncate(text, limit) {\n  return text.slice(0, limit + 1);\n}\nmodule.exports = { truncate };\n` },
    verifier: verifier(`const {truncate}=require("./src/text.js");if(truncate("abcdef",3)!=="abc"||truncate("ab",5)!=="ab"){console.error("n6 verifier failed: truncate");process.exit(1);}`),
    referenceFix: { "src/text.js": `"use strict";\nfunction truncate(text, limit) {\n  return text.slice(0, limit);\n}\nmodule.exports = { truncate };\n` },
  },

  // ---------------------------------------------------------------------
  // control: changed (2)
  // ---------------------------------------------------------------------
  {
    id: "n6h-control-05-changed-region",
    condition: "changed",
    tags: ["n6", "holdout", "control", "changed"],
    request:
      "Step 1: run `node provision.js` — it rewrites src/env.js and prints the assigned region. Step 2: make src/env.js export region equal to the region provision.js assigned. A region read before provisioning is stale.",
    expected: "src/env.js exports the region provision.js assigned.",
    fixture: {
      "src/env.js": `"use strict";\nmodule.exports = { region: "us-east-1" };\n`,
      "provision.js": `"use strict";\nconst fs = require("node:fs");\nconst region = "eu-west-2";\nfs.writeFileSync("src/env.js", '"use strict";\\nmodule.exports = { region: ' + JSON.stringify(region) + " };\\n");\nconsole.log("region=" + region);\n`,
    },
    verifier: verifier(`const {region}=require("./src/env.js");if(region!=="eu-west-2"){console.error("n6 verifier failed: region");process.exit(1);}`),
    referenceFix: {},
    referenceRun: ["provision.js"],
  },
  {
    id: "n6h-control-06-changed-catalog",
    condition: "changed",
    tags: ["n6", "holdout", "control", "changed"],
    request:
      "Step 1: run `node sync.js` — it rewrites data/catalog.json. Step 2: make src/catalog.js export itemCount equal to the number of items sync.js wrote.",
    expected: "src/catalog.js exports the item count of the synced data/catalog.json.",
    fixture: {
      "src/catalog.js": `"use strict";\nfunction itemCount() {\n  return 0;\n}\nmodule.exports = { itemCount };\n`,
      "data/catalog.json": `{"items":[]}`,
      "sync.js": `"use strict";\nconst fs = require("node:fs");\nconst items = ["a", "b", "c", "d", "e", "f", "g"];\nfs.writeFileSync("data/catalog.json", JSON.stringify({ items }));\nconsole.log("items=" + items.length);\n`,
    },
    verifier: verifier(`const {itemCount}=require("./src/catalog.js");if(itemCount()!==7){console.error("n6 verifier failed: itemCount");process.exit(1);}`),
    referenceFix: {
      "src/catalog.js": `"use strict";\nconst fs = require("node:fs");\nfunction itemCount() {\n  return JSON.parse(fs.readFileSync("data/catalog.json", "utf8")).items.length;\n}\nmodule.exports = { itemCount };\n`,
    },
    referenceRun: ["sync.js"],
  },

  // ---------------------------------------------------------------------
  // control: diagnostic (2)
  // ---------------------------------------------------------------------
  {
    id: "n6h-control-07-failing-rounding",
    condition: "diagnostic",
    tags: ["n6", "holdout", "control", "diagnostic"],
    request:
      "`node check.js` fails. Read its message, repair src/round.js so that half values round to even, and rerun the same command until it exits 0. The verifier is that same command.",
    expected: "node check.js exits 0 after the repair.",
    fixture: {
      "src/round.js": `"use strict";\nfunction roundHalfToEven(value) {\n  return Math.round(value);\n}\nmodule.exports = { roundHalfToEven };\n`,
      "check.js": `"use strict";\nconst assert = require("node:assert");\nconst { roundHalfToEven } = require("./src/round.js");\nassert.strictEqual(roundHalfToEven(2.5), 2);\nassert.strictEqual(roundHalfToEven(3.5), 4);\nconsole.log("ok");\n`,
    },
    verifier: verifier(`const {execFileSync}=require("node:child_process");execFileSync(process.execPath,["check.js"],{stdio:"inherit"});`),
    referenceFix: {
      "src/round.js": `"use strict";\nfunction roundHalfToEven(value) {\n  const floor = Math.floor(value);\n  const diff = value - floor;\n  if (diff !== 0.5) return Math.round(value);\n  return floor % 2 === 0 ? floor : floor + 1;\n}\nmodule.exports = { roundHalfToEven };\n`,
    },
  },
  {
    id: "n6h-control-08-failing-dedupe",
    condition: "diagnostic",
    tags: ["n6", "holdout", "control", "diagnostic"],
    request:
      "`node check.js` reports a failing assertion. Inspect the message, repair src/dedupe.js so equal records collapse to their first occurrence, and rerun the same command until it passes.",
    expected: "node check.js exits 0 after the repair.",
    fixture: {
      "src/dedupe.js": `"use strict";\nfunction dedupe(records) {\n  return records.filter((r, i) => records.indexOf(r) !== i);\n}\nmodule.exports = { dedupe };\n`,
      "check.js": `"use strict";\nconst assert = require("node:assert");\nconst { dedupe } = require("./src/dedupe.js");\nassert.deepStrictEqual(dedupe(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);\nconsole.log("ok");\n`,
    },
    verifier: verifier(`const {execFileSync}=require("node:child_process");execFileSync(process.execPath,["check.js"],{stdio:"inherit"});`),
    referenceFix: {
      "src/dedupe.js": `"use strict";\nfunction dedupe(records) {\n  return records.filter((r, i) => records.indexOf(r) === i);\n}\nmodule.exports = { dedupe };\n`,
    },
  },
];
