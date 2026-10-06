/**
 * N7 — shared, deterministic case-authoring helpers for the
 * `context_safe_tool_call_efficiency_v2` challenger.
 *
 * Why a NEW helper module instead of reusing the N6 one: the N6 module is part of
 * a FROZEN pre-registration. Importing it would couple a frozen artifact to a
 * new round, and the N7 corpus must be authorable without touching a single N6
 * byte. The few primitives that carry over (`filler`/`mediumSpec`/`largeSpec`/
 * `companion`/`verifier`/`assertExport`) are re-declared here byte-for-byte in
 * their arithmetic, so "medium" and ">16 KiB" mean exactly the same thing as in
 * N6 and the two rounds stay comparable.
 *
 * Everything here is deterministic: the same arguments always produce the same
 * bytes, which is what lets `generate-n7-cases.mjs --check` refuse drift after a
 * pre-registration has been frozen.
 *
 * The builders below turn a short per-case semantic record (module path, export
 * name, constant name, the authoritative value, the evidence carrier) into a
 * complete case: fixture bytes, the ORIGINAL command verifier and the reference
 * fix. Every case still supplies its own task text; the generator refuses any
 * duplicated task text or duplicated fixture content, and
 * `n7-evidence-cases.regressions.test.ts` additionally PROVES each verifier
 * discriminates (fails unfixed, passes after the reference fix).
 */

/** Deterministic filler prose (stable bytes) for evidence files. */
export function filler(prefix, count, from) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      `${prefix} ${String(from + i).padStart(4, "0")}: the operational log records routine housekeeping only, no decision depends on this line.`,
    );
  }
  return out.join("\n");
}

/**
 * A >16 KiB evidence file whose authoritative value sits in the middle, i.e.
 * far outside both the 2000-byte head and the 2000-byte tail the inline
 * renderer keeps (the `preview` condition).
 */
export function largeSpec(title, intro, keyLine, tailNote) {
  const head = [`# ${title}`, "", intro, ""];
  const headBody = filler("NOTE", 90, 1);
  const tailBody = filler("NOTE", 90, 1000);
  return [...head, headBody, "", keyLine, "", tailBody, "", tailNote, ""].join("\n");
}

/** A >16 KiB table whose authoritative row sits in the middle (columns fixed). */
export function largeTable(title, columns, keyRow, tailNote) {
  const head = [`# ${title}`, "", `# columns: ${columns}`, ""];
  const headBody = filler("ROW", 90, 1);
  const tailBody = filler("ROW", 90, 1000);
  return [...head, headBody, "", keyRow, "", tailBody, "", tailNote, ""].join("\n");
}

/** A >16 KiB CSV whose authoritative row sits in the middle. */
export function largeCsv(header, keyRow, tailNote) {
  const rows = [];
  for (let i = 0; i < 320; i += 1) {
    rows.push(`${String(i + 1).padStart(3, "0")},filler_column_${i},routine,no_decision_depends_on_this_row`);
  }
  const half = Math.floor(rows.length / 2);
  return [[header, ...rows.slice(0, half), keyRow, ...rows.slice(half), tailNote].join("\n"), ""].join("\n");
}

/** A >16 KiB tab-separated table whose authoritative row sits in the middle. */
export function largeTsv(header, keyRow, tailNote) {
  const rows = [];
  for (let i = 0; i < 320; i += 1) {
    rows.push(
      `${String(i + 1).padStart(3, "0")}\tfiller_column_${i}\troutine\tno_decision_depends_on_this_row`,
    );
  }
  const half = Math.floor(rows.length / 2);
  return [[header, ...rows.slice(0, half), keyRow, ...rows.slice(half), tailNote].join("\n"), ""].join("\n");
}

/** A >16 KiB INI-style configuration whose authoritative key sits in the middle. */
export function largeIni(section, keyLine, tailNote) {
  const head = [`[${section}]`, "", filler("; setting", 80, 1), ""];
  const tail = [filler("; setting", 80, 1000), "", tailNote, ""];
  return [...head, keyLine, "", ...tail].join("\n");
}

/** A >16 KiB JSON document whose authoritative value sits in the middle. */
export function largeJson(kind, key, value, note) {
  const entries = [];
  for (let i = 0; i < 320; i += 1) {
    entries.push({
      id: `entry-${String(i).padStart(3, "0")}`,
      note: "routine housekeeping; no decision depends on this entry",
    });
  }
  const half = Math.floor(entries.length / 2);
  const payload = {
    kind,
    entries: [...entries.slice(0, half), { id: "authoritative", [key]: value, note }, ...entries.slice(half)],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** A >16 KiB service log whose authoritative line sits in the middle. */
export function largeLog(stamp, keyLine) {
  const head = filler(`${stamp} INFO service`, 80, 1);
  const tail = filler(`${stamp} INFO service`, 80, 1000);
  return [`${stamp} INFO boot: policy follows`, "", head, "", keyLine, "", tail, ""].join("\n");
}

/**
 * A medium evidence file: it FITS the inline budget (so a read really shows the
 * key line), yet is big enough that a case-local budget is exceeded by it plus a
 * companion read — the `compact-drop` / `rehydrate` / `partial` condition.
 */
export function mediumSpec(title, intro, keyLine) {
  return [
    `# ${title}`,
    "",
    intro,
    "",
    filler("DETAIL", 26, 1),
    "",
    keyLine,
    "",
    filler("DETAIL", 26, 500),
    "",
  ].join("\n");
}

/** A small companion document the task also requires reading. */
export function companion(title, body) {
  return [`# ${title}`, "", filler("LINE", 14, 1), "", body, ""].join("\n");
}

/** The command verifier shape the benchmark loader expects. */
export function verifier(script) {
  return { command: "node", args: ["-e", script] };
}

/**
 * `require`s a fixture module and asserts one exported value.
 *
 * `varName` exists because a verifier may need to assert TWO modules (the
 * `rehydrate` cases do): concatenating two declarations of the same `const`
 * would be a syntax error, so the second assertion gets its own binding.
 */
export function assertExport(modulePath, expression, varName = "m") {
  return `const ${varName}=require(${JSON.stringify(modulePath)});if(!(${expression.replace(/\bm\./g, `${varName}.`)})){console.error("n7 verifier failed: "+JSON.stringify({got:${varName}}));process.exit(1);}`;
}

/** A `"use strict"` module that exports one constant (the graded shape). */
export function moduleConst(constName, exportName, value) {
  const literal = typeof value === "string" ? JSON.stringify(value) : String(value);
  return `"use strict";\nconst ${constName} = ${literal};\nmodule.exports = { ${exportName}: ${constName} };\n`;
}

const exportExpression = (exportName, value) =>
  typeof value === "string"
    ? `m.${exportName} === ${JSON.stringify(value)}`
    : `m.${exportName} === ${String(value)}`;

/**
 * The evidence carriers a `preview` case may use. Each one is >16 KiB with the
 * authoritative value in the dropped middle; which carrier a case uses is part
 * of its fixture bytes, so two cases never share content.
 */
export function carrierText(carrier) {
  switch (carrier.kind) {
    case "spec":
      return largeSpec(carrier.title, carrier.intro, carrier.keyLine, carrier.tailNote);
    case "table":
      return largeTable(carrier.title, carrier.columns, carrier.keyLine, carrier.tailNote);
    case "csv":
      return largeCsv(carrier.header, carrier.keyRow, carrier.tailNote);
    case "tsv":
      return largeTsv(carrier.header, carrier.keyRow, carrier.tailNote);
    case "ini":
      return largeIni(carrier.section, carrier.keyLine, carrier.tailNote);
    case "json":
      return largeJson(carrier.kind2, carrier.key, carrier.value, carrier.note);
    case "log":
      return largeLog(carrier.stamp, carrier.keyLine);
    default:
      throw new Error(`unknown carrier kind ${String(carrier.kind)}`);
  }
}

/** compact-drop: placeholder module + medium spec dropped by a case-local budget. */
export function compactDrop(spec) {
  return {
    id: spec.id,
    condition: "compact-drop",
    contextBudgetTokens: spec.budget ?? 1500,
    tags: spec.tags ?? ["n7", "evidence-missing", "compact-drop"],
    request: spec.request,
    expected: spec.expected,
    fixture: {
      [spec.modulePath]: moduleConst(spec.constName, spec.exportName, spec.placeholder),
      [spec.specFile]: mediumSpec(spec.specTitle, spec.specIntro, spec.keyLine),
      [spec.companionFile]: companion(spec.companionTitle, spec.companionBody),
    },
    verifier: verifier(assertExport(`./${spec.modulePath}`, exportExpression(spec.exportName, spec.value))),
    referenceFix: { [spec.modulePath]: moduleConst(spec.constName, spec.exportName, spec.value) },
  };
}

/** preview: placeholder module + one evidence file larger than the inline budget. */
export function preview(spec) {
  return {
    id: spec.id,
    condition: "preview",
    tags: spec.tags ?? ["n7", "evidence-missing", "preview"],
    request: spec.request,
    expected: spec.expected,
    fixture: {
      [spec.modulePath]: moduleConst(spec.constName, spec.exportName, spec.placeholder),
      [spec.evidenceFile]: carrierText(spec.carrier),
    },
    verifier: verifier(assertExport(`./${spec.modulePath}`, exportExpression(spec.exportName, spec.value))),
    referenceFix: { [spec.modulePath]: moduleConst(spec.constName, spec.exportName, spec.value) },
  };
}

/**
 * rehydrate: a first, trivial write happens before the real edit, so the
 * rehydration pointer names the WRITTEN file while the spec value stays
 * unavailable — the pointer is restored, the content is not.
 */
export function rehydrate(spec) {
  const markerVerifier = assertExport(
    `./${spec.markerPath}`,
    exportExpression(spec.markerExport, spec.markerValue),
    "v",
  );
  return {
    id: spec.id,
    condition: "rehydrate",
    contextBudgetTokens: spec.budget ?? 1500,
    tags: spec.tags ?? ["n7", "evidence-missing", "rehydrate"],
    request: spec.request,
    expected: spec.expected,
    fixture: {
      [spec.modulePath]: moduleConst(spec.constName, spec.exportName, spec.placeholder),
      [spec.specFile]: mediumSpec(spec.specTitle, spec.specIntro, spec.keyLine),
      [spec.companionFile]: companion(spec.companionTitle, spec.companionBody),
    },
    verifier: verifier(
      `${assertExport(`./${spec.modulePath}`, exportExpression(spec.exportName, spec.value))}\n${markerVerifier}`,
    ),
    referenceFix: {
      [spec.modulePath]: moduleConst(spec.constName, spec.exportName, spec.value),
      [spec.markerPath]: moduleConst(spec.markerConstName, spec.markerExport, spec.markerValue),
    },
  };
}

/** partial: one evidence file stays visible; only the dropped one carries the value. */
export function partial(spec) {
  return {
    id: spec.id,
    condition: "partial",
    contextBudgetTokens: spec.budget ?? 1500,
    tags: spec.tags ?? ["n7", "evidence-missing", "partial"],
    request: spec.request,
    expected: spec.expected,
    fixture: {
      [spec.modulePath]: moduleConst(spec.constName, spec.exportName, spec.placeholder),
      [spec.visibleFile]: companion(spec.visibleTitle, spec.visibleBody),
      [spec.bindingFile]: mediumSpec(spec.specTitle, spec.specIntro, spec.keyLine),
    },
    verifier: verifier(assertExport(`./${spec.modulePath}`, exportExpression(spec.exportName, spec.value))),
    referenceFix: { [spec.modulePath]: moduleConst(spec.constName, spec.exportName, spec.value) },
  };
}

/** The frozen per-class composition of the N7 MAIN experiment (64 cases). */
export const N7_MAIN_COMPOSITION = {
  total: 64,
  "compact-drop": 20,
  preview: 12,
  rehydrate: 10,
  partial: 6,
  visible: 8,
  changed: 4,
  diagnostic: 4,
};

/** The frozen per-class composition of the N7 INDEPENDENT HOLDOUT (24 cases). */
export const N7_HOLDOUT_COMPOSITION = {
  total: 24,
  "compact-drop": 8,
  preview: 4,
  rehydrate: 2,
  partial: 2,
  visible: 4,
  changed: 2,
  diagnostic: 2,
};
