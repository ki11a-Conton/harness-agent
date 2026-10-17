import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, it } from "vitest";

async function settings(derived: boolean) {
  const source = await readFile(new URL(`../../public/deepseek/${derived ? "harness-brand/plugins" : "plugins"}/dsh-client-ui-settings-general/client.js`, import.meta.url), "utf8");
  const start = source.indexOf("function SettingsRoot(props) {"), end = source.indexOf("\n\t\t//#endregion", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const state: unknown[] = [], refs: Array<{ current: unknown }> = [], dependencies: unknown[][] = [];
  let cursor = 0, refCursor = 0, effectCursor = 0, effects: Array<() => void> = [];
  let open = false, blank = false, closes = 0;
  const slots: Array<{ name: string; props: Record<string, unknown> }> = [];
  const effect = (callback: () => void, deps: unknown[]) => {
    const index = effectCursor++, before = dependencies[index];
    dependencies[index] = deps;
    if (!before || deps.some((value, i) => !Object.is(value, before[i]))) effects.push(callback);
  };
  const jsx = (type: string, props: Record<string, unknown>) => ({ type, props });
  const root = vm.runInNewContext(source.slice(start, end) + ";SettingsRoot", {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
        return [state[index], (value: unknown) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
      },
      useRef(initial: unknown) { return refs[refCursor++] ??= { current: initial }; },
      useEffect: effect, useLayoutEffect: effect, useCallback: (callback: unknown) => callback,
    },
    react_jsx_runtime: { jsx, jsxs: jsx, Fragment: "fragment" },
    _deepseek_ai_dsh_client_ui_primitives: { Tooltip: "tooltip", ConnectionIndicator: "connection" },
    clsx: (...values: string[]) => values.filter(Boolean).join(" "),
    SettingsRoot_module_css_default: {}, SettingsPanel: "settings-panel", DesktopUpdateIndicator: "update",
    performance,
  });
  const close = () => { open = false; closes++; };
  const steps = [{ id: "deepseek-official", order: 0 }];
  const props = {
    wide: false, t: (key: string) => key, actions: { close, open: () => { open = true; }, openSection() {}, select() {} },
    useStore: () => ({ open }), useShortcuts: () => [], useSections: () => [], useDesktopUpdate: () => ({}),
    useConnectionState: () => "connected", useOnboardingSteps: () => steps,
    useSessions: (select: (value: unknown) => unknown) => select({ phase: "ready", byId: { main: { retainedBy: { mainView: 1 }, blank } } }),
    // A registered onboarding step can render null while deciding or when the
    // provider is already configured; its appearance is not a blocking modal.
    renderSlot: (name: string, value: Record<string, unknown>) => { slots.push({ name, props: value }); return null; },
  };
  const render = () => {
    cursor = 0; refCursor = 0; effectCursor = 0; effects = []; slots.length = 0;
    root(props); for (const run of effects) run();
  };
  return { render, slots, setOpen: (value: boolean) => { open = value; }, setBlank: (value: boolean) => { blank = value; },
    open: () => open, closes: () => closes };
}

it("the original settings shell closes on an asynchronous blank-session onboarding step even when that step paints no modal", async () => {
  const shell = await settings(false); shell.render(); shell.setOpen(true); shell.render();
  shell.setBlank(true); shell.render(); expect(shell.open()).toBe(false); expect(shell.closes()).toBe(1);
});

it("automatic onboarding waits for a user-opened Settings panel and remains available after it closes", async () => {
  const shell = await settings(true); shell.render(); shell.setOpen(true); shell.render();
  shell.setBlank(true); shell.render(); expect(shell.open()).toBe(true); expect(shell.closes()).toBe(0);
  expect(shell.slots.some(slot => slot.name === "settings.onboarding")).toBe(false);
  shell.setOpen(false); shell.render(); expect(shell.slots.find(slot => slot.name === "settings.onboarding")?.props.stepId).toBe("deepseek-official");
});

it("an explicit onboarding request still replaces Settings and selects exactly its requested step", async () => {
  const shell = await settings(true); shell.render(); shell.setOpen(true); shell.render();
  const launcher = shell.slots.find(slot => slot.name === "settings.launcher");
  (launcher?.props.openOnboarding as (id: string) => void)("deepseek-official"); shell.render();
  expect(shell.open()).toBe(false);
  expect(shell.slots.find(slot => slot.name === "settings.onboarding")?.props).toMatchObject({ stepId: "deepseek-official", explicit: true });
});
