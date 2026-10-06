/**
 * N7 — the FROZEN case data for the INDEPENDENT HOLDOUT of the
 * `context_safe_tool_call_efficiency_v2` challenger (24 cases: 16
 * evidence-missing + 8 control).
 *
 * Independence is the point of this set:
 *   - it lives in its own suite (`benchmarks/n7-holdout`) with its own manifest,
 *     its own digests and its own pre-registration;
 *   - its evidence family is DIFFERENT from the main set: the main corpus is a
 *     platform/SRE estate whose modules live under `src/` and whose evidence is
 *     prose policy, CSV, JSON, log and table files under `spec/`; this holdout is
 *     a clinical-analyser and freight-registry estate whose modules live under
 *     `lib/` and whose evidence arrives as TSV tables, INI configuration, JSON
 *     payloads and instrument logs under `lab/`, `registry/` and `config/`;
 *   - the candidate strategy text was frozen BEFORE this file existed, so the
 *     holdout could not have been used to tune the prompt.
 *
 * The condition CLASSES mirror the main set (that is what the plan's group-level
 * gates compare), but no case content is reused: the generator refuses duplicate
 * fixture digests or duplicate task text WITHIN a set, and
 * `n7-evidence-cases.regressions.test.ts` additionally refuses any holdout case
 * whose fixture bytes or task text collide with a main-set case.
 */

import { companion, mediumSpec, partial, preview, rehydrate, verifier, compactDrop } from "./n7-case-helpers.mjs";

const VISIBLE = (id, request, expected, fixture, verifierScript, referenceFix) => ({
  id,
  condition: "visible",
  tags: ["n7", "holdout", "control", "visible"],
  request,
  expected,
  fixture,
  verifier: verifier(verifierScript),
  referenceFix,
});

const CHANGED = (id, request, expected, fixture, verifierScript, referenceFix, referenceRun) => ({
  id,
  condition: "changed",
  tags: ["n7", "holdout", "control", "changed"],
  request,
  expected,
  fixture,
  verifier: verifier(verifierScript),
  referenceFix,
  referenceRun,
});

const DIAGNOSTIC = (id, request, expected, fixture, referenceFix) => ({
  id,
  condition: "diagnostic",
  tags: ["n7", "holdout", "control", "diagnostic"],
  request,
  expected,
  fixture,
  verifier: verifier(
    `const {execFileSync}=require("node:child_process");execFileSync(process.execPath,["check.js"],{stdio:"inherit"});`,
  ),
  referenceFix,
});

export const HOLDOUT_CASES = [
  // ---------------------------------------------------------------------
  // compact-drop (8)
  // ---------------------------------------------------------------------
  compactDrop({
    id: "n7h-compact-01-sample-volume",
    tags: ["n7", "holdout", "evidence-missing", "compact-drop"],
    modulePath: "lib/sample.js",
    constName: "SAMPLE_VOLUME_UL",
    exportName: "sampleVolumeUl",
    placeholder: 50,
    value: 200,
    specFile: "spec/lab/sample-policy.txt",
    specTitle: "Sample policy",
    specIntro: "The analyser accepts a fixed aspiration volume; the entry below is binding.",
    keyLine: "sample_volume_ul = 200",
    companionFile: "spec/lab/sample-notes.txt",
    companionTitle: "Sample notes",
    companionBody: "Volumes are aspirated once; a short draw is a hard error, never topped up.",
    request:
      "lib/sample.js aspirates the wrong volume. The laboratory policy in spec/lab/sample-policy.txt states the aspiration volume in microlitres; read it and correct lib/sample.js.",
    expected: "lib/sample.js exports sampleVolumeUl equal to sample_volume_ul in spec/lab/sample-policy.txt.",
  }),
  compactDrop({
    id: "n7h-compact-02-incubation-minutes",
    tags: ["n7", "holdout", "evidence-missing", "compact-drop"],
    modulePath: "lib/incubate.js",
    constName: "INCUBATION_MINUTES",
    exportName: "incubationMinutes",
    placeholder: 15,
    value: 45,
    specFile: "spec/lab/incubation-policy.txt",
    specTitle: "Incubation policy",
    specIntro: "Incubation timing is validated for each assay; the entry below is binding.",
    keyLine: "incubation_minutes = 45",
    companionFile: "spec/lab/incubation-notes.txt",
    companionTitle: "Incubation notes",
    companionBody: "Timing starts when the plate reaches temperature, not when it is loaded.",
    request:
      "lib/incubate.js incubates for the wrong duration. Read spec/lab/incubation-policy.txt for the validated duration in minutes, then make lib/incubate.js export it.",
    expected: "lib/incubate.js exports incubationMinutes equal to incubation_minutes in spec/lab/incubation-policy.txt.",
  }),
  compactDrop({
    id: "n7h-compact-03-dilution-factor",
    tags: ["n7", "holdout", "evidence-missing", "compact-drop"],
    modulePath: "lib/dilution.js",
    constName: "DILUTION_FACTOR",
    exportName: "dilutionFactor",
    placeholder: 2,
    value: 8,
    specFile: "spec/lab/dilution-policy.txt",
    specTitle: "Dilution policy",
    specIntro: "The dilution series is fixed by the validation report; the entry below is binding.",
    keyLine: "dilution_factor = 8",
    companionFile: "spec/lab/dilution-notes.txt",
    companionTitle: "Dilution notes",
    companionBody: "Each step is prepared fresh; carry-over between steps is forbidden.",
    request:
      "lib/dilution.js dilutes by the wrong factor. spec/lab/dilution-policy.txt records the validated factor; read it and set lib/dilution.js accordingly.",
    expected: "lib/dilution.js exports dilutionFactor equal to dilution_factor in spec/lab/dilution-policy.txt.",
  }),
  compactDrop({
    id: "n7h-compact-04-centrifuge-rpm",
    tags: ["n7", "holdout", "evidence-missing", "compact-drop"],
    modulePath: "lib/centrifuge.js",
    constName: "CENTRIFUGE_RPM",
    exportName: "centrifugeRpm",
    placeholder: 3000,
    value: 4500,
    specFile: "spec/lab/centrifuge-policy.txt",
    specTitle: "Centrifuge policy",
    specIntro: "Separation speed is fixed per tube type; the entry below is binding.",
    keyLine: "centrifuge_rpm = 4500",
    companionFile: "spec/lab/centrifuge-notes.txt",
    companionTitle: "Centrifuge notes",
    companionBody: "Rotors are balanced before every run; the speed is not adjusted mid-run.",
    request:
      "lib/centrifuge.js spins at the wrong speed. The required speed is recorded in spec/lab/centrifuge-policy.txt; read it and correct lib/centrifuge.js.",
    expected: "lib/centrifuge.js exports centrifugeRpm equal to centrifuge_rpm in spec/lab/centrifuge-policy.txt.",
  }),
  compactDrop({
    id: "n7h-compact-05-pallet-max-cases",
    tags: ["n7", "holdout", "evidence-missing", "compact-drop"],
    modulePath: "lib/pallet.js",
    constName: "PALLET_MAX_CASES",
    exportName: "palletMaxCases",
    placeholder: 24,
    value: 48,
    specFile: "spec/registry/pallet-policy.txt",
    specTitle: "Pallet policy",
    specIntro: "Pallet loading limits are set by the freight authority; the entry below is binding.",
    keyLine: "pallet_max_cases = 48",
    companionFile: "spec/registry/pallet-notes.txt",
    companionTitle: "Pallet notes",
    companionBody: "Overhang is not permitted, regardless of remaining capacity.",
    request:
      "lib/pallet.js loads the wrong number of cases. Read spec/registry/pallet-policy.txt for the maximum case count per pallet, then fix lib/pallet.js.",
    expected: "lib/pallet.js exports palletMaxCases equal to pallet_max_cases in spec/registry/pallet-policy.txt.",
  }),
  compactDrop({
    id: "n7h-compact-06-customs-window",
    tags: ["n7", "holdout", "evidence-missing", "compact-drop"],
    modulePath: "lib/customs.js",
    constName: "CUSTOMS_WINDOW_HOURS",
    exportName: "customsWindowHours",
    placeholder: 4,
    value: 12,
    specFile: "spec/registry/customs-policy.txt",
    specTitle: "Customs policy",
    specIntro: "Pre-clearance submission windows are published; the entry below is binding.",
    keyLine: "customs_window_hours = 12",
    companionFile: "spec/registry/customs-notes.txt",
    companionTitle: "Customs notes",
    companionBody: "Late submissions are queued, never back-dated.",
    request:
      "lib/customs.js submits declarations inside the wrong window. spec/registry/customs-policy.txt states the window in hours; read it and correct lib/customs.js.",
    expected: "lib/customs.js exports customsWindowHours equal to customs_window_hours in spec/registry/customs-policy.txt.",
  }),
  compactDrop({
    id: "n7h-compact-07-cold-chain-ttl",
    tags: ["n7", "holdout", "evidence-missing", "compact-drop"],
    modulePath: "lib/coldchain.js",
    constName: "COLD_CHAIN_TTL_MINUTES",
    exportName: "coldChainTtlMinutes",
    placeholder: 120,
    value: 480,
    specFile: "spec/registry/coldchain-policy.txt",
    specTitle: "Cold chain policy",
    specIntro: "Excursion-free time out of refrigeration is capped; the entry below is binding.",
    keyLine: "cold_chain_ttl_minutes = 480",
    companionFile: "spec/registry/coldchain-notes.txt",
    companionTitle: "Cold chain notes",
    companionBody: "Excursions are recorded, not corrected; the cap is enforced on arrival.",
    request:
      "lib/coldchain.js allows shipments too long outside refrigeration. The cap is recorded in spec/registry/coldchain-policy.txt; read it and fix lib/coldchain.js.",
    expected: "lib/coldchain.js exports coldChainTtlMinutes equal to cold_chain_ttl_minutes in spec/registry/coldchain-policy.txt.",
  }),
  compactDrop({
    id: "n7h-compact-08-max-route-legs",
    tags: ["n7", "holdout", "evidence-missing", "compact-drop"],
    modulePath: "lib/route.js",
    constName: "MAX_ROUTE_LEGS",
    exportName: "maxRouteLegs",
    placeholder: 3,
    value: 6,
    specFile: "spec/registry/route-policy.txt",
    specTitle: "Route policy",
    specIntro: "Consolidated routes carry a fixed leg budget; the entry below is binding.",
    keyLine: "max_route_legs = 6",
    companionFile: "spec/registry/route-notes.txt",
    companionTitle: "Route notes",
    companionBody: "A leg is a stop, not a mode change.",
    request:
      "lib/route.js plans routes with too few legs. Read spec/registry/route-policy.txt for the leg budget, then set lib/route.js to that number.",
    expected: "lib/route.js exports maxRouteLegs equal to max_route_legs in spec/registry/route-policy.txt.",
  }),

  // ---------------------------------------------------------------------
  // preview (4) — carriers the main set never uses (TSV, INI) plus its own
  // JSON and instrument-log files
  // ---------------------------------------------------------------------
  preview({
    id: "n7h-preview-01-analyzer-value-column",
    tags: ["n7", "holdout", "evidence-missing", "preview"],
    modulePath: "lib/analyzer.js",
    constName: "ANALYZER_VALUE_COLUMN",
    exportName: "analyzerValueColumn",
    placeholder: 1,
    value: 5,
    evidenceFile: "lab/analyzer-table.tsv",
    carrier: {
      kind: "tsv",
      header: "position\tfield_name\tkind\tnotes",
      keyRow: "005\tresult_value\tnumeric\tthe analyser reads this column as the reported value",
      tailNote: "end of analyser table",
    },
    request:
      "lib/analyzer.js reads the reported result from the wrong column. lab/analyzer-table.tsv lists the column positions; read it and correct lib/analyzer.js.",
    expected: "lib/analyzer.js exports analyzerValueColumn equal to the position of result_value in lab/analyzer-table.tsv.",
  }),
  preview({
    id: "n7h-preview-02-calibration-offset",
    tags: ["n7", "holdout", "evidence-missing", "preview"],
    modulePath: "lib/calibration.js",
    constName: "CALIBRATION_OFFSET",
    exportName: "calibrationOffset",
    placeholder: 0,
    value: 37,
    evidenceFile: "lab/calibration.json",
    carrier: {
      kind: "json",
      kind2: "calibration-record",
      key: "offset",
      value: 37,
      note: "the authoritative calibration offset for this instrument",
    },
    request:
      "lib/calibration.js applies no correction. The authoritative calibration offset is recorded in lab/calibration.json; read the file and fix lib/calibration.js.",
    expected: "lib/calibration.js exports calibrationOffset equal to the offset in lab/calibration.json.",
  }),
  preview({
    id: "n7h-preview-03-registry-batch-limit",
    tags: ["n7", "holdout", "evidence-missing", "preview"],
    modulePath: "lib/registry.js",
    constName: "REGISTRY_BATCH_LIMIT",
    exportName: "registryBatchLimit",
    placeholder: 100,
    value: 900,
    evidenceFile: "registry/limits.ini",
    carrier: {
      kind: "ini",
      section: "registry",
      keyLine: "batch_limit = 900",
      tailNote: "; end of registry limits",
    },
    request:
      "lib/registry.js submits registry batches that are too large. registry/limits.ini records the batch limit; read it and make lib/registry.js match.",
    expected: "lib/registry.js exports registryBatchLimit equal to batch_limit in registry/limits.ini.",
  }),
  preview({
    id: "n7h-preview-04-instrument-cycle",
    tags: ["n7", "holdout", "evidence-missing", "preview"],
    modulePath: "lib/instrument.js",
    constName: "INSTRUMENT_CYCLE_SECONDS",
    exportName: "instrumentCycleSeconds",
    placeholder: 5,
    value: 75,
    evidenceFile: "lab/instrument-log.txt",
    carrier: {
      kind: "log",
      stamp: "2026-10-06T07:15:00Z",
      keyLine: "2026-10-06T07:15:00Z INFO policy: instrument_cycle_seconds = 75",
    },
    request:
      "lib/instrument.js polls the analyser on the wrong cycle. The cycle is recorded in the instrument log at lab/instrument-log.txt; read it and correct lib/instrument.js.",
    expected: "lib/instrument.js exports instrumentCycleSeconds equal to the instrument_cycle_seconds line in lab/instrument-log.txt.",
  }),

  // ---------------------------------------------------------------------
  // rehydrate (2)
  // ---------------------------------------------------------------------
  rehydrate({
    id: "n7h-rehydrate-01-assay-threshold",
    tags: ["n7", "holdout", "evidence-missing", "rehydrate"],
    modulePath: "lib/assay.js",
    constName: "ASSAY_THRESHOLD_NG",
    exportName: "assayThresholdNg",
    placeholder: 1,
    value: 25,
    specFile: "spec/lab/assay-policy.txt",
    specTitle: "Assay policy",
    specIntro: "The reporting threshold is validated per assay; the value below is binding.",
    keyLine: "assay_threshold_ng = 25",
    companionFile: "spec/lab/assay-notes.txt",
    companionTitle: "Assay notes",
    companionBody: "Below-threshold results are reported as such, never as zero.",
    markerPath: "lib/dataset-tag.js",
    markerConstName: "DATASET_TAG",
    markerExport: "datasetTag",
    markerValue: "ds1",
    request:
      "Two steps. First create lib/dataset-tag.js exporting datasetTag as the string \"ds1\". Then read spec/lab/assay-policy.txt and set lib/assay.js so it exports the documented reporting threshold.",
    expected: "lib/dataset-tag.js exports the string ds1 and lib/assay.js exports the documented assayThresholdNg.",
  }),
  rehydrate({
    id: "n7h-rehydrate-02-consignment-batch",
    tags: ["n7", "holdout", "evidence-missing", "rehydrate"],
    modulePath: "lib/consignment.js",
    constName: "CONSIGNMENT_BATCH",
    exportName: "consignmentBatch",
    placeholder: 10,
    value: 250,
    specFile: "spec/registry/consignment-policy.txt",
    specTitle: "Consignment policy",
    specIntro: "Consolidation batches are capped by the registry; the value below is binding.",
    keyLine: "consignment_batch = 250",
    companionFile: "spec/registry/consignment-notes.txt",
    companionTitle: "Consignment notes",
    companionBody: "A batch is sealed before handover; nothing is added afterwards.",
    markerPath: "lib/manifest-version.js",
    markerConstName: "MANIFEST_VERSION",
    markerExport: "manifestVersion",
    markerValue: "mv2",
    request:
      "Two steps. First create lib/manifest-version.js exporting manifestVersion as the string \"mv2\". Then read spec/registry/consignment-policy.txt and make lib/consignment.js export the documented batch size.",
    expected: "lib/manifest-version.js exports the string mv2 and lib/consignment.js exports the documented consignmentBatch.",
  }),

  // ---------------------------------------------------------------------
  // partial (2)
  // ---------------------------------------------------------------------
  partial({
    id: "n7h-partial-01-overview-and-plasma",
    tags: ["n7", "holdout", "evidence-missing", "partial"],
    modulePath: "lib/plasma.js",
    constName: "PLASMA_THRESHOLD",
    exportName: "plasmaThreshold",
    placeholder: 5,
    value: 40,
    visibleFile: "spec/lab/overview.txt",
    visibleTitle: "Laboratory overview",
    visibleBody: "The overview describes the analyser estate; the binding plasma threshold is kept in spec/lab/plasma-limits.txt.",
    bindingFile: "spec/lab/plasma-limits.txt",
    specTitle: "Plasma limits",
    specIntro: "The threshold is validated for this assay; the value below is binding.",
    keyLine: "plasma_threshold = 40",
    request:
      "lib/plasma.js flags results with the wrong threshold. spec/lab/overview.txt gives context and spec/lab/plasma-limits.txt holds the binding threshold; read both, then correct lib/plasma.js.",
    expected: "lib/plasma.js exports plasmaThreshold equal to the value in spec/lab/plasma-limits.txt.",
  }),
  partial({
    id: "n7h-partial-02-index-and-container",
    tags: ["n7", "holdout", "evidence-missing", "partial"],
    modulePath: "lib/container.js",
    constName: "CONTAINER_CAP",
    exportName: "containerCap",
    placeholder: 8,
    value: 60,
    visibleFile: "spec/registry/index.txt",
    visibleTitle: "Registry specification index",
    visibleBody: "Documents: container-limits.txt (binding). Nothing else defines the container cap.",
    bindingFile: "spec/registry/container-limits.txt",
    specTitle: "Container limits",
    specIntro: "Container capacity is fixed by the vessel manifest; the value below is binding.",
    keyLine: "container_cap = 60",
    request:
      "lib/container.js loads containers beyond the allowed cap. Read spec/registry/index.txt for orientation and spec/registry/container-limits.txt for the binding cap, then fix lib/container.js.",
    expected: "lib/container.js exports containerCap equal to the value in spec/registry/container-limits.txt.",
  }),

  // ---------------------------------------------------------------------
  // control: visible (4)
  // ---------------------------------------------------------------------
  VISIBLE(
    "n7h-control-01-mean-divisor",
    "lib/mean.js divides by one less than the sample count, so mean([2,4,6]) is 6. Fix lib/mean.js; an empty sample must return 0.",
    "lib/mean.js mean divides by the sample count and returns 0 for an empty sample.",
    {
      "lib/mean.js": `"use strict";\nfunction mean(xs) {\n  let total = 0;\n  for (const x of xs) total += x;\n  return total / (xs.length - 1);\n}\nmodule.exports = { mean };\n`,
    },
    `const {mean}=require("./lib/mean.js");if(mean([2,4,6])!==4||mean([])!==0){console.error("n7 verifier failed: mean");process.exit(1);}`,
    {
      "lib/mean.js": `"use strict";\nfunction mean(xs) {\n  if (xs.length === 0) return 0;\n  let total = 0;\n  for (const x of xs) total += x;\n  return total / xs.length;\n}\nmodule.exports = { mean };\n`,
    },
  ),
  VISIBLE(
    "n7h-control-02-interleave-tail",
    "lib/interleave.js stops at the shorter input, so interleave([1,2,3], [\"a\"]) loses 2 and 3. Fix it to append the remaining tail.",
    "lib/interleave.js interleave alternates and appends whatever remains of the longer input.",
    {
      "lib/interleave.js": `"use strict";\nfunction interleave(a, b) {\n  const out = [];\n  for (let i = 0; i < a.length && i < b.length; i += 1) out.push(a[i], b[i]);\n  return out;\n}\nmodule.exports = { interleave };\n`,
    },
    `const {interleave}=require("./lib/interleave.js");const x=interleave([1,2,3],["a"]);const y=interleave(["a"],[1,2]);if(JSON.stringify(x)!==JSON.stringify([1,"a",2,3])||JSON.stringify(y)!==JSON.stringify(["a",1,2])){console.error("n7 verifier failed: interleave");process.exit(1);}`,
    {
      "lib/interleave.js": `"use strict";\nfunction interleave(a, b) {\n  const out = [];\n  const n = Math.max(a.length, b.length);\n  for (let i = 0; i < n; i += 1) {\n    if (i < a.length) out.push(a[i]);\n    if (i < b.length) out.push(b[i]);\n  }\n  return out;\n}\nmodule.exports = { interleave };\n`,
    },
  ),
  VISIBLE(
    "n7h-control-03-normalize-unit",
    "lib/normalize.js upper-cases units and keeps surrounding whitespace, so normalizeUnit(\"  Mg \") is \"  MG \". It must trim and lower-case.",
    "lib/normalize.js normalizeUnit returns the unit trimmed and lower-cased.",
    {
      "lib/normalize.js": `"use strict";\nfunction normalizeUnit(text) {\n  return text.toUpperCase();\n}\nmodule.exports = { normalizeUnit };\n`,
    },
    `const {normalizeUnit}=require("./lib/normalize.js");if(normalizeUnit("  Mg ").trim()!=="mg"||normalizeUnit("UL")!=="ul"){console.error("n7 verifier failed: normalizeUnit");process.exit(1);}`,
    {
      "lib/normalize.js": `"use strict";\nfunction normalizeUnit(text) {\n  return text.trim().toLowerCase();\n}\nmodule.exports = { normalizeUnit };\n`,
    },
  ),
  VISIBLE(
    "n7h-control-04-inclusive-range",
    "lib/range.js builds ranges exclusive of the end, so rangeOf(2,5) is [2,3,4] instead of [2,3,4,5]. Fix lib/range.js to include both ends.",
    "lib/range.js rangeOf includes the end value, and rangeOf(3,3) is [3].",
    {
      "lib/range.js": `"use strict";\nfunction rangeOf(start, end) {\n  const out = [];\n  for (let i = start; i < end; i += 1) out.push(i);\n  return out;\n}\nmodule.exports = { rangeOf };\n`,
    },
    `const {rangeOf}=require("./lib/range.js");const a=rangeOf(2,5);const b=rangeOf(3,3);if(JSON.stringify(a)!==JSON.stringify([2,3,4,5])||JSON.stringify(b)!==JSON.stringify([3])){console.error("n7 verifier failed: rangeOf");process.exit(1);}`,
    {
      "lib/range.js": `"use strict";\nfunction rangeOf(start, end) {\n  const out = [];\n  for (let i = start; i <= end; i += 1) out.push(i);\n  return out;\n}\nmodule.exports = { rangeOf };\n`,
    },
  ),

  // ---------------------------------------------------------------------
  // control: changed (2)
  // ---------------------------------------------------------------------
  CHANGED(
    "n7h-control-05-changed-threshold",
    "Step 1: run `node setup.js` — it rewrites config/threshold.json. Step 2: make lib/threshold.js alertThreshold return the threshold that file now holds.",
    "lib/threshold.js alertThreshold returns the threshold written into config/threshold.json.",
    {
      "lib/threshold.js": `"use strict";\nfunction alertThreshold() {\n  return 0;\n}\nmodule.exports = { alertThreshold };\n`,
      "config/threshold.json": `{"threshold":0}\n`,
      "setup.js": `"use strict";\nconst fs = require("node:fs");\nconst threshold = 88;\nfs.writeFileSync("config/threshold.json", JSON.stringify({ threshold }));\nconsole.log("threshold=" + threshold);\n`,
    },
    `const {alertThreshold}=require("./lib/threshold.js");if(alertThreshold()!==88){console.error("n7 verifier failed: alertThreshold");process.exit(1);}`,
    {
      "lib/threshold.js": `"use strict";\nconst fs = require("node:fs");\nfunction alertThreshold() {\n  return JSON.parse(fs.readFileSync("config/threshold.json", "utf8")).threshold;\n}\nmodule.exports = { alertThreshold };\n`,
    },
    ["setup.js"],
  ),
  CHANGED(
    "n7h-control-06-changed-shipment-count",
    "Step 1: run `node rotate.js` — it rewrites data/shipment.json. Step 2: make lib/shipment.js shipmentCount return the count stored there.",
    "lib/shipment.js shipmentCount returns the count rotate.js wrote into data/shipment.json.",
    {
      "lib/shipment.js": `"use strict";\nfunction shipmentCount() {\n  return 0;\n}\nmodule.exports = { shipmentCount };\n`,
      "data/shipment.json": `{"count":0}\n`,
      "rotate.js": `"use strict";\nconst fs = require("node:fs");\nconst count = 41;\nfs.writeFileSync("data/shipment.json", JSON.stringify({ count }));\nconsole.log("count=" + count);\n`,
    },
    `const {shipmentCount}=require("./lib/shipment.js");if(shipmentCount()!==41){console.error("n7 verifier failed: shipmentCount");process.exit(1);}`,
    {
      "lib/shipment.js": `"use strict";\nconst fs = require("node:fs");\nfunction shipmentCount() {\n  return JSON.parse(fs.readFileSync("data/shipment.json", "utf8")).count;\n}\nmodule.exports = { shipmentCount };\n`,
    },
    ["rotate.js"],
  ),

  // ---------------------------------------------------------------------
  // control: diagnostic (2)
  // ---------------------------------------------------------------------
  DIAGNOSTIC(
    "n7h-control-07-failing-median-check",
    "`node check.js` fails on a median assertion. Inspect its message, repair lib/median.js, and rerun the same command until it exits 0.",
    "node check.js exits 0 after the repair.",
    {
      "lib/median.js": `"use strict";\nfunction median(xs) {\n  return xs[Math.floor(xs.length / 2)];\n}\nmodule.exports = { median };\n`,
      "check.js": `"use strict";\nconst { median } = require("./lib/median.js");\nconst a = median([3, 1, 2]);\nconst b = median([4, 1, 3, 2]);\nif (a !== 2 || b !== 2.5) {\n  console.error("expected median 2 and 2.5, got " + a + " and " + b);\n  process.exit(1);\n}\nconsole.log("ok");\n`,
    },
    {
      "lib/median.js": `"use strict";\nfunction median(xs) {\n  const sorted = [...xs].sort((a, b) => a - b);\n  const mid = Math.floor(sorted.length / 2);\n  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;\n  return sorted[mid];\n}\nmodule.exports = { median };\n`,
    },
  ),
  DIAGNOSTIC(
    "n7h-control-08-failing-rotation-check",
    "`node check.js` fails on a rotation assertion. Inspect its output, repair lib/rotate.js, and rerun the same command until it exits 0.",
    "node check.js exits 0 after the repair.",
    {
      "lib/rotate.js": `"use strict";\nfunction rotate(xs, k) {\n  return xs.slice(k).concat(xs.slice(0, k - 1));\n}\nmodule.exports = { rotate };\n`,
      "check.js": `"use strict";\nconst assert = require("node:assert");\nconst { rotate } = require("./lib/rotate.js");\nassert.deepStrictEqual(rotate([1, 2, 3, 4, 5], 2), [3, 4, 5, 1, 2]);\nassert.deepStrictEqual(rotate([1, 2, 3], 4), [2, 3, 1]);\nconsole.log("ok");\n`,
    },
    {
      "lib/rotate.js": `"use strict";\nfunction rotate(xs, k) {\n  if (xs.length === 0) return [];\n  const n = ((k % xs.length) + xs.length) % xs.length;\n  return xs.slice(n).concat(xs.slice(0, n));\n}\nmodule.exports = { rotate };\n`,
    },
  ),
];

// The holdout uses the same helper primitives as the main set; `companion` and
// `mediumSpec` are re-exported only to keep the import list honest about which
// carriers this family relies on.
export { companion, mediumSpec };
