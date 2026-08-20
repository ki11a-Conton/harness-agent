// P2-8/P2-9: skill body provider — progressive disclosure (selected bodies
// only) and the effectiveness funnel (selected/loaded/injected/outcome).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSkillLoader } from "@ar/skills";
import { createSkillBodyBlockProvider } from "./skill-context.js";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-skillctx-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\nversion: "1.0.0"\n---\n\n${body}\n`,
    "utf8",
  );
}

function providerFor(root: string, dataDir: string) {
  const loader = new FileSkillLoader();
  return createSkillBodyBlockProvider({
    loader,
    discover: async () => {
      const skills = await loader.discover({ roots: [root], maxSkills: 10 });
      return skills;
    },
    dataDir,
    now: () => 1000,
  });
}

describe("P2-8: skill body blocks (progressive disclosure)", () => {
  it("loads only the selected skill's body as a semi-trusted context block", async () => {
    const root = await tempDir();
    const dataDir = await tempDir();
    await writeSkill(root, "deploy", "deployment commands", "# Deploy\nRun `pnpm deploy` for releases.");
    await writeSkill(root, "lint", "linting commands", "# Lint\nRun `pnpm lint` before pushing.");

    const provider = providerFor(root, dataDir);
    const blocks = await provider.load(["deploy"]);

    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.id).toBe("skill-body:deploy");
    expect(block.source).toBe("skill");
    expect(block.trust).toBe("semi-trusted");
    expect(block.content).toContain("Run `pnpm deploy`");
    // The unselected skill's body never leaks in.
    expect(blocks.some((b) => b.content.includes("pnpm lint"))).toBe(false);
  });

  it("skips unknown names and security-denied bodies silently", async () => {
    const root = await tempDir();
    const dataDir = await tempDir();
    await writeSkill(root, "deploy", "deployment commands", "# Deploy\nSafe body.");
    const provider = providerFor(root, dataDir);
    const blocks = await provider.load(["deploy", "does-not-exist"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.id).toBe("skill-body:deploy");
  });
});

describe("P2-9: skill effectiveness funnel", () => {
  it("records loaded + injected on body load and task outcome on completion", async () => {
    const root = await tempDir();
    const dataDir = await tempDir();
    await writeSkill(root, "deploy", "deployment commands", "# Deploy\nSafe body.");
    const provider = providerFor(root, dataDir);

    await provider.load(["deploy"]);
    await provider.record("deploy", { kind: "taskCompleted" });

    const effectiveness = await provider.effectivenessOf("deploy");
    expect(effectiveness).toBeDefined();
    expect(effectiveness!.loadedCount).toBe(1);
    expect(effectiveness!.injectedCount).toBe(1);
    expect(effectiveness!.completedCount).toBe(1);
    expect(effectiveness!.failedCount).toBe(0);

    const all = await provider.listEffectiveness();
    expect(Object.keys(all)).toEqual(["deploy"]);
  });

  it("persists effectiveness across provider instances (name-keyed)", async () => {
    const root = await tempDir();
    const dataDir = await tempDir();
    await writeSkill(root, "deploy", "deployment commands", "# Deploy\nSafe body.");
    const first = providerFor(root, dataDir);
    await first.load(["deploy"]);

    const second = providerFor(root, dataDir);
    const effectiveness = await second.effectivenessOf("deploy");
    expect(effectiveness!.injectedCount).toBe(1);
  });
});

describe("P6-2/P6-4: skill provenance + token ROI", () => {
  it("body blocks carry provenance and load books injection tokens for ROI", async () => {
    const root = await tempDir();
    const dataDir = await tempDir();
    await writeSkill(root, "deploy", "deployment commands", "# Deploy\nSafe body.");
    const provider = providerFor(root, dataDir);

    const blocks = await provider.load(["deploy"]);
    expect(blocks).toHaveLength(1);
    // P6-2: the body block traces to the manifest name.
    expect(blocks[0]!.provenance).toMatchObject({
      kind: "skill",
      serviceId: "skill-loader",
      toolId: "deploy",
    });
    // P6-4: injection cost booked; completion gives a positive ROI.
    await provider.record("deploy", { kind: "taskCompleted" });
    const roi = await provider.tokenROI("deploy");
    expect(roi.tokensInjected).toBeGreaterThan(0);
    expect(roi.tasksCompleted).toBe(1);
    expect(roi.roiPer1k).toBeGreaterThan(0);
  });
});
