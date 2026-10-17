/* First-party Harness coding record panel; all actions use existing authorized remotes. */
(() => {
  const host = document.createElement('div'); host.dataset.harnessCoding = 'panel';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{font:14px system-ui;color:#e2e8f0}button,select,textarea{font:inherit}button{cursor:pointer;padding:7px 12px;border:1px solid #64748b;border-radius:8px;background:#1e293b;color:inherit}button:disabled{opacity:.5;cursor:default}
    #launch{position:fixed;right:16px;bottom:62px;z-index:45;background:#0f172a}dialog{box-sizing:border-box;color:inherit;background:#0f172a;border:1px solid #64748b;border-radius:14px;width:min(720px,calc(100vw - 40px));max-height:80vh;padding:20px}dialog::backdrop{background:#0007}header{position:sticky;top:0;background:#0f172a;z-index:1;display:flex;justify-content:space-between;align-items:center}select,textarea{box-sizing:border-box;width:100%;background:#1e293b;color:inherit;border:1px solid #64748b;border-radius:6px;padding:8px;margin:8px 0}textarea{min-height:65px}p{white-space:pre-wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#172033;padding:10px;border-radius:6px;max-height:240px;overflow:auto}a{color:#93c5fd}li{margin:5px 0}.actions{display:flex;gap:8px;flex-wrap:wrap}#error{color:#fca5a5}small{color:#cbd5e1}
    </style><button id="launch" aria-label="打开编码状态">编码状态</button><dialog aria-label="Harness 编码状态"><header><strong>Harness 编码状态</strong><button id="close">关闭</button></header><label>选择会话<select id="session"></select></label><p id="state">尚未读取</p><small>验收状态来自后端验证记录；命令退出 0 不等同于任务验收通过。</small><ol id="plan"></ol><h3>实际命令</h3><div id="commands"></div><h3>编辑记录</h3><ul id="files"></ul><small>VS Code 链接用于与服务端共享路径的本机编辑器。</small><div class="actions"><button id="refresh">刷新记录</button><button id="diff">查看最新差异</button><button id="cancel">请求停止</button></div><pre id="changes" hidden></pre><label>继续或纠正当前任务<textarea id="prompt" placeholder="说明下一步或当前纠正"></textarea></label><button id="continue">发送给此会话</button><button id="retry" hidden>重试同一请求</button><p id="notice" role="status"></p><p id="error" role="alert"></p></dialog>`;
  document.body.append(host);
  const $ = id => root.getElementById(id), dialog = root.querySelector('dialog');
  // The upstream shortcut dispatcher observes the document, outside this shadow
  // root. Keep modal keystrokes local; native Tab/Escape behavior still applies.
  dialog.addEventListener('keydown', event => event.stopPropagation());
  let generation = 0, current, timer, loading, sending = false, draftOwner, diffRequest = 0;
  const pending = new Map(), drafts = new Map(), submittedDrafts = new Map();
  const statusLabels = { idle: '未开始', running: '运行中', completed: '任务已结束', failed: '任务失败', cancelled: '已取消', waiting: '等待用户回答' };
  const verifyLabels = { unrun: '未运行验收', passed: '后端验收通过', failed: '后端验收失败' };
  const english = () => !document.documentElement.lang.toLowerCase().startsWith('zh');
  const words = (zh, en) => english() ? en : zh;
  function saveDraft() { if (draftOwner) drafts.set(draftOwner, $('prompt').value); }
  function selectDraft(id) { saveDraft(); draftOwner = id; $('prompt').value = drafts.get(id) ?? ''; }
  function clearSubmittedDraft(id) {
    const original = submittedDrafts.get(id);
    if (drafts.get(id) === original) drafts.delete(id);
    if (draftOwner === id && $('prompt').value === original) $('prompt').value = '';
    submittedDrafts.delete(id);
  }
  function selected(version, id) { return dialog.open && generation === version && $('session').value === id; }
  function controls() {
    const id = $('session').value, ready = dialog.open && current?.sessionId === id;
    $('session').disabled = sending;
    $('prompt').disabled = !id || sending || pending.get(id)?.uncertain === true;
    $('continue').disabled = !ready || sending || current.status === 'waiting' || pending.get(id)?.uncertain === true || !$('prompt').value.trim();
    $('retry').hidden = !pending.get(id)?.uncertain; $('retry').disabled = sending;
    $('diff').disabled = !ready || current.changesSeq === undefined;
    $('cancel').disabled = !ready || sending || !['running', 'waiting'].includes(current.status);
  }
  function clearCurrent() {
    current = undefined; diffRequest++; $('changes').hidden = true; $('changes').textContent = '';
    for (const id of ['plan', 'commands', 'files']) $(id).replaceChildren();
    $('state').textContent = words('读取中…', 'Loading…'); controls();
  }
  function localize() {
    for (const [id, zh, en] of [['launch', '编码状态', 'Coding status'], ['close', '关闭', 'Close'], ['refresh', '刷新记录', 'Refresh records'],
      ['diff', '查看最新差异', 'View latest diff'], ['cancel', '请求停止', 'Request stop'], ['continue', '发送给此会话', 'Send to this session'], ['retry', '重试同一请求', 'Retry the same request']]) $(id).textContent = words(zh, en);
    $('launch').setAttribute('aria-label', words('打开编码状态', 'Open coding status'));
    dialog.setAttribute('aria-label', words('Harness 编码状态', 'Harness coding status'));
    root.querySelector('header strong').textContent = dialog.getAttribute('aria-label');
    $('session').parentElement.firstChild.nodeValue = words('选择会话', 'Select session');
    $('prompt').parentElement.firstChild.nodeValue = words('继续或纠正当前任务', 'Continue or correct this task');
    $('prompt').placeholder = words('说明下一步或当前纠正', 'Describe the next step or correction');
    const small = root.querySelectorAll('small'), headings = root.querySelectorAll('h3');
    small[0].textContent = words('验收状态来自后端验证记录；命令退出 0 不等同于任务验收通过。', 'Verification comes from backend records; exit code 0 alone does not prove task acceptance.');
    small[1].textContent = words('VS Code 链接用于与服务端共享路径的本机编辑器。', 'VS Code links require a local editor sharing the server filesystem.');
    headings[0].textContent = words('实际命令', 'Actual commands'); headings[1].textContent = words('编辑记录', 'File changes');
    if (current) $('state').textContent = formatStatus(current);
  }
  function formatStatus(value) {
    const statuses = english() ? { idle: 'Not started', running: 'Running', completed: 'Task ended', failed: 'Failed', cancelled: 'Cancelled', waiting: 'Waiting for an answer' } : statusLabels;
    const verification = english() ? { unrun: 'Not verified', passed: 'Backend verification passed', failed: 'Backend verification failed' } : verifyLabels;
    return `${statuses[value.status] ?? value.status} · ${verification[value.verification] ?? words('验收状态未知', 'Verification unknown')}`;
  }
  const localeObserver = new MutationObserver(localize); localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  $('prompt').oninput = () => { saveDraft(); controls(); }; localize(); controls();
  async function remote(endpoint, args) {
    const response = await fetch('/api/deepseek/call', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), endpoint, args }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.error?.message || words(`请求失败 (${response.status})`, `Request failed (${response.status})`));
    return result.value;
  }
  async function refresh() {
    if (!dialog.open || !$('session').value) return;
    const id = $('session').value, version = generation;
    if (loading?.id === id && loading.version === version) return;
    const attempt = { id, version }; loading = attempt;
    try {
      const value = await remote('session/codingStatus', { request: { address: { kind: 'session', sessionId: id } } });
      if (version !== generation || id !== $('session').value || !dialog.open) return;
      if (value.sessionId !== id) throw new Error(words('后端会话身份不一致', 'Backend session identity does not match the selected session'));
      current = value;
      $('state').textContent = formatStatus(value);
      $('plan').replaceChildren(...value.todos.map(todo => { const li = document.createElement('li'); li.textContent = `${todo.status === 'completed' ? '✓' : '○'} ${todo.content}`; return li; }));
      $('commands').replaceChildren(...value.commands.map(command => { const pre = document.createElement('pre'); pre.textContent = `${command.command}\n${command.exitCode === null ? words('退出码未记录', 'Exit code not recorded') : `exit ${command.exitCode}`}\n${command.detail}`; return pre; }));
      $('files').replaceChildren(...value.files.map(file => { const li = document.createElement('li'), a = document.createElement('a'); a.textContent = `${file.path} · VS Code`; a.href = file.editorUri; li.append(a); return li; }));
      controls();
      if (pending.get(id)?.uncertain && !$('error').textContent) $('error').textContent = words('提交状态未知；可重试同一请求，避免重复提交。', 'Submission is uncertain; retry the same request to avoid duplicates.');
      if (!pending.get(id)?.uncertain) $('error').textContent = '';
    } catch (error) { if (version === generation && !pending.get(id)?.uncertain) $('error').textContent = error.message; }
    finally { if (loading === attempt) loading = undefined; }
  }
  async function open() {
    if (dialog.open) return;
    dialog.showModal(); generation++; clearCurrent(); const opening = generation; $('error').textContent = ''; $('notice').textContent = '';
    try {
      const list = await remote('session/list', { _request: {} }); if (opening !== generation || !dialog.open) return; const previous = $('session').value;
      $('session').replaceChildren(...list.items.map(row => { const option = document.createElement('option'); option.value = row.sessionId; option.textContent = row.projections?.values?.title || row.title || row.sessionId; return option; }));
      if (list.items.some(row => row.sessionId === previous)) $('session').value = previous;
      selectDraft($('session').value); controls();
      if (!list.items.length) $('state').textContent = words('暂无会话，请先在主界面创建编程任务。', 'No sessions. Create a coding task in the main view first.');
      await refresh(); timer = setInterval(refresh, 2000);
    } catch (error) { if (opening === generation && dialog.open) $('error').textContent = error.message; }
  }
  $('launch').onclick = open; $('close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { saveDraft(); generation++; diffRequest++; clearInterval(timer); });
  $('session').onchange = () => { selectDraft($('session').value); generation++; clearCurrent(); $('error').textContent = ''; $('notice').textContent = ''; refresh(); };
  $('refresh').onclick = refresh;
  $('cancel').onclick = async () => {
    if (sending || current?.sessionId !== $('session').value) return; sending = true; controls(); const id = current.sessionId, version = generation;
    try { await remote('session/cancel', { request: { sessionId: id } }); if (selected(version, id)) $('notice').textContent = words('停止请求已接收；等待后端取消记录。', 'Stop request received; awaiting backend cancellation.'); }
    catch (error) { if (selected(version, id)) $('error').textContent = error.message; }
    finally { sending = false; controls(); await refresh(); }
  };
  $('continue').onclick = async () => {
    const id = $('session').value, text = $('prompt').value.trim(), version = generation;
    if (!id || !text || sending || current?.sessionId !== id || current.status === 'waiting' || pending.get(id)?.uncertain) return;
    saveDraft(); submittedDrafts.set(id, $('prompt').value); sending = true; controls();
    const request = { requestId: crypto.randomUUID(), sessionId: id, mode: current?.status === 'running' ? 'steer' : 'queue', content: [{ type: 'text', text }] };
    pending.set(id, request);
    try { await remote('session/prompt', { request }); pending.delete(id); clearSubmittedDraft(id); if (selected(version, id)) $('notice').textContent = words('请求已由后端接收。', 'Request accepted by the backend.'); }
    catch (error) { pending.set(id, { ...request, uncertain: true }); if (selected(version, id)) $('error').textContent = error.message + words('。提交状态未知，请先在主界面核对，避免重复提交。', '. Submission uncertain; check the main view or retry the same request.'); }
    finally { sending = false; controls(); await refresh(); }
  };
  $('retry').onclick = async () => {
    const id = $('session').value, prior = pending.get(id), version = generation; if (!prior?.uncertain || sending) return;
    const { uncertain, ...request } = prior;
    sending = true; controls();
    try { await remote('session/prompt', { request }); pending.delete(id); clearSubmittedDraft(id); if (selected(version, id)) { $('error').textContent = ''; $('notice').textContent = words('同一请求已由后端确认接收。', 'The same request was accepted by the backend.'); } }
    catch (error) { if (selected(version, id)) $('error').textContent = error.message + words('。提交状态仍未知；重试保持同一个请求 ID。', '. Submission still uncertain; retry retains the same request ID.'); }
    finally { sending = false; controls(); await refresh(); }
  };
  $('diff').onclick = async () => {
    if (current?.sessionId !== $('session').value || current.changesSeq === undefined) return;
    const id = current.sessionId, version = generation, operation = ++diffRequest;
    const query = new URLSearchParams({ sessionId: id, seq: String(current.changesSeq) });
    const active = () => selected(version, id) && operation === diffRequest;
    try {
      const response = await fetch(`/api/changes.summary?${query}`); if (!response.ok) throw new Error(words(`差异读取失败 (${response.status})`, `Diff request failed (${response.status})`));
      const summary = await response.json(); if (!active()) return;
      $('changes').hidden = false; $('changes').textContent = JSON.stringify(summary, null, 2);
      const diff = await fetch(`/api/changes.diff?${query}&index=0`);
      if (diff.ok) { const text = (await diff.text()).slice(0, 100000); if (active()) $('changes').textContent += '\n\n' + text; }
    } catch (error) { if (active()) $('error').textContent = error.message; }
  };
})();
