import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, it } from "vitest";

// Execute the actual frozen/generated component rather than mirroring the
// label expression. Its responsive stylesheet deliberately hides label text.
async function renderUsage(derived: boolean, locale: "en" | "zh") {
  const root = derived ? "harness-brand/plugins" : "plugins";
  const source = await readFile(new URL(`../../public/deepseek/${root}/dsh-client-ui-chat/client.js`, import.meta.url), "utf8");
  const start = source.indexOf("function TurnUsagePanel({ usage, t }) {"), end = source.indexOf("\n\t\t//#endregion", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const names = [...source.matchAll(/"message\.turnUsage\.consumed": "([^"]+)"/g)].map(match => match[1]);
  const label = names[locale === "zh" ? 0 : 1];
  if (label === undefined) throw new Error("Pinned usage dictionary is missing");
  let opened = false;
  const jsx = (type: string, props: Record<string, unknown>) => ({ type, props });
  const component = vm.runInNewContext(source.slice(start, end) + ";TurnUsagePanel", {
    useStatDialog: () => ({ open: false, setOpen: (value: boolean) => { opened = value; } }),
    formatCompactCount: (value: number) => `${value} tok`,
    TurnUsagePanel_module_css_default: { root: "root", trigger: "trigger", label: "label" },
    react_jsx_runtime: { jsx, jsxs: jsx },
    _deepseek_ai_dsh_client_ui_primitives: { IconDatabaseOutlineRegular: "svg" },
  });
  const tree = component({ usage: { totalTokens: 124, outputTokens: 60 }, t: (_key: string, args: { total: string }) => label.replace("{total}", args.total) });
  return { trigger: tree.props.children[0], opened: () => opened };
}

it.each(["en", "zh"] as const)("the responsive usage action has a localized accessible name and still opens its popover (%s)", async locale => {
  const original = await renderUsage(false, locale);
  expect(original.trigger.props["aria-label"]).toBeUndefined();
  const actual = await renderUsage(true, locale), expected = locale === "en" ? "Usage 124 tok" : "用量 124 tok";
  expect(actual.trigger.props["aria-label"]).toBe(expected);
  expect(actual.trigger.props.title).toBe(expected);
  expect(actual.trigger.props["aria-haspopup"]).toBe("dialog");
  actual.trigger.props.onClick(); expect(actual.opened()).toBe(true);
});
