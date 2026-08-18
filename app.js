"use strict";

// Harness Agent — 本地 Web 聊天界面（原生 JS，无框架）。
// 会话模型：gateway 每个 from 自动创建一个会话（find-or-create），
// "新建会话" = 生成新的 from（uuid），gateway 随之创建新会话。

const LS_FROMS = "harness.web.froms";
const LS_ACTIVE = "harness.web.activeFrom";

const state = {
  froms: loadFroms(),
  activeFrom: null,
  es: null,
  running: false,
  connected: false,
  approvals: new Map(), // approvalId -> 卡片元素
};

const $ = (id) => document.getElementById(id);

function loadFroms() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_FROMS) ?? "[]");
    return Array.isArray(raw) ? raw.filter((f) => typeof f === "string") : [];
  } catch {
    return [];
  }
}

function saveFroms() {
  localStorage.setItem(LS_FROMS, JSON.stringify(state.froms));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function postJson(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: data };
  } catch {
    return { ok: false, status: 0, body: { error: "网络错误" } };
  }
}

// --- 会话管理 ----------------------------------------------------------------

async function newSession() {
  const from = crypto.randomUUID();
  const res = await fetch(`/api/bootstrap?from=${encodeURIComponent(from)}`);
  if (!res.ok) {
    systemLine("无法创建会话");
    return;
  }
  const { from: confirmed } = await res.json();
  state.froms.push(confirmed);
  if (state.froms.length > 50) state.froms = state.froms.slice(-50);
  saveFroms();
  await switchSession(confirmed);
}

async function switchSession(from) {
  state.activeFrom = from;
  localStorage.setItem(LS_ACTIVE, from);
  closeEventSource();
  clearMessages();
  setRunning(false);
  connect(from);
  renderSidebar();
  const history = await loadHistory(from);
  renderHistory(history);
}

function closeEventSource() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  setConnected(false);
}

function connect(from) {
  const es = new EventSource(`/api/events?from=${encodeURIComponent(from)}`);
  es.onopen = () => setConnected(true);
  // EventSource 断线自动重连（内建）；onerror 只负责状态显示。
  es.onerror = () => setConnected(false);
  es.onmessage = (e) => {
    try {
      dispatch(JSON.parse(e.data));
    } catch {
      /* 忽略无法解析的帧 */
    }
  };
  state.es = es;
}

function setConnected(ok) {
  state.connected = ok;
  $("conn-dot").className = "dot " + (ok ? "on" : "off");
  $("conn-label").textContent = ok ? "已连接" : "重连中…";
}

// --- 渲染 -------------------------------------------------------------------

function messagesEl() {
  return $("messages");
}

function scrollBottom() {
  const m = messagesEl();
  m.scrollTop = m.scrollHeight;
}

function clearMessages() {
  messagesEl().replaceChildren();
}

function setStatus(text, cls) {
  let node = document.getElementById("status-line");
  if (!node) {
    node = el("div", "line status-line");
    node.id = "status-line";
    messagesEl().appendChild(node);
  }
  node.textContent = text;
  node.className = "line status-line" + (cls ? " " + cls : "");
  scrollBottom();
}

function systemLine(text) {
  const node = el("div", "line system-line", text);
  messagesEl().appendChild(node);
  scrollBottom();
}

function warningLine(text) {
  const node = el("div", "line warning-line", text);
  messagesEl().appendChild(node);
  scrollBottom();
}

function errorLine(text) {
  const node = el("div", "line error-line", text);
  messagesEl().appendChild(node);
  scrollBottom();
}

function verificationLine(text) {
  const node = el("div", "line verification-line", text);
  messagesEl().appendChild(node);
  scrollBottom();
}

function toolLine(text) {
  const node = el("div", "line tool-line", text);
  messagesEl().appendChild(node);
  scrollBottom();
}

function appendUserBubble(text) {
  const wrap = el("div", "bubble-row user-row");
  wrap.appendChild(el("div", "bubble user-bubble", text));
  messagesEl().appendChild(wrap);
  scrollBottom();
}

function appendAssistantText(messageId, text) {
  const wrap = ensureAssistantBubble(messageId);
  const bubble = wrap.lastElementChild;
  if (bubble.dataset.full !== undefined) {
    // 同一消息的后续增量不应重复追加。
    return;
  }
  bubble.textContent = text;
  bubble.dataset.full = "1";
  scrollBottom();
}

function ensureAssistantBubble() {
  const m = messagesEl();
  const last = m.lastElementChild;
  if (last && last.classList.contains("bubble-row") && last.classList.contains("assistant-row")) {
    return last;
  }
  const wrap = el("div", "bubble-row assistant-row");
  wrap.appendChild(el("div", "bubble assistant-bubble"));
  m.appendChild(wrap);
  return wrap;
}

function argSummary(args) {
  if (!args || typeof args !== "object") return "";
  const keys = Object.keys(args).slice(0, 3);
  const parts = keys.map((k) => `${k}=${String(args[k]).slice(0, 60)}`);
  return parts.length > 0 ? ` …${parts.join(", ")}` : "";
}

function showApproval(event) {
  const p = event.payload ?? {};
  const id = p.approvalId;
  if (id === undefined || state.approvals.has(id)) return;
  const card = el("div", "approval-card");
  card.appendChild(el("div", "approval-title", `请求审批：${p.action ?? "tool"}`));
  if (p.target) card.appendChild(el("div", "approval-target", String(p.target)));
  if (p.reason) card.appendChild(el("div", "approval-reason", `原因：${p.reason}`));
  if (p.policyRule) card.appendChild(el("div", "approval-meta", `策略：${p.policyRule}`));
  const buttons = el("div", "approval-actions");
  const allowBtn = el("button", "allow-btn", "允许");
  const denyBtn = el("button", "deny-btn", "拒绝");
  const decide = async (value) => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    card.classList.add("deciding");
    const res = await postJson("/api/commands", { from: state.activeFrom, text: `approve:${id}:${value}` });
    if (!res.ok) {
      card.classList.remove("deciding");
      allowBtn.disabled = false;
      denyBtn.disabled = false;
      errorLine(`审批失败：${res.body?.error ?? "未知错误"}`);
      return;
    }
  };
  allowBtn.addEventListener("click", () => void decide("allow"));
  denyBtn.addEventListener("click", () => void decide("deny"));
  buttons.append(allowBtn, denyBtn);
  card.appendChild(buttons);
  state.approvals.set(id, card);
  messagesEl().appendChild(card);
  scrollBottom();
}

function resolveApproval(id, value) {
  const card = state.approvals.get(id);
  if (!card) return;
  const label = value === "allow" ? "已允许" : value === "deny" ? "已拒绝" : String(value);
  card.classList.add("resolved");
  const note = el("div", "approval-result", label);
  card.appendChild(note);
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  setTimeout(() => {
    card.remove();
    state.approvals.delete(id);
  }, 1200);
}

function setRunning(running) {
  state.running = running;
  $("cancel-btn").disabled = !running;
}

function errorText(err) {
  if (err && typeof err === "object") {
    return [err.code, err.message].filter(Boolean).join(": ");
  }
  return String(err ?? "未知错误");
}

// --- 事件分发 ----------------------------------------------------------------

function dispatch(frame) {
  switch (frame.type) {
    case "hello":
      break;
    case "text":
      handleGatewayText(frame.text);
      break;
    case "assistant_text":
      appendAssistantText(frame.messageId, frame.text);
      break;
    case "event":
      handleAgentEvent(frame.event);
      break;
    default:
      break;
  }
}

function handleGatewayText(text) {
  if (typeof text !== "string") return;
  // [approval]/[permission] 与审批卡片重复，不再重复渲染。
  if (text.startsWith("[approval]") || text.startsWith("[permission]")) return;
  systemLine(text);
}

function handleAgentEvent(ev) {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case "turn.started":
      setRunning(true);
      setStatus("运行中…", "running");
      break;
    case "turn.completed":
      setRunning(false);
      setStatus(`完成（turn ${p.turnId}）`);
      break;
    case "turn.cancelled":
      setRunning(false);
      setStatus("已取消");
      break;
    case "turn.failed":
      setRunning(false);
      errorLine(`回合失败：${errorText(p.error)}`);
      break;
    case "model.started":
      setStatus("模型思考中…");
      break;
    case "model.delta":
      if (p.kind === "tool_call") setStatus(`正在调用工具 ${p.name}…`);
      break;
    case "model.completed":
      setStatus(`模型响应完成（${p.finishReason}）`);
      break;
    case "model.failed":
      errorLine(`模型错误：${errorText(p.error)}`);
      break;
    case "text_delta":
      // 事件流不含模型文本增量（runtime 只落库完整消息，见 server.ts 注释）；
      // 此分支防御性处理，正常路径由 assistant_text 帧驱动。
      if (typeof p.text === "string") {
        const wrap = ensureAssistantBubble();
        wrap.lastElementChild.textContent += p.text;
        scrollBottom();
      }
      break;
    case "tool.requested":
      setStatus(`请求调用工具 ${p.name}${argSummary(p.args)}…`);
      break;
    case "tool.permission_requested":
      setStatus("等待审批…");
      break;
    case "approval.created":
      showApproval(ev);
      break;
    case "approval.resolved":
      resolveApproval(p.approvalId, p.value);
      break;
    case "tool.permission_resolved":
      if (typeof p.approvalId === "string") resolveApproval(p.approvalId, p.effect);
      break;
    case "tool.started":
      setStatus(`执行工具 ${p.tool}…`);
      break;
    case "tool.output":
      toolLine(`${p.stream === "stderr" ? "stderr" : "stdout"} | ${String(p.text ?? "")}`);
      break;
    case "tool.completed":
      setStatus(`工具 ${p.tool} 完成（${p.durationMs ?? 0}ms）`);
      break;
    case "tool.failed":
      errorLine(`工具 ${p.tool ?? "?"} 失败：${errorText(p.error)}`);
      break;
    case "verification.started":
      setStatus("验证中…");
      break;
    case "verification.completed":
      verificationLine("验证通过");
      break;
    case "verification.failed":
      verificationLine(`验证失败：${String(p.error ?? "未知原因")}`);
      break;
    case "human.approval":
      systemLine(`审批 ${p.approvalId}：${p.value}`);
      break;
    case "human.cancel":
      systemLine("已请求取消");
      break;
    case "run.limit_reached":
      warningLine(`达到限制 ${p.limit}：${p.used}`);
      break;
    default:
      break;
  }
}

// --- 历史记录 ----------------------------------------------------------------

async function loadHistory(from) {
  try {
    const res = await fetch(`/api/history?from=${encodeURIComponent(from)}`);
    if (!res.ok) return { sessionId: null, messages: [] };
    return await res.json();
  } catch {
    return { sessionId: null, messages: [] };
  }
}

function renderHistory(history) {
  for (const m of history.messages ?? []) {
    if (m.role === "user") appendUserBubble(m.content);
    else if (m.role === "assistant") appendAssistantText(m.id, m.content);
    else if (m.role === "tool") toolLine(String(m.content).slice(0, 300));
  }
}

// --- 侧栏 --------------------------------------------------------------------

function renderSidebar() {
  const list = $("session-list");
  list.replaceChildren();
  for (const from of state.froms) {
    const li = el("li", "session-item" + (from === state.activeFrom ? " active" : ""));
    li.dataset.from = from;
    li.textContent = from.slice(0, 8) + "…";
    li.title = from;
    li.addEventListener("click", () => void switchSession(from));
    list.appendChild(li);
  }
  void enrichSidebar();
}

async function enrichSidebar() {
  let sessions = [];
  try {
    const res = await fetch("/api/sessions");
    if (res.ok) sessions = (await res.json()).sessions ?? [];
  } catch {
    return;
  }
  const byFrom = new Map(sessions.map((s) => [s.from, s]));
  for (const item of $("session-list").children) {
    const info = byFrom.get(item.dataset.from);
    if (info) {
      const label = info.firstText ? info.firstText.slice(0, 14) : "（空会话）";
      item.textContent = label.length > 14 ? label.slice(0, 14) + "…" : label;
      item.title = `${item.dataset.from} — 会话 ${info.sessionId}`;
    }
  }
}

// --- 交互 --------------------------------------------------------------------

async function sendMessage() {
  const input = $("input");
  const text = input.value.trim();
  if (!text || !state.activeFrom) return;
  appendUserBubble(text);
  input.value = "";
  input.style.height = "";
  const res = await postJson("/api/messages", { from: state.activeFrom, text });
  if (!res.ok) errorLine(`发送失败：${res.body?.error ?? "未知错误"}`);
}

async function cancel() {
  if (!state.activeFrom) return;
  const res = await postJson("/api/commands", { from: state.activeFrom, text: "cancel" });
  if (!res.ok) errorLine(`取消失败：${res.body?.error ?? "未知错误"}`);
}

async function init() {
  $("new-session-btn").addEventListener("click", () => void newSession());
  $("send-btn").addEventListener("click", () => void sendMessage());
  $("cancel-btn").addEventListener("click", () => void cancel());
  const input = $("input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  $("conn-dot").className = "dot off";

  if (state.froms.length === 0) {
    await newSession();
    return;
  }
  const saved = localStorage.getItem(LS_ACTIVE);
  const active = state.froms.includes(saved) ? saved : state.froms[state.froms.length - 1];
  await switchSession(active);
}

void init();