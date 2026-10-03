import { describe, expect, it } from "vitest";
import * as evaluation from "./index.js";
import { activationEvidenceFor } from "./activation-evidence.js";
const ID = "path_scoped_instructions_v1";
const eligible = (fixture?: Record<string, string>) => ((evaluation as unknown as { pathScopedInstructionsEligible?: (caseDef: { fixture?: Record<string, string> }) => boolean }).pathScopedInstructionsEligible?.({ fixture })) ?? false;
const fixture = { "AGENTS.md": "root", "a/AGENTS.md": "a rules", "a/file.ts": "a", "b/AGENTS.md": "b rules", "b/file.ts": "b" };
describe("S2 fixed original-case activation eligibility", () => {
  it("recognizes distinct sibling package docs with actual package files", () => {
    expect(eligible(fixture)).toBe(true);
    expect(eligible(Object.fromEntries(Object.entries(fixture).map(([path, content]) => [path.replaceAll("/", "\\"), content])))).toBe(true);
    expect(activationEvidenceFor(ID, { id: "monorepo", fixture }, []).eligible).toBe(true);
  });
  it("does not invent eligibility from empty, root-only, duplicate, ancestor-only, traversal or outside docs", () => {
    const invalid: Array<Record<string, string> | undefined> = [undefined, {}, { "AGENTS.md": "root" }, { ...fixture, "b/AGENTS.md": "a rules" },
      { "a/AGENTS.md": "a", "a/b/AGENTS.md": "b", "a/file": "file", "a/b/file": "file" },
      { "../a/AGENTS.md": "a", "../a/file": "file", "b/AGENTS.md": "b", "b/file": "file" },
      { "/a/AGENTS.md": "a", "/a/file": "file", "b/AGENTS.md": "b", "b/file": "file" },
      { "C:\\a\\AGENTS.md": "a", "C:\\a\\file": "file", "b/AGENTS.md": "b", "b/file": "file" },
      { "a/AGENTS.md": "a", "b/AGENTS.md": "b" },
    ];
    for (const files of invalid) expect(eligible(files)).toBe(false);
  });
  it("requires observed selection identity and reports eligible-but-not-activated for no selection", () => {
    for (const payload of [{}, { constructorIdentity: "context:path-scoped-instructions-v1" }, { configDigest: "config", instructionSources: [] }]) {
      expect(activationEvidenceFor(ID, { id: "monorepo", fixture }, [{ type: "path_scoped_instructions_selected", payload }]).activated).toBe(false);
    }
    expect(activationEvidenceFor(ID, { id: "monorepo", fixture }, [])).toMatchObject({ eligible: true, activated: false, activationCount: 0 });
    const payload = { constructorIdentity: "context:path-scoped-instructions-v1", configDigest: "config", instructionFingerprint: "rendered-snapshot", instructionSources: [{ kind: "project_instruction", path: "a/AGENTS.md", contentHash: "rendered-content" }] };
    expect(activationEvidenceFor(ID, { id: "monorepo", fixture }, [{ type: "path_scoped_instructions_selected", payload }])).toMatchObject({ eligible: true, activated: true, activationCount: 1, candidateMechanismDigest: "config" });
    expect(activationEvidenceFor(ID, { id: "no-docs" }, [{ type: "path_scoped_instructions_selected", payload }])).toMatchObject({ eligible: false, activated: false, activationCount: 0 });
  });
});
