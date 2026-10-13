// Harness Agent local brand slot occupants. See retained upstream notices.
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-brand-official",
  factory: (require) => {
    const { jsx } = require("react/jsx-runtime");
    function Mark({ size = 24, className } = {}) {
      return jsx("svg", { width: size, height: size, viewBox: "0 0 32 32", className,
        role: "img", "aria-label": "Harness Agent", "data-harness-brand": "mark",
        children: jsx("path", { d: "M6 5h5v8h10V5h5v22h-5v-9H11v9H6z", fill: "currentColor" }) });
    }
    function Name() {
      return jsx("span", { "data-harness-brand": "name", style: { fontFamily: "system-ui,sans-serif", fontSize: 17, fontWeight: 650, whiteSpace: "nowrap" }, children: "Harness Agent" });
    }
    return { inject: ["slots"], apply(ctx) {
      ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({ name: "sidebar.brand.mark" }, Mark));
      ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name" }, Name));
      ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, Mark));
    } };
  }
});
