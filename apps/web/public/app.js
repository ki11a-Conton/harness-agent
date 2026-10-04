"use strict";

const LS_FROMS = "harness.web.froms";
const LS_ACTIVE = "harness.web.activeFrom";
const LS_TITLES = "harness.web.titles";
const LS_DRAFTS = "harness.web.drafts";
const LS_THEME = "harness.web.theme";
const LS_SIDEBAR = "harness.web.sidebarCollapsed";
const FROM_RE = /^[A-Za-z0-9-]{8,64}$/;
const $ = (id) => document.getElementById(id);
const state = {
  froms: loadFroms(),
  titles: loadRecord(LS_TITLES),
  drafts: loadRecord(LS_DRAFTS),
  pendingPosts: new Map(),
  activeFrom: null,
  view: null,
  generation: 0,
  navigation: 0,
  sidebarGeneration: 0,
  bootstrapController: null,
};

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* The active view still works if storage is unavailable. */ }
}
function loadFroms() {
  try {
    const raw = JSON.parse(storageGet(LS_FROMS) ?? "[]");
    return Array.isArray(raw) ? [...new Set(raw.filter((from) => typeof from === "string" && FROM_RE.test(from)))].slice(-50) : [];
  } catch { return []; }
}
function loadRecord(key) {
  try {
    const raw = JSON.parse(storageGet(key) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? new Map(Object.entries(raw).filter(([from, value]) => FROM_RE.test(from) && typeof value === "string"))
      : new Map();
  } catch { return new Map(); }
}
function saveRecord(key, record) {
  storageSet(key, JSON.stringify(Object.fromEntries([...record].filter(([from]) => state.froms.includes(from)))));
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function isCurrent(view) {
  return state.view === view && state.activeFrom === view.from && state.generation === view.generation && !view.controller.signal.aborted;
}
async function postJson(path, body, view) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: view.controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: data };
  } catch (error) {
    return { ok: false, status: 0, body: { error: error?.name === "AbortError" ? "请求已取消" : "网络错误" } };
  }
}
function saveDraft(from, text) {
  if (!from) return;
  if (text) state.drafts.set(from, text);
  else state.drafts.delete(from);
  saveRecord(LS_DRAFTS, state.drafts);
}
function setSessionTitle(from, text) {
  if (state.titles.has(from) || !text.trim()) return;
  state.titles.set(from, text.trim().replace(/\s+/g, " ").slice(0, 48));
  saveRecord(LS_TITLES, state.titles);
  if (state.activeFrom === from) $("session-title").textContent = state.titles.get(from);
  renderSidebar();
}

// Each navigation owns its requests, stream, message ids and approvals.
async function newSession() {
  const navigation = ++state.navigation;
  state.bootstrapController?.abort();
  const controller = new AbortController();
  state.bootstrapController = controller;
  const from = crypto.randomUUID();
  $("new-session-btn").disabled = true;
  try {
    const res = await fetch(`/api/bootstrap?from=${encodeURIComponent(from)}`, { signal: controller.signal });
    const data = await res.json();
    if (navigation !== state.navigation || controller.signal.aborted) return;
    if (!res.ok || typeof data.from !== "string" || !FROM_RE.test(data.from)) throw new Error("无法创建会话");
    if (!state.froms.includes(data.from)) state.froms.push(data.from);
    state.froms = state.froms.slice(-50);
    storageSet(LS_FROMS, JSON.stringify(state.froms));
    await switchSession(data.from);
  } catch (error) {
    if (navigation === state.navigation && !controller.signal.aborted) errorLine(`创建失败：${error?.message ?? "网络错误"}`);
  } finally {
    if (state.bootstrapController === controller) {
      state.bootstrapController = null;
      $("new-session-btn").disabled = false;
    }
  }
}
async function switchSession(from) {
  if (!FROM_RE.test(from)) return;
  ++state.navigation;
  state.bootstrapController?.abort();
  state.bootstrapController = null;
  $("new-session-btn").disabled = false;
  if (state.view) {
    saveDraft(state.view.from, $("input").value);
    state.view.es?.close();
    state.view.controller.abort();
    clearInterval(state.view.approvalTimer);
    state.view.approvals.clear();
    state.view.buffer.length = 0;
  }
  const view = {
    from,
    generation: ++state.generation,
    controller: new AbortController(),
    es: null,
    running: false,
    connected: false,
    historyLoading: true,
    historyRequestStarted: false,
    historyFetching: false,
    historyRefreshAgain: false,
    handshakeTimedOut: false,
    helloCount: 0,
    buffer: [],
    assistantMessages: new Map(),
    messageIds: new Set(),
    optimisticUsers: [],
    lastSequence: -1,
    eventIds: new Set(),
    approvals: new Map(),
    resolvedApprovals: new Map(),
    approvalTimer: null,
    cancelPending: false,
  };
  state.view = view;
  state.activeFrom = from;
  storageSet(LS_ACTIVE, from);
  $("message-list").replaceChildren();
  $("empty-state").hidden = false;
  $("messages").setAttribute("aria-busy", "true");
  $("input").value = state.drafts.get(from) ?? "";
  resizeInput();
  $("session-title").textContent = state.titles.get(from) ?? "新会话";
  $("session-meta").textContent = "";
  $("agent-status").textContent = "加载会话…";
  setRunning(false, view);
  setConnected(false, view);
  renderSidebar();
  if (matchMedia("(max-width: 760px)").matches) setSidebar(true);
  const ready = connect(view);
  view.approvalTimer = setInterval(() => {
    if (!isCurrent(view)) return;
    for (const [id, entry] of view.approvals) {
      if (!entry.resolved && isExpired(entry.expiresAt)) resolveApproval(id, "expired", view);
    }
  }, 1000);
  if (await ready) await loadHistoryForView(view);
  else if (isCurrent(view) && !view.historyRequestStarted) {
    $("messages").setAttribute("aria-busy", "false");
    $("agent-status").textContent = "等待连接就绪…";
    warningLine("连接尚未就绪，正在等待重连。会话连接完成后自动加载历史。");
  }
}
async function loadHistoryForView(view) {
  if (!isCurrent(view)) return;
  if (view.historyFetching) { view.historyRefreshAgain = true; return; }
  view.historyFetching = true;
  view.historyRequestStarted = true;
  view.historyLoading = true;
  $("messages").setAttribute("aria-busy", "true");
  updateControls(view);
  try {
    const res = await fetch(`/api/history?from=${encodeURIComponent(view.from)}`, { signal: view.controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const history = await res.json();
    if (isCurrent(view)) renderHistory(history, view);
  } catch (error) {
    if (isCurrent(view)) warningLine(`历史加载失败：${error?.message ?? "网络错误"}。可切换会话后重试。`);
  } finally {
    view.historyFetching = false;
    if (isCurrent(view)) {
      view.historyLoading = false;
      $("messages").setAttribute("aria-busy", "false");
      $("agent-status").textContent = "就绪";
      const frames = view.buffer.splice(0);
      for (const frame of frames) dispatch(frame, view);
      updateControls(view);
      if (view.historyRefreshAgain) {
        view.historyRefreshAgain = false;
        void loadHistoryForView(view);
      }
    }
  }
}
function connect(view) {
  const es = new EventSource(`/api/events?from=${encodeURIComponent(view.from)}`);
  view.es = es;
  let settleReady;
  const ready = new Promise((resolve) => {
    let settled = false;
    const abort = () => settleReady(false);
    const timer = setTimeout(() => {
      view.handshakeTimedOut = true;
      settleReady(false);
    }, 10000);
    settleReady = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      view.controller.signal.removeEventListener("abort", abort);
      resolve(value);
    };
    view.controller.signal.addEventListener("abort", abort, { once: true });
  });
  es.onopen = () => { if (isCurrent(view) && view.es === es) setConnected(true, view); };
  es.onerror = () => { if (isCurrent(view) && view.es === es) setConnected(false, view); };
  es.onmessage = (event) => {
    if (!isCurrent(view) || view.es !== es) return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (!frame || typeof frame !== "object") return;
    // The server seeds its assistant cursor before hello. Loading history
    // after this frame closes the gap between that seed and the snapshot.
    if (frame.type === "hello") {
      view.helloCount += 1;
      settleReady(true);
      if (view.helloCount > 1 || view.handshakeTimedOut) void loadHistoryForView(view);
      return;
    }
    if (view.historyLoading) view.buffer.push(frame);
    else dispatch(frame, view);
  };
  return ready;
}
function setConnected(connected, view) {
  if (!isCurrent(view)) return;
  view.connected = connected;
  $("conn-dot").className = `dot ${connected ? "on" : "off"}`;
  $("conn-label").textContent = connected ? "已连接" : "重连中…";
}
function setRunning(running, view) {
  if (!isCurrent(view)) return;
  view.running = running;
  $("agent-status").classList.toggle("running", running);
  updateControls(view);
}
function updateControls(view = state.view) {
  if (!view || !isCurrent(view)) return;
  $("send-btn").disabled = view.historyLoading || state.pendingPosts.has(view.from) || !$("input").value.trim();
  $("cancel-btn").disabled = !view.running || view.cancelPending;
}
function resizeInput() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 52), 180)}px`;
}
function appendNode(node) {
  $("empty-state").hidden = true;
  $("message-list").appendChild(node);
  scrollBottom();
}
function scrollBottom() {
  const messages = $("messages");
  messages.scrollTop = messages.scrollHeight;
}
function setStatus(text, className = "", view = state.view) {
  if (!view || !isCurrent(view)) return;
  let node = $("status-line");
  if (!node) { node = el("div", "line status-line"); node.id = "status-line"; appendNode(node); }
  node.textContent = text;
  node.className = `line status-line${className ? ` ${className}` : ""}`;
  $("agent-status").textContent = text;
  scrollBottom();
}
function systemLine(text) { appendNode(el("div", "line system-line", text)); }
function warningLine(text) { appendNode(el("div", "line warning-line", text)); }
function errorLine(text) { appendNode(el("div", "line error-line", text)); }
function toolLine(text) { appendNode(el("div", "line tool-line", text)); }
function verificationLine(text, outcome) { appendNode(el("div", `line verification-line${outcome ? ` ${outcome}` : ""}`, text)); }
function appendUserBubble(text, messageId, view = state.view) {
  if (!view || !isCurrent(view)) return null;
  if (typeof messageId === "string" && view.messageIds.has(messageId)) return null;
  if (typeof messageId === "string") {
    view.messageIds.add(messageId);
    const pendingIndex = view.optimisticUsers.findIndex((pending) => pending.text === String(text));
    if (pendingIndex >= 0) {
      const [pending] = view.optimisticUsers.splice(pendingIndex, 1);
      pending.row.dataset.messageId = messageId;
      return pending.row;
    }
  }
  const wrap = el("div", "bubble-row user-row");
  wrap.appendChild(el("div", "bubble user-bubble", text));
  appendNode(wrap);
  setSessionTitle(view.from, String(text));
  return wrap;
}
function copyButton(label, getText, view) {
  const button = el("button", "copy-button", label);
  button.type = "button";
  button.addEventListener("click", async () => {
    if (!isCurrent(view)) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(getText());
      if (isCurrent(view)) button.textContent = "已复制";
    } catch {
      if (isCurrent(view)) button.textContent = "复制失败";
    }
  });
  return button;
}
// Only fenced code is formatted. Model and tool text never become HTML.
function renderAssistantContent(node, text, view) {
  node.replaceChildren();
  const source = String(text);
  const fence = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*(?=\n|$)/gm;
  let cursor = 0;
  for (const match of source.matchAll(fence)) {
    if (match.index > cursor) node.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const code = match[2];
    const block = el("div", "code-block");
    const banner = el("div", "code-banner");
    banner.append(el("span", "code-language", match[1].trim() || "代码"), copyButton("复制代码", () => code, view));
    const pre = el("pre");
    pre.appendChild(el("code", "", code));
    block.append(banner, pre);
    node.appendChild(block);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) node.appendChild(document.createTextNode(source.slice(cursor)));
}
function ensureAssistantBubble(messageId, view) {
  const key = typeof messageId === "string" && messageId ? messageId : `unidentified:${crypto.randomUUID()}`;
  const existing = view.assistantMessages.get(key);
  if (existing) return existing;
  const wrap = el("div", "bubble-row assistant-row");
  if (typeof messageId === "string") wrap.dataset.messageId = messageId;
  const heading = el("div", "assistant-heading");
  heading.append(el("span", "assistant-mark", "h"), el("span", "", "Harness"));
  const bubble = el("div", "bubble assistant-bubble");
  const entry = { wrap, bubble, text: "", full: false };
  const actions = el("div", "message-actions");
  actions.appendChild(copyButton("复制回复", () => entry.text, view));
  wrap.append(heading, bubble, actions);
  view.assistantMessages.set(key, entry);
  appendNode(wrap);
  return entry;
}
function appendAssistantText(messageId, text, view) {
  if (!isCurrent(view)) return;
  // Tool-call assistant records may have no text. Their tool/approval events
  // remain visible, but an empty history record must not create a reply bubble.
  if (String(text ?? "") === "") return;
  const entry = ensureAssistantBubble(messageId, view);
  if (entry.full) return;
  entry.text = String(text ?? "");
  entry.full = true;
  renderAssistantContent(entry.bubble, entry.text, view);
  if (typeof messageId === "string") view.messageIds.add(messageId);
  scrollBottom();
}
function argSummary(args) {
  if (!args || typeof args !== "object") return "";
  const parts = Object.keys(args).slice(0, 3).map((key) => `${key}=${String(args[key]).slice(0, 60)}`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}
function isExpired(expiresAt) { return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= Date.now(); }
function approvalLabel(value) {
  return value === "allow" ? "已允许" : value === "deny" ? "已拒绝" : value === "expired" ? "审批已过期" : value === "historical" ? "历史审批 · 当前无待处理请求" : String(value ?? "已结束");
}
function showApproval(event, view) {
  const payload = event.payload ?? {};
  const id = payload.approvalId;
  if (typeof id !== "string" || !id || view.approvals.has(id)) return;
  const card = el("div", "approval-card");
  card.dataset.approvalId = id;
  card.appendChild(el("div", "approval-title", `需要审批 · ${payload.action ?? "工具执行"}`));
  if (payload.target) card.appendChild(el("div", "approval-target", payload.target));
  if (payload.reason) card.appendChild(el("div", "approval-reason", `原因：${payload.reason}`));
  if (payload.policyRule) card.appendChild(el("div", "approval-meta", `策略：${payload.policyRule}`));
  const actions = el("div", "approval-actions");
  const allow = el("button", "allow-btn", "允许执行");
  const deny = el("button", "deny-btn", "拒绝");
  const entry = { card, allow, deny, ownerFrom: view.from, generation: view.generation, expiresAt: payload.expiresAt, resolved: false, deciding: false };
  const decide = async (value) => {
    if (!isCurrent(view) || entry.generation !== view.generation || entry.resolved || entry.deciding) return;
    if (isExpired(entry.expiresAt)) { resolveApproval(id, "expired", view); return; }
    entry.deciding = true;
    allow.disabled = deny.disabled = true;
    card.classList.add("deciding");
    const res = await postJson("/api/commands", { from: entry.ownerFrom, text: `approve:${id}:${value}` }, view);
    if (!isCurrent(view) || entry.resolved) return;
    if (!res.ok) {
      entry.deciding = false;
      card.classList.remove("deciding");
      allow.disabled = deny.disabled = false;
      errorLine(`审批失败：${res.body?.error ?? "未知错误"}`);
    }
  };
  allow.addEventListener("click", () => void decide("allow"));
  deny.addEventListener("click", () => void decide("deny"));
  actions.append(allow, deny);
  card.appendChild(actions);
  view.approvals.set(id, entry);
  appendNode(card);
  const previous = view.resolvedApprovals.get(id);
  if (previous !== undefined) resolveApproval(id, previous, view);
  else if (payload.pending === false) resolveApproval(id, "historical", view);
  else if (isExpired(entry.expiresAt)) resolveApproval(id, "expired", view);
}
function resolveApproval(id, value, view) {
  if (typeof id !== "string" || !isCurrent(view)) return;
  const previous = view.resolvedApprovals.get(id);
  if (previous === undefined || previous === "historical" || previous === "expired") view.resolvedApprovals.set(id, value);
  const entry = view.approvals.get(id);
  if (!entry) return;
  if (entry.resolved) {
    entry.card.querySelector(".approval-result").textContent = approvalLabel(view.resolvedApprovals.get(id));
    return;
  }
  entry.resolved = true;
  entry.card.classList.remove("deciding");
  entry.card.classList.add("resolved");
  entry.allow.disabled = entry.deny.disabled = true;
  entry.card.appendChild(el("div", "approval-result", approvalLabel(view.resolvedApprovals.get(id))));
}
function errorText(error) {
  if (error && typeof error === "object") return [error.code, error.message].filter(Boolean).join(": ") || JSON.stringify(error);
  return String(error ?? "未知错误");
}
function dispatch(frame, view) {
  if (!isCurrent(view)) return;
  switch (frame.type) {
    case "hello": break;
    case "text": handleGatewayText(frame.text); break;
    case "assistant_text": appendAssistantText(frame.messageId, frame.text, view); break;
    case "event": {
      const event = frame.event;
      if (!event || typeof event !== "object") return;
      if (Number.isSafeInteger(event.sequence) && event.sequence >= 0) {
        if (event.sequence <= view.lastSequence) return;
        view.lastSequence = event.sequence;
      } else if (typeof event.id === "string") {
        if (view.eventIds.has(event.id)) return;
        view.eventIds.add(event.id);
      }
      handleAgentEvent(event, view);
      break;
    }
    default: break;
  }
}
function handleGatewayText(text) {
  if (typeof text !== "string") return;
  if (text.startsWith("[approval]") || text.startsWith("[permission]")) return;
  if (text.startsWith("[error]")) errorLine(text.slice(7).trim());
  else if (text.startsWith("[queued]")) systemLine("后续消息已加入队列，将在当前任务结束后处理。");
  else systemLine(text);
}
function handleAgentEvent(event, view) {
  const payload = event.payload ?? {};
  switch (event.type) {
    case "turn.started": setRunning(true, view); setStatus("正在执行任务…", "running", view); break;
    case "turn.completed": setRunning(false, view); setStatus("任务已完成", "", view); break;
    case "turn.cancelled": setRunning(false, view); setStatus("任务已取消", "", view); break;
    case "turn.failed": setRunning(false, view); setStatus("任务失败", "", view); errorLine(`任务失败：${errorText(payload.error)}`); break;
    case "model.started": setStatus("正在思考…", "running", view); break;
    case "model.delta": if (payload.kind === "tool_call") setStatus(`准备调用 ${payload.name ?? "工具"}…`, "running", view); break;
    case "model.completed": setStatus("模型响应已完成", "", view); break;
    case "model.failed": errorLine(`模型错误：${errorText(payload.error)}`); break;
    case "text_delta": {
      if (typeof payload.text === "string" && typeof payload.messageId === "string") {
        const entry = ensureAssistantBubble(payload.messageId, view);
        if (!entry.full) { entry.text += payload.text; entry.bubble.textContent = entry.text; scrollBottom(); }
      }
      break;
    }
    case "tool.requested": setStatus(`请求工具 ${payload.name ?? ""}${argSummary(payload.args)}`, "running", view); break;
    case "tool.permission_requested": setStatus("等待你的审批…", "", view); break;
    case "approval.created": showApproval(event, view); break;
    case "approval.resolved": resolveApproval(payload.approvalId, payload.value, view); break;
    case "tool.permission_resolved": resolveApproval(payload.approvalId, payload.effect, view); break;
    case "tool.started": setStatus(`正在执行 ${payload.tool ?? "工具"}…`, "running", view); break;
    case "tool.output": toolLine(`${payload.stream === "stderr" ? "stderr" : "stdout"} | ${String(payload.text ?? "")}`); break;
    case "tool.completed": setStatus(`${payload.tool ?? "工具"} 已完成 · ${payload.durationMs ?? 0} ms`, "", view); break;
    case "tool.failed": errorLine(`工具 ${payload.tool ?? "?"} 失败：${errorText(payload.error)}`); break;
    case "verification.started": setStatus("正在验收…", "running", view); break;
    case "verification.completed": {
      if (payload.passed === true) verificationLine("验收通过");
      else if (payload.passed === false) verificationLine("验收未通过", "failed");
      else verificationLine("验收已完成 · 未提供通过状态", "unknown");
      break;
    }
    case "verification.failed": verificationLine(`验收失败：${errorText(payload.error)}`, "failed"); break;
    case "human.approval": resolveApproval(payload.approvalId, payload.value, view); systemLine(`审批结果：${approvalLabel(payload.value)}`); break;
    case "human.cancel": systemLine("已请求停止任务"); break;
    case "run.limit_reached": warningLine(`达到运行限制 ${payload.limit ?? ""}：${payload.used ?? ""}`); break;
    default: break;
  }
}
function renderHistory(history, view) {
  if (!isCurrent(view) || !history || typeof history !== "object") return;
  if (typeof history.sessionId === "string") $("session-meta").textContent = `会话 ${history.sessionId.slice(0, 8)}`;
  for (const message of Array.isArray(history.messages) ? history.messages : []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") appendUserBubble(message.content, message.id, view);
    else if (message.role === "assistant") appendAssistantText(message.id, message.content, view);
    else if (message.role === "tool") {
      if (typeof message.id === "string" && view.messageIds.has(message.id)) continue;
      if (typeof message.id === "string") view.messageIds.add(message.id);
      toolLine(String(message.content ?? ""));
    }
  }
}
function sessionIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z");
  svg.appendChild(path);
  return svg;
}
function renderSidebar() {
  const list = $("session-list");
  list.replaceChildren();
  $("session-count").textContent = state.froms.length;
  for (const from of [...state.froms].reverse()) {
    const item = el("li", `session-item${from === state.activeFrom ? " active" : ""}`);
    item.dataset.from = from;
    const button = el("button", "session-button");
    button.type = "button";
    button.title = `${state.titles.get(from) ?? "新会话"} · ${from}`;
    if (from === state.activeFrom) button.setAttribute("aria-current", "true");
    button.append(sessionIcon(), el("span", "session-name", state.titles.get(from) ?? "新会话"));
    button.addEventListener("click", () => void switchSession(from));
    item.appendChild(button);
    list.appendChild(item);
  }
  void enrichSidebar(++state.sidebarGeneration);
}
async function enrichSidebar(generation) {
  try {
    const view = state.view;
    const res = await fetch("/api/sessions", view ? { signal: view.controller.signal } : undefined);
    if (!res.ok) return;
    const data = await res.json();
    if (generation !== state.sidebarGeneration) return;
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const byFrom = new Map(sessions.filter((session) => session && typeof session.from === "string").map((session) => [session.from, session]));
    for (const item of $("session-list").children) {
      const info = byFrom.get(item.dataset.from);
      if (!info || typeof info.firstText !== "string" || !info.firstText.trim()) continue;
      const title = info.firstText.trim().replace(/\s+/g, " ").slice(0, 48);
      state.titles.set(item.dataset.from, title);
      item.querySelector(".session-name").textContent = title;
      item.querySelector("button").title = `${title} · ${item.dataset.from}`;
      if (state.activeFrom === item.dataset.from) $("session-title").textContent = title;
    }
    saveRecord(LS_TITLES, state.titles);
  } catch { /* Switching aborts the old listing request; local titles remain available. */ }
}
async function sendMessage() {
  const view = state.view;
  const input = $("input");
  const text = input.value.trim();
  if (!view || !isCurrent(view) || !text || view.historyLoading || state.pendingPosts.has(view.from)) return;
  const token = {};
  state.pendingPosts.set(view.from, token);
  const row = appendUserBubble(text, undefined, view);
  const optimistic = { row, text };
  view.optimisticUsers.push(optimistic);
  input.value = "";
  saveDraft(view.from, "");
  resizeInput();
  updateControls(view);
  try {
    const res = await postJson("/api/messages", { from: view.from, text }, view);
    if (!isCurrent(view)) return;
    if (!res.ok) {
      const optimisticIndex = view.optimisticUsers.indexOf(optimistic);
      if (optimisticIndex >= 0) view.optimisticUsers.splice(optimisticIndex, 1);
      errorLine(`发送失败：${res.body?.error ?? "未知错误"}`);
      if (!input.value) { input.value = text; saveDraft(view.from, text); resizeInput(); }
      const retry = el("button", "copy-button", "重新编辑");
      retry.addEventListener("click", () => {
        if (!isCurrent(view)) return;
        input.value = text;
        saveDraft(view.from, text);
        resizeInput();
        updateControls(view);
        input.focus();
      });
      row?.appendChild(retry);
    }
  } finally {
    if (state.pendingPosts.get(view.from) === token) state.pendingPosts.delete(view.from);
    if (state.view?.from === view.from) updateControls(state.view);
  }
}
async function cancel() {
  const view = state.view;
  if (!view || !isCurrent(view) || !view.running || view.cancelPending) return;
  view.cancelPending = true;
  updateControls(view);
  try {
    const res = await postJson("/api/commands", { from: view.from, text: "cancel" }, view);
    if (isCurrent(view) && !res.ok) errorLine(`停止失败：${res.body?.error ?? "未知错误"}`);
  } finally {
    if (isCurrent(view)) { view.cancelPending = false; updateControls(view); }
  }
}
function setSidebar(collapsed, persist = false) {
  $("app").classList.toggle("sidebar-collapsed", collapsed);
  $("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  $("sidebar-toggle").setAttribute("aria-label", collapsed ? "展开会话侧栏" : "收起会话侧栏");
  if (persist && !matchMedia("(max-width: 760px)").matches) storageSet(LS_SIDEBAR, String(collapsed));
}
function setTheme(theme) {
  const dark = theme === "dark";
  document.body.toggleAttribute("data-ds-dark-theme", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  const label = dark ? "切换为浅色主题" : "切换为深色主题";
  $("theme-toggle").setAttribute("aria-label", label);
  $("theme-toggle").title = label;
  storageSet(LS_THEME, theme);
}
async function init() {
  setTheme(storageGet(LS_THEME) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  setSidebar(matchMedia("(max-width: 760px)").matches || storageGet(LS_SIDEBAR) === "true");
  $("theme-toggle").addEventListener("click", () => setTheme(document.body.hasAttribute("data-ds-dark-theme") ? "light" : "dark"));
  $("sidebar-toggle").addEventListener("click", () => setSidebar(!$("app").classList.contains("sidebar-collapsed"), true));
  $("sidebar-close").addEventListener("click", () => setSidebar(true, true));
  $("sidebar-backdrop").addEventListener("click", () => setSidebar(true));
  matchMedia("(max-width: 760px)").addEventListener("change", (event) => setSidebar(event.matches || storageGet(LS_SIDEBAR) === "true"));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && matchMedia("(max-width: 760px)").matches) setSidebar(true); });
  $("new-session-btn").addEventListener("click", () => void newSession());
  $("send-btn").addEventListener("click", () => void sendMessage());
  $("cancel-btn").addEventListener("click", () => void cancel());
  const input = $("input");
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
      event.preventDefault();
      void sendMessage();
    }
  });
  input.addEventListener("input", () => { saveDraft(state.activeFrom, input.value); resizeInput(); updateControls(); });
  if (!state.froms.length) { await newSession(); return; }
  const saved = storageGet(LS_ACTIVE);
  await switchSession(state.froms.includes(saved) ? saved : state.froms[state.froms.length - 1]);
}
void init();
