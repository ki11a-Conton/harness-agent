/**
 * N6 / N2 — shared, deterministic case-authoring helpers.
 *
 * Both case sets (the MAIN experiment and the independent HOLDOUT) build their
 * evidence files through these helpers, so "large" and "medium" mean the same
 * number of bytes in both sets and the conditions are constructed the same way.
 * Everything here is deterministic: the same arguments always produce the same
 * bytes, which is what lets `generate-n6-cases.mjs --check` refuse drift.
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
  // Two ~8.6 KiB halves put the key line around the middle of an ~17 KiB file.
  const headBody = filler("NOTE", 90, 1);
  const tailBody = filler("NOTE", 90, 1000);
  return [...head, headBody, "", keyLine, "", tailBody, "", tailNote, ""].join("\n");
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

/** `require`s a fixture module and asserts one exported value. */
export function assertExport(modulePath, expression) {
  return `const m=require(${JSON.stringify(modulePath)});if(!(${expression})){console.error("n6 verifier failed: "+JSON.stringify({got:m}));process.exit(1);}`;
}

/** The frozen per-class composition both experiments must satisfy. */
export const EXPECTED_COMPOSITION = {
  total: 24,
  "compact-drop": 6,
  preview: 4,
  rehydrate: 4,
  partial: 2,
  visible: 4,
  changed: 2,
  diagnostic: 2,
};
