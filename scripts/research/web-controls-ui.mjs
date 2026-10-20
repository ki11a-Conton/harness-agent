/** Small native React slot occupants over the existing live session protocol. */
const controls = String.raw`
		function HarnessControls({ useProjection, runCommand, t }) {
			const plan = useProjection("harnessPlan");
			const goal = useProjection("goal");
			const compact = useProjection("harnessCompaction");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			const [editing, setEditing] = react.useState(false);
			const [objective, setObjective] = react.useState("");
			const activePlan = plan && (plan.status === "draft" || plan.status === "review");
			const mode = activePlan ? "plan" : goal?.goal.phase === "active" ? "goal" : "default";
			const run = async (line) => {
				setBusy(true); setError("");
				try { await runCommand(line); return true; }
				catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
				finally { setBusy(false); }
			};
			return react_jsx_runtime.jsxs("div", { "data-harness-controls": "composer", style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }, children: [
				react_jsx_runtime.jsxs("select", { "aria-label": t("harness.mode"), value: mode, disabled: busy, onChange: async (event) => {
					const value = event.target.value;
					if (value === "plan") { await run("/plan on"); return; }
					if (activePlan && !await run("/plan off")) return;
					if (value === "default") { if (goal?.goal.phase === "active") await run("/goal pause"); return; }
					if (goal?.goal.phase === "paused" || goal?.goal.phase === "blocked") { await run("/goal resume"); return; }
					if (goal?.goal.phase === "complete" && !await run("/goal clear")) return;
					setEditing(true);
				}, children: [
					react_jsx_runtime.jsx("option", { value: "default", children: t("harness.mode.default") }),
					react_jsx_runtime.jsx("option", { value: "plan", children: t("harness.mode.plan") }),
					react_jsx_runtime.jsx("option", { value: "goal", children: t("harness.mode.goal") })
				] }),
				compact?.pending || compact?.running ? react_jsx_runtime.jsx("span", { role: "status", children: t(compact?.running ? "harness.compact.running" : "harness.compact.pending") }) : null,
				goal ? react_jsx_runtime.jsx("span", { role: "status", children: t("harness.goal.rounds") + " " + goal.roundsStarted + "/" + goal.goal.maxGoalRounds }) : null,
				goal?.goal.blockedReason ? react_jsx_runtime.jsx("span", { role: "status", children: goal.goal.blockedReason.message }) : null,
				compact?.lastCompletedAt && !compact?.pending && !compact?.running ? react_jsx_runtime.jsx("span", { role: "status", children: t(compact.lastSummarySource === "extractive" ? "harness.compact.fallback" : "harness.compact.done") }) : null,
				editing ? react_jsx_runtime.jsxs("div", { role: "group", "aria-label": t("harness.mode.goal"), style: { flexBasis: "100%" }, children: [
					react_jsx_runtime.jsx("textarea", { "aria-label": t("harness.objective"), value: objective, maxLength: 16000, onChange: event => setObjective(event.target.value) }),
					react_jsx_runtime.jsx("button", { type: "button", disabled: busy || !objective.trim(), onClick: async () => { if (await run("/goal " + objective.trim())) { setEditing(false); setObjective(""); } }, children: t("harness.goal.start") }),
					react_jsx_runtime.jsx("button", { type: "button", onClick: () => setEditing(false), children: t("harness.cancel") })
				] }) : null,
				plan?.status === "review" || plan?.status === "approved" && !plan.admitted ? react_jsx_runtime.jsxs("details", { "data-harness-plan-review": true, style: { flexBasis: "100%" }, children: [
					react_jsx_runtime.jsx("summary", { children: t("harness.plan.review") }),
					react_jsx_runtime.jsx("pre", { style: { whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }, children: plan.content }),
					react_jsx_runtime.jsx("button", { type: "button", disabled: busy, onClick: () => run("/plan approve " + (plan.status === "approved" ? plan.revision - 1 : plan.revision)), children: t("harness.plan.approve") })
				] }) : null,
				error ? react_jsx_runtime.jsx("span", { role: "alert", children: error }) : null
			] });
		}
`;
const registration = String.raw`
			ctx.locale.register("harness.controls", {
				en: { "harness.mode": "Task mode", "harness.mode.default": "Code", "harness.mode.plan": "Plan", "harness.mode.goal": "Goal", "harness.objective": "Goal objective", "harness.goal.start": "Start goal", "harness.cancel": "Cancel", "harness.plan.review": "Review implementation plan", "harness.plan.approve": "Approve and implement", "harness.compact": "Compress context", "harness.compact.pending": "Will compress next request", "harness.compact.done": "Context compressed" },
				zh: { "harness.mode": "任务模式", "harness.mode.default": "编程", "harness.mode.plan": "计划", "harness.mode.goal": "目标", "harness.objective": "目标内容", "harness.goal.start": "开始目标", "harness.cancel": "取消", "harness.plan.review": "审阅实施计划", "harness.plan.approve": "批准并实施", "harness.compact": "压缩上下文", "harness.compact.pending": "下一次请求前压缩", "harness.compact.done": "上下文已压缩" }
			});
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "harness-controls", order: 5, locale: "harness.controls", inject: sessionId => ({ runCommand: async line => {
				const live = ctx.sessions.binding(sessionId)?.session;
				if (!live) throw new Error("Session is unavailable");
				const result = await live.command(line);
				if (!result.ok) throw new Error(result.error.message);
				if (!result.value?.matched || result.value.result?.kind === "error") throw new Error(result.value?.result?.text || "Command failed");
			} }) }, HarnessControls));
`;
export function addControlsUi(stem, source) {
  if (stem === 'dsh-client-ui-conversation') {
    for (const part of ['row', 'tools', 'modes']) {
      const boundary = `className: InputBar_module_css_default.${part},`;
      if (source.split(boundary).length !== 2) throw new Error('Unreviewed composer layout boundary: ' + part);
      source = source.replace(boundary, boundary + `\n "data-harness-composer-${part}": true,`);
    }
    const marker = '\t\tfunction apply(ctx, config = Config({})) {';
    const at = source.lastIndexOf(marker);
    if (at < 0 || !source.slice(at).includes('conversation.input.left')) throw new Error('Unreviewed conversation control boundary');
    source = source.slice(0, at) + controls + source.slice(at, at + marker.length) + registration + source.slice(at + marker.length);
  }
  if (stem === 'dsh-client-ui-permission-presets') {
    const before = 'live.command(`/permission ${preset}`)';
    if (source.split(before).length !== 2) throw new Error('Unreviewed permission confirmation boundary');
    source = source.replace(before, 'live.command(`/permission ${preset}${preset === "danger-full-access" ? " --confirmed" : ""}`)');
    const start = source.indexOf('function PermissionSelect('), end = source.indexOf('\n\t\t//#endregion', start);
    if (start < 0 || end < start) throw new Error('Unreviewed permission component');
    let component = source.slice(start, end);
    const replace = (before, after) => {
      if (component.split(before).length !== 2) throw new Error('Unreviewed permission state boundary: ' + before.slice(0, 60));
      component = component.replace(before, after);
    };
    replace('const [pick, setPick] = (0, react.useState)(null);', 'const [pick, setPick] = (0, react.useState)(null);\n const [error, setError] = (0, react.useState)("");');
    replace('const currentValue = pick !== null && catalog.options.some((option) => option.value === pick) ? pick : selection.currentValue;',
      'const currentValue = selection.currentValue;');
    const submit = /const submit = \(id\) => \{[\s\S]*?\n\t\t\t\};/g;
    if ([...component.matchAll(submit)].length !== 1) throw new Error('Unreviewed permission save boundary');
    component = component.replace(submit, `const submit = async (id) => {
      setPick(id); setError("");
      try { if (await select(id) === false) throw new Error("Permission change was rejected"); }
      catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { setPick(null); }
    };`);
    replace('disabled: locked || busy,', 'disabled: locked || busy,\n "aria-busy": pick !== null,');
    replace('}), confirmation !== null && (0, react_jsx_runtime.jsx)', `}), pick !== null ? (0, react_jsx_runtime.jsx)("span", { role: "status", "data-harness-permission-pending": true, children: t("save.pending") }) : null,
      error ? (0, react_jsx_runtime.jsx)("span", { role: "alert", "data-harness-permission-error": true, children: error }) : null,
      confirmation !== null && (0, react_jsx_runtime.jsx)`);
    source = source.slice(0, start) + component + source.slice(end);
    for (const [marker, text] of [['"mode": "Access mode, current: {name}",', 'Saving permissions…'], ['"mode": "访问模式，当前：{name}",', '正在保存权限…']]) {
      if (source.split(marker).length !== 2) throw new Error('Unreviewed permission locale boundary');
      source = source.replace(marker, marker + '\n "save.pending": ' + JSON.stringify(text) + ',');
    }
    const matched = 'if (!result.value.matched) throw new Error("the host offers no /permission command");';
    if (source.split(matched).length !== 2) throw new Error('Unreviewed permission result boundary');
    source = source.replace(matched, matched + '\n if (result.value.result?.kind === "error") throw new Error(result.value.result.text || "Permission command failed");');
  }
  if (stem === 'dsh-client-ui-model-selection') {
    const marker = '}), reasoning !== void 0 && (0, react_jsx_runtime.jsxs)("button", {';
    if (source.split(marker).length !== 2) throw new Error('Unreviewed unsupported reasoning boundary');
    source = source.replace(marker, '}), reasoning === void 0 && (0, react_jsx_runtime.jsx)("div", { role: "note", className: ModelSelect_module_css_default.empty, children: t("empty.efforts") }), reasoning !== void 0 && (0, react_jsx_runtime.jsxs)("button", {');
  }
  if (stem === 'dsh-client-ui-goal') {
    const marker = 'const sessions = ctx.sessions;';
    if (source.split(marker).length !== 2) throw new Error('Unreviewed goal acknowledgement boundary');
    source = source.replace(marker, marker + `
      const acknowledged = new Map();
      const remember = (sessionId, result) => {
        if (result.ok && result.value && typeof result.value.id === "string" && Number.isSafeInteger(result.value.revision)) acknowledged.set(sessionId, { id: result.value.id, revision: result.value.revision });
        return result;
      };
      ctx.effect(() => () => acknowledged.clear(), "harness-goal: acknowledged refs");`);
    const ref = 'if (projection == null) return void 0;';
    if (source.split(ref).length !== 2) throw new Error('Unreviewed goal projected ref boundary');
    source = source.replace(ref, ref + '\n const ack = acknowledged.get(sessionId); if (ack?.id === projection.goal.id && ack.revision > projection.goal.revision) return ack;');
    for (const operation of ['edit', 'pause', 'resume', 'clear']) {
      const call = `return await ctx.remote.goals.${operation}(sessionId, ref${operation === 'edit' ? ', { objective }' : ''});`;
      if (source.split(call).length !== 2) throw new Error('Unreviewed goal mutation acknowledgement: ' + operation);
      source = source.replace(call, `return remember(sessionId, await ctx.remote.goals.${operation}(sessionId, ref${operation === 'edit' ? ', { objective }' : ''}));`);
    }
  }
  if (stem === 'dsh-client-ui-settings-models') {
    const marker = 'children: [["contextWindow", "maxTokens"].map';
    const field = `children: [(0, react_jsx_runtime.jsxs)("label", { children: [(0, react_jsx_runtime.jsx)("span", { children: t("modelReasoning") }), (0, react_jsx_runtime.jsx)("textarea", { "aria-label": t("modelReasoning") + " " + position, disabled, value: typeof model.reasoningEfforts === "string" ? model.reasoningEfforts : model.reasoningEfforts === undefined ? "" : JSON.stringify(model.reasoningEfforts), placeholder: '{"low":"low","medium":"medium","high":"high"}', onChange: event => { const raw = event.target.value; let value; try { value = raw.trim() ? JSON.parse(raw) : undefined; } catch { value = raw; } props.onFieldChange("reasoningEfforts", value); } })] }), ["contextWindow", "maxTokens"].map`;
    if (source.split(marker).length !== 2) throw new Error('Unreviewed model reasoning field boundary');
    source = source.replace(marker, field);
    const validation = 'const maxTokens = model["maxTokens"];';
    if (source.split(validation).length !== 2) throw new Error('Unreviewed model reasoning validation boundary');
    source = source.replace(validation, `const efforts = model.reasoningEfforts;
      if (efforts !== undefined && efforts !== false && (typeof efforts !== "object" || efforts === null || Array.isArray(efforts) || !Object.keys(efforts).some(key => key !== "off") || Object.entries(efforts).some(([key, wire]) => !["off","minimal","low","medium","high","xhigh","max"].includes(key) || typeof wire !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(wire)))) return { index, key: "modelReasoningInvalid" };
      ` + validation);
    source = source.replace('contextWindow: "Context window",', 'modelReasoning: "Supported reasoning levels (JSON; leave empty if unsupported)", modelReasoningInvalid: "Invalid reasoning level map", contextWindow: "Context window",');
    source = source.replace('contextWindow: "上下文窗口",', 'modelReasoning: "支持的推理档位（JSON；不支持请留空）", modelReasoningInvalid: "推理档位映射无效", contextWindow: "上下文窗口",');
  }
  return source.replace('Context compressed', 'Context prepared').replace('上下文已压缩', '上下文整理完成')
    .replace('"harness.compact.pending": "Will compress next request"', '"harness.compact.running": "Compressing context…", "harness.compact.fallback": "Context prepared with a limited extractive summary; original transcript retained", "harness.compact.pending": "Will compress next request"')
    .replace('"harness.compact.pending": "下一次请求前压缩"', '"harness.compact.running": "正在压缩上下文…", "harness.compact.fallback": "摘要服务不可用，已用有限摘录整理；完整对话仍保留", "harness.compact.pending": "下一次请求前压缩"')
    .replace('"harness.goal.start": "Start goal"', '"harness.goal.rounds": "Goal rounds", "harness.goal.start": "Start goal"')
    .replace('"harness.goal.start": "开始目标"', '"harness.goal.rounds": "目标轮次", "harness.goal.start": "开始目标"');
}
