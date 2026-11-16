import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** Exercise shipped filtering functions. Collaborators own visibility/recency;
 * installed browser acceptance separately checks navigation and actual RPCs. */
async function filters() {
  const load = async (stem: string) => {
    try { return await readFile(new URL(`../../public/deepseek/harness-brand/plugins/dsh-client-ui-${stem}/client.js`, import.meta.url), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return readFile(new URL(`../../public/deepseek/plugins/dsh-client-ui-${stem}/client.js`, import.meta.url), "utf8"); }
  };
  const run = (source: string, name: string, context: Record<string, unknown>) => {
    const start = source.indexOf(`\t\tfunction ${name}(`);
    const end = source.indexOf("\n\t\t/**", start + 1);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    // New adapters are scoped to each actual plugin factory, not a global.
    const injected = source.indexOf("const harnessTextSearch = (");
    const injectedEnd = source.indexOf("\n\t\t// End Harness multilingual search.", injected);
    const prefix = injected < 0 ? "" : source.slice(injected, injectedEnd);
    return vm.runInNewContext(prefix + "\n" + source.slice(start, end) + `\n${name}`, context);
  };
  const commands = await load("commands"), workspace = await load("workspace");
  const filterOptions = run(commands, "filterOptions", { groupOptions: (options: unknown[]) => [{ rows: options }] });
  const deriveSearchResults = run(workspace, "deriveSearchResults", {
    mainSessionId: () => "current", sessionTitle: (s: { title: string }) => s.title,
    workspaceLabel: (cwd: string) => cwd.split("/").at(-1),
    sessionVisible: (s: { id: string }, _current: string, archived: Set<string>, filter: string) => filter === "all" || !archived.has(s.id),
    orderByRecency: (ids: string[]) => ids, visiblePendingKind: () => undefined, runningChildCount: () => 0,
  });
  return { filterOptions, deriveSearchResults };
}

describe("actual popup search preserves policy while normalizing user text", () => {
  it.each(["Ｆｕｌｌ", "access Full", "FULL access"])("finds a substring-policy option with query %s", async query => {
    const { filterOptions } = await filters();
    const options = [{ label: "Full access", detail: "All workspace commands", value: "full" }, { label: "Read only", value: "read" }];
    expect(filterOptions(options, query).map((o: { value: string }) => o.value)).toEqual(["full"]);
  });
  it("does not apply fuzzy matching to descriptions or substring-only option labels", async () => {
    const { filterOptions } = await filters();
    expect(filterOptions([{ label: "Full access", detail: "All workspace commands" }], "fl ac")).toEqual([]);
  });
  it("keeps blank-query option objects and order", async () => {
    const { filterOptions } = await filters(), options = [{ label: "Z" }, { label: "A", active: true }];
    expect(filterOptions(options, " ")).toEqual(options);
  });
});

const rows = [
  { id: "a", title: "修复 登录流程", cwd: "/projects/ＷＥＢ-client", running: false },
  { id: "b", title: "API review", cwd: "/projects/server", running: false },
  { id: "blank", title: "修复 登录流程", cwd: "/projects/server", blank: true, running: false },
];
async function search(query: string, options: { archived?: string[]; content?: { items: unknown[]; hasMore: boolean }; list?: typeof rows } = {}) {
  const { deriveSearchResults } = await filters(), items = options.list ?? rows;
  return deriveSearchResults({ ids: items.map(s => s.id), byId: Object.fromEntries(items.map(s => [s.id, s])) }, [], query,
    options.archived ?? [], "active", new Map(), options.content ?? { items: [], hasMore: false }, 20);
}

describe("actual workspace local search retains visibility and host content merge", () => {
  it.each(["web", "登录 修复", "修 登"])("finds the correct named session for %s", async query => {
    expect((await search(query)).items.map((s: { id: string }) => s.id)).toEqual(["a"]);
  });
  it("does not reveal blank or archived sessions that match", async () => {
    expect((await search("修复", { archived: ["a"] })).items).toEqual([]);
  });
  it("preserves host content results without duplicating a local match", async () => {
    const result = await search("API", { content: { items: [{ sessionId: "b", snippet: "actual content" }], hasMore: true } });
    expect(result.items).toHaveLength(1); expect(result.items[0]).toMatchObject({ id: "b", snippet: "actual content" }); expect(result.hasMore).toBe(true);
  });
  it("updates renamed/deleted session candidates on the next list snapshot", async () => {
    expect((await search("API")).items).toHaveLength(1);
    expect((await search("API", { list: [{ ...rows[0]!, title: "New task" }] })).items).toEqual([]);
  });
});


describe("actual model menu indices follow current catalog and ranking", () => {
  async function models(groups: unknown[], query: string) {
    const source = await readFile(new URL("../../public/deepseek/harness-brand/plugins/dsh-client-ui-model-selection/client.js", import.meta.url), "utf8");
    const injected = source.indexOf("const harnessTextSearch = (");
    const endInjected = source.indexOf("\n\t\t// End Harness multilingual search.", injected);
    const start = source.indexOf("const groupIndexes = (0, react.useMemo)");
    const end = source.indexOf("const visibleModels =", start);
    expect(injected).toBeGreaterThan(0); expect(start).toBeGreaterThan(injected); expect(end).toBeGreaterThan(start);
    return vm.runInNewContext(source.slice(injected, endInjected) + "\n" + source.slice(start, end) + "\nfilteredGroups", {
      groups, query, showSearch: true, react: { useMemo: (build: () => unknown) => build() },
    });
  }
  it("matches both actual model IDs and display names without changing provider order", async () => {
    const groups = [{ id: "first", models: [{ id: "m1", name: "Alpha Coder" }] }, { id: "second", models: [{ id: "alpha-m2", name: "Local Model" }] }];
    expect((await models(groups, "ａｌｐｈａ")).map((g: { id: string }) => g.id)).toEqual(["first", "second"]);
    expect((await models(groups, "Coder Alpha"))[0].models.map((m: { id: string }) => m.id)).toEqual(["m1"]);
  });
  it("descriptions require contiguous term matches and do not create noisy fuzzy hits", async () => {
    const groups = [{ id: "first", models: [{ id: "plain", name: "Plain", description: "invoice testing" }] }];
    expect(await models(groups, "ivc")).toEqual([]);
    expect((await models(groups, "testing invoice"))[0].models[0].id).toBe("plain");
  });
  it("a replacement catalog removes the old model name", async () => {
    expect((await models([{ id: "p", models: [{ id: "m1", name: "Old Model" }] }], "Old"))).toHaveLength(1);
    expect(await models([{ id: "p", models: [{ id: "m1", name: "New Model" }] }], "Old")).toEqual([]);
  });
});
