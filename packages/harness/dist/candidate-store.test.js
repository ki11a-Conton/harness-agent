// P2-6: learning candidate store — durable JSONL queue.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANDIDATES_FILE_NAME, JsonlCandidateStore } from "./candidate-store.js";
let tempDirs = [];
async function tempDataDir() {
    const dir = await mkdtemp(join(tmpdir(), "ar-candidates-"));
    tempDirs.push(dir);
    return dir;
}
afterEach(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    tempDirs = [];
});
function candidate(id, content = "lesson content") {
    return {
        id,
        kind: "memory",
        content,
        proposedAt: 1000,
        securityChecked: true,
    };
}
describe("P2-6: JsonlCandidateStore", () => {
    it("adds, lists, gets, updates and removes candidates", async () => {
        const dataDir = await tempDataDir();
        const store = new JsonlCandidateStore({ dataDir });
        await store.add(candidate("c-1"));
        await store.add(candidate("c-2"));
        expect((await store.list()).map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);
        expect((await store.get("c-1")).content).toBe("lesson content");
        expect(await store.get("missing")).toBeUndefined();
        await store.update({ ...candidate("c-1", "updated lesson") });
        expect((await store.get("c-1")).content).toBe("updated lesson");
        await store.remove("c-1");
        expect(await store.get("c-1")).toBeUndefined();
        expect(await store.list()).toHaveLength(1);
    });
    it("persists across instances (durable queue)", async () => {
        const dataDir = await tempDataDir();
        const first = new JsonlCandidateStore({ dataDir });
        await first.add(candidate("c-1", "persisted lesson"));
        await first.add(candidate("c-2"));
        const second = new JsonlCandidateStore({ dataDir });
        expect((await second.list()).map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);
        expect((await second.get("c-1")).content).toBe("persisted lesson");
    });
    it("skips corrupt lines without failing", async () => {
        const dataDir = await tempDataDir();
        const store = new JsonlCandidateStore({ dataDir });
        await store.add(candidate("c-1"));
        // Corrupt the file manually.
        const { appendFile } = await import("node:fs/promises");
        await appendFile(join(dataDir, CANDIDATES_FILE_NAME), "not-json\n", "utf8");
        const reopened = new JsonlCandidateStore({ dataDir });
        expect((await reopened.list()).map((c) => c.id)).toEqual(["c-1"]);
    });
});
//# sourceMappingURL=candidate-store.test.js.map