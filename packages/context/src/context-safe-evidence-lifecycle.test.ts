/**
 * N6 / N4 — the evidence lifecycle, exercised on the REAL MultiStageCompactor
 * against the FROZEN case fixtures.
 *
 * The candidate's rule is about evidence that is still visible versus evidence
 * that is gone, so the conditions it claims to handle have to be produced by the
 * real production compactor — not asserted from the guidance text. Each test
 * below drives the actual compactor with the actual bytes of a frozen N6 case
 * and asserts what the model would (and would not) still see:
 *
 *   - compact-drop : the evidence block is dropped, so the value the edit needs
 *                    is no longer visible; the SAME text survives when it sits
 *                    in a block the compactor may not drop (the "visible" half);
 *   - preview      : a >16 KiB evidence file keeps head+tail only, so a value in
 *                    the middle is only PARTIALLY available;
 *   - partial      : one of two evidence files survives while the other is
 *                    dropped, so exactly one value remains visible.
 *
 * Offline and deterministic: no provider, no network.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompactionSummary, ContextBlock } from "@ar/contracts";
import { MultiStageCompactor, previewMarker } from "./compaction.js";
import { DEFAULT_TOKEN_ESTIMATOR } from "./tokenizer.js";

const REPO = resolve(import.meta.dirname, "../../..");
const EVIDENCE_CASES = join(REPO, "benchmarks", "n6-evidence");

function caseFile(caseId: string, rel: string): string {
  return readFileSync(join(EVIDENCE_CASES, caseId, "fixture", ...rel.split("/")), "utf8");
}

function summary(over: Partial<CompactionSummary> = {}): CompactionSummary {
  return {
    goal: "continue task",
    constraints: [],
    decisions: [],
    completed: [],
    filesChanged: [],
    commandsRun: [],
    tests: [],
    failures: [],
    openTasks: [],
    importantFacts: [],
    artifactRefs: [],
    childAgentRefs: [],
    ...over,
  };
}

/** A tool-result evidence block exactly as the runtime constructs it. */
function evidenceBlock(id: string, content: string, over: Partial<ContextBlock> = {}): ContextBlock {
  return {
    id,
    source: "tool",
    trust: "untrusted",
    priority: 100,
    content,
    tokens: DEFAULT_TOKEN_ESTIMATOR.estimate(content),
    compressible: true,
    // The runtime marks every tool result block ephemeral — that is WHY
    // compaction can drop the original text at all.
    ephemeral: true,
    category: "evidence",
    ...over,
  };
}

const visibleText = (blocks: readonly ContextBlock[]): string => blocks.map((b) => b.content).join("\n");

describe("N6/N4 — evidence lifecycle on the real compactor (frozen N6 fixtures)", () => {
  it("compact-drop: the dropped evidence text is gone, while the same text in a non-droppable block survives", async () => {
    const evidence = caseFile("n6e-compact-01-retry-base", "spec/retry-policy.txt");
    // The authoritative value this case's edit depends on.
    expect(evidence).toContain("base_delay_ms = 250");

    const compactor = new MultiStageCompactor();

    // (a) The runtime shape: a tool result is EPHEMERAL, so compaction drops it
    //     outright and leaves NOTHING in its place — the model keeps no copy.
    const dropped = await compactor.compact([evidenceBlock("tool-read", evidence)], summary());
    expect(dropped).toEqual([]);

    // (b) A compactable (non-ephemeral) tool result is folded into a summary
    //     block instead: the TEXT is still gone, but the run state is not.
    const folded = await compactor.compact([evidenceBlock("tool-read", evidence, { ephemeral: false })], summary());
    expect(folded.map((b) => b.id)).toEqual(["compaction-summary"]);
    expect(visibleText(folded)).not.toContain("base_delay_ms = 250");
    expect(visibleText(folded)).not.toContain("Retry policy");

    // The "visible" half of the rule: the same bytes in a block the compactor
    // may not drop (the protected instruction surface) are still there.
    const kept = await compactor.compact(
      [
        evidenceBlock("tool-read", evidence),
        evidenceBlock("policy", evidence, {
          source: "project",
          ephemeral: false,
          compressible: false,
          category: "protected-instruction",
          trust: "trusted",
        }),
      ],
      summary(),
    );
    expect(visibleText(kept)).toContain("base_delay_ms = 250");
    expect(kept.some((b) => b.id === "policy")).toBe(true);
  });

  it("preview: past the preview budget the needed value is dropped while the head survives", async () => {
    const evidence = caseFile("n6e-preview-01-frame-limit", "spec/protocol.txt");
    expect(Buffer.byteLength(evidence, "utf8")).toBeGreaterThan(16 * 1024);
    expect(evidence).toContain("max_frame_bytes = 6144");
    // This fixture deliberately carries the authoritative value well past the
    // head of the document (at ~9 KiB of ~18 KiB), which is what makes it a
    // "long output / truncation" case for the runtime's inline renderer
    // (head 2000 B + tail 2000 B, packages/core/src/runtime/context-controller.ts).
    // The compactor's own offload stage keeps the HEAD only, so a budget below
    // the value's offset drops it — asserted here on the real compactor.
    expect(evidence.indexOf("max_frame_bytes = 6144")).toBeGreaterThan(4096);

    const stages: string[] = [];
    // `source: "mcp"` keeps this block out of the digest fold (which folds
    // tool/web/memory/subagent evidence — pinned by the compact-drop test
    // above), so the preview itself stays observable here.
    const output = await new MultiStageCompactor({
      previewMaxBytes: 4096,
      onStage: (report) => stages.push(`${report.stage}:${String(report.used)}`),
    }).compact([evidenceBlock("tool-read", evidence, { ephemeral: false, source: "mcp" })], summary());
    const shown = visibleText(output);

    expect(stages).toContain("offload:true");
    // The head survives, aligned to a line boundary …
    expect(shown.startsWith("# Wire protocol specification")).toBe(true);
    // … the truncation is explicit and carries the ORIGINAL byte count …
    expect(shown).toContain(previewMarker(Buffer.byteLength(evidence, "utf8")));
    // … and the value the edit needs is no longer available.
    expect(shown).not.toContain("max_frame_bytes = 6144");
    expect(Buffer.byteLength(shown, "utf8")).toBeLessThan(Buffer.byteLength(evidence, "utf8"));
  });

  it("partial: one evidence file survives while the other is dropped", async () => {
    const orientation = caseFile("n6e-partial-01-visible-plan-hidden-limit", "spec/plan.txt");
    const binding = caseFile("n6e-partial-01-visible-plan-hidden-limit", "spec/limits.txt");
    expect(binding).toContain("max_rows_per_request = 1500");

    const output = await new MultiStageCompactor().compact(
      [
        // Orientation text the task also points at, in a block that is not dropped.
        evidenceBlock("orientation", orientation, {
          source: "project",
          ephemeral: false,
          compressible: false,
          category: "protected-instruction",
          trust: "trusted",
        }),
        // The binding limit: a tool result, therefore droppable.
        evidenceBlock("tool-read-limits", binding),
      ],
      summary(),
    );
    const shown = visibleText(output);
    expect(shown).toContain("Ingest plan");
    expect(shown).not.toContain("max_rows_per_request = 1500");
  });

  it("the preview budget is a real threshold: just under it, the value stays visible", async () => {
    const evidence = caseFile("n6e-preview-02-shard-count", "spec/topology.txt");
    expect(evidence).toContain("shard_count = 23");
    // A budget larger than the file cannot truncate it.
    const stages: string[] = [];
    const output = await new MultiStageCompactor({
      previewMaxBytes: Buffer.byteLength(evidence, "utf8") + 1,
      onStage: (report) => stages.push(`${report.stage}:${String(report.used)}`),
    }).compact([evidenceBlock("tool-read", evidence, { ephemeral: false, source: "mcp" })], summary());
    const shown = visibleText(output);
    // The preview stage did NOT fire, the whole document is still there, and no
    // preview marker was injected — i.e. the truncation above is a threshold
    // effect, not an unconditional rewrite.
    expect(stages).toContain("offload:false");
    expect(shown).toContain("shard_count = 23");
    expect(shown).not.toContain("# [previewed at");
    expect(shown).toBe(evidence);
  });
});
