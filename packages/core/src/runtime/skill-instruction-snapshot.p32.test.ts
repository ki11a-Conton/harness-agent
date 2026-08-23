// P32 — Skills & Instruction Snapshot Closure.
//
// Same world-snapshot principle as MCP/tools: the skill world and the
// instruction world a model call sees are pinned into the step BEFORE the
// call, and a mid-run change can only affect the NEXT step.
//
// Covered here:
//   P32-1  SkillSnapshot identity — deterministic fingerprint over the
//          selected skill set (name/source/bodyHash/requiredTools/
//          requiredMcpServers), order-insensitive; a skill set change or body
//          change re-fingerprints.
//   P32-3  InstructionSnapshot deepens — explicit instruction sources
//          (system + project instructions) + a fingerprint that changes when
//          a discovered AGENTS.md document changes.
//   P32-4  Skill → MCP dependency integration — selecting a skill whose
//          manifest declares requiredMcpServers feeds the step's MCP binding
//          provider (lazily, not at process startup).
//
// The world-snapshot invariant: MODEL_VISIBLE_WORLD(step N) ==
// TOOL_EXECUTION_WORLD(step N). These unit tests pin the identity layer; the
// end-to-end wiring (context build → step snapshot) is exercised through the
// runtime loop in the step-snapshot invariant suite.

import { describe, expect, it } from "vitest";
import {
  buildSkillSnapshot,
  newAgentId,
  newSessionId,
  newTurnId,
  stableFingerprint,
  type AgentDefinition,
  type InstructionSource,
  type SkillSnapshot,
} from "@ar/contracts";
import { buildStepExecutionSnapshot } from "./step-snapshot-factory.js";
import type { StepToolCatalog } from "./tool-catalog.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "p32-test",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "m" },
  systemPrompt: "system v1",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const SESSION = newSessionId();
const TURN = newTurnId();

function catalog(): StepToolCatalog {
  return { get: () => undefined, list: () => [], specs: () => [] };
}

function build(opts: {
  system?: string;
  skills?: SkillSnapshot;
  instructionSources?: readonly InstructionSource[];
}) {
  const system = opts.system ?? AGENT.systemPrompt;
  return buildStepExecutionSnapshot({
    sessionId: SESSION,
    turnId: TURN,
    agent: { ...AGENT, systemPrompt: system },
    cwd: "/w",
    stepIndex: 0,
    priorBlocks: [],
    system,
    compacted: false,
    history: [{ id: "m1" } as never],
    registry: catalog(),
    semanticsOf: () => ({}) as never,
    sandboxPolicy: { filesystem: { read: ["**"], write: [] }, network: "deny", process: { exec: [] } } as never,
    skills: opts.skills,
    instructionSources: opts.instructionSources,
    now: () => 1_000,
  });
}

const SKILL_A = {
  name: "grill-me",
  source: "local-filesystem",
  bodyHash: "abc",
  requiredTools: ["read_file"],
  requiredMcpServers: ["mcp:weather"],
};

const SKILL_B = {
  name: "deploy",
  source: "local-filesystem",
  requiredTools: ["exec"],
  requiredMcpServers: [],
};

describe("P32-1 SkillSnapshot identity", () => {
  it("object KEY insertion order is irrelevant (canonical fingerprint input)", () => {
    // Same semantic entries, different object key insertion order.
    const s1 = buildSkillSnapshot([{ name: "a", requiredTools: ["t"], requiredMcpServers: [] }]);
    const s2 = buildSkillSnapshot([{ requiredMcpServers: [], requiredTools: ["t"], name: "a" }]);
    expect(s1.fingerprint).toBe(s2.fingerprint);
  });

  it("selected-skill ARRAY order matters (injection order is model-visible)", () => {
    const s1 = buildSkillSnapshot([SKILL_A, SKILL_B]);
    const s2 = buildSkillSnapshot([SKILL_B, SKILL_A]);
    // The order skills are listed is the order they reach the model — a
    // reordered world is a DIFFERENT world (like instructions above).
    expect(s1.fingerprint).not.toBe(s2.fingerprint);
    expect(s1.selected.map((x) => x.name).sort()).toEqual(["deploy", "grill-me"]);
  });

  it("skill-set change re-fingerprints", () => {
    const only = buildSkillSnapshot([SKILL_A]);
    const withB = buildSkillSnapshot([SKILL_A, SKILL_B]);
    expect(only.fingerprint).not.toBe(withB.fingerprint);
  });

  it("body / requirement change re-fingerprints", () => {
    const v1 = buildSkillSnapshot([SKILL_A]);
    const v2 = buildSkillSnapshot([{ ...SKILL_A, bodyHash: "xyz" }]);
    const v3 = buildSkillSnapshot([{ ...SKILL_A, requiredMcpServers: ["mcp:internal"] }]);
    expect(v1.fingerprint).not.toBe(v2.fingerprint);
    expect(v1.fingerprint).not.toBe(v3.fingerprint);
  });

  it("requiredMcpServers ride the snapshot — the P32-4 hook point", () => {
    const snap = buildSkillSnapshot([SKILL_A]);
    expect(snap.selected[0]!.requiredMcpServers).toEqual(["mcp:weather"]);
  });
});

describe("P32-1 skills pinned into the step record", () => {
  it("skillSnapshotFingerprint rides StepRecord when skills are pinned", () => {
    const skills = buildSkillSnapshot([SKILL_A]);
    const snap = build({ skills });
    expect(snap.record.skillSnapshotFingerprint).toBe(skills.fingerprint);
    expect(snap.skills?.fingerprint).toBe(skills.fingerprint);
    expect(snap.skills?.selected[0]?.name).toBe("grill-me");
  });

  it("no skillSnapshotFingerprint when no skills are pinned", () => {
    expect(build({}).record.skillSnapshotFingerprint).toBeUndefined();
  });
});

describe("P32-3 InstructionSnapshot sources", () => {
  it("defaults to a single system source without explicit sources", () => {
    const snap = build({});
    expect(snap.instructions.sources).toEqual([
      { kind: "system", source: "system", contentHash: expect.any(String) },
    ]);
    expect(snap.instructions.fingerprint).toBe(snap.record.instructionFingerprint);
  });

  it("explicit sources re-fingerprint when an AGENTS.md document changes", () => {
    const sourcesA: InstructionSource[] = [
      { kind: "system", source: "system", contentHash: stableFingerprint(["sys"]) },
      { kind: "project_instruction", source: "/w/AGENTS.md", contentHash: stableFingerprint(["do x"]), path: "/w/AGENTS.md" },
    ];
    const sourcesB: InstructionSource[] = [
      { kind: "system", source: "system", contentHash: stableFingerprint(["sys"]) },
      { kind: "project_instruction", source: "/w/AGENTS.md", contentHash: stableFingerprint(["do y"]), path: "/w/AGENTS.md" },
    ];
    const a = build({ instructionSources: sourcesA });
    const b = build({ instructionSources: sourcesB });
    expect(a.instructions.fingerprint).not.toBe(b.instructions.fingerprint);
    expect(a.record.instructionFingerprint).not.toBe(b.record.instructionFingerprint);
  });

  it("source ORDER matters — the model-visible instruction order is part of the world", () => {
    const sys: InstructionSource = { kind: "system", source: "system", contentHash: "h1" };
    const doc: InstructionSource = { kind: "project_instruction", source: "/w/AGENTS.md", contentHash: "h2", path: "/w/AGENTS.md" };
    const a = build({ instructionSources: [sys, doc] });
    const b = build({ instructionSources: [doc, sys] });
    // The model sees system-then-document; a reordered world is a DIFFERENT
    // world (same contents, different visible order) → different fingerprint.
    expect(a.instructions.fingerprint).not.toBe(b.instructions.fingerprint);
  });
});