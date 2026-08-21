// P2-10: Skill production integration — createHarness → runtime → fake model.
// Progressive disclosure (P2-8): the selected skill's body must reach the
// model context while unselected skill bodies stay out; the effectiveness
// funnel (P2-9) must observe the task outcome.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "./create-harness.js";
let tempDirs = [];
async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), "ar-skill-int-"));
    tempDirs.push(dir);
    return dir;
}
afterEach(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    tempDirs = [];
});
async function writeSkill(root, name, description, body) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nversion: "1.0.0"\n---\n\n${body}\n`, "utf8");
}
describe("P2-10: skill body injection through the real harness", () => {
    it("injects the selected skill body and records effectiveness on success", async () => {
        const skillRoot = await tempDir();
        const cwd = await tempDir();
        const dataDir = await tempDir();
        await writeSkill(skillRoot, "deploy", "deployment commands for releases", "# Deploy\nRun `pnpm deploy` to publish a release.\n");
        await writeSkill(skillRoot, "lint", "linting commands", "# Lint\nRun `pnpm lint` before every push.\n");
        const oldRoots = process.env.AR_SKILL_ROOTS;
        process.env.AR_SKILL_ROOTS = skillRoot;
        const captured = [];
        const { provider, model } = capturingProvider(captured);
        const harness = await createHarness({
            cwd,
            dataDir,
            profile: "test",
            modelProvider: provider,
            model,
            // Select exactly the deploy skill (progressive disclosure).
            skillSelector: (entries) => entries.filter((e) => e.name === "deploy"),
        });
        try {
            const session = await harness.runtime.createSession({ agent: harness.agents[0], cwd });
            const turn = await harness.runtime.startTurn(session.id, "run the release process");
            const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
            expect(outcome.status).toBe("completed");
            const system = captured.join("\n");
            // The selected skill's body reached the model as semi-trusted skill data.
            expect(system).toContain("Run `pnpm deploy`");
            expect(system).toContain("trust=semi-trusted");
            expect(system).toContain("source=skill");
            // The unselected skill body stays out (progressive disclosure).
            expect(system).not.toContain("pnpm lint");
            // P2-9: selected/loaded/injected + task outcome funnel.
            const effectiveness = await harness.skillBodies.effectivenessOf("deploy");
            expect(effectiveness).toBeDefined();
            expect(effectiveness.loadedCount).toBeGreaterThanOrEqual(1);
            expect(effectiveness.injectedCount).toBeGreaterThanOrEqual(1);
            expect(effectiveness.completedCount).toBe(1);
            const lintEffectiveness = await harness.skillBodies.effectivenessOf("lint");
            expect(lintEffectiveness).toBeUndefined();
        }
        finally {
            if (oldRoots === undefined)
                delete process.env.AR_SKILL_ROOTS;
            else
                process.env.AR_SKILL_ROOTS = oldRoots;
            await harness.close();
        }
    });
});
/** Fake provider with a known window; captures every system string. */
function capturingProvider(captured) {
    const model = { providerId: "matcher", modelId: "matcher-model" };
    const provider = {
        id: "matcher",
        async listModels() {
            return [
                {
                    id: model.modelId,
                    name: "Skill Matcher",
                    capabilities: { contextWindowTokens: 128_000 },
                },
            ];
        },
        createClient(_model, _config) {
            return {
                async *generate(request) {
                    captured.push(request.system ?? "");
                    yield { type: "started", timestamp: 0 };
                    yield { type: "text_delta", text: "ok", timestamp: 0 };
                    yield {
                        type: "completed",
                        result: { finishReason: "stop", text: "ok" },
                        timestamp: 0,
                    };
                },
            };
        },
    };
    return { provider, model };
}
//# sourceMappingURL=skill.integration.test.js.map