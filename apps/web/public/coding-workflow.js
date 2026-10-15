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
  let generation = 0, current, timer, loading = false, sending = false;
  const pending = new Map();
  const statusLabels = { idle: '未开始', running: '运行中', completed: '任务已结束', failed: '任务失败', cancelled: '已取消', waiting: '等待用户回答' };
  const verifyLabels = { unrun: '未运行验收', passed: '后端验收通过', failed: '后端验收失败' };
  async function remote(endpoint, args) {
    const response = await fetch('/api/deepseek/call', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), endpoint, args }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.error?.message || `请求失败 (${response.status})`);
    return result.value;
  }
  async function refresh() {
    if (loading || !dialog.open || !$('session').value) return;
    loading = true; const id = $('session').value, version = generation;
    try {
      const value = await remote('session/codingStatus', { request: { address: { kind: 'session', sessionId: id } } });
      if (version !== generation || id !== $('session').value || !dialog.open) return;
      current = value;
      $('state').textContent = `${statusLabels[value.status] ?? value.status} · ${verifyLabels[value.verification] ?? '验收状态未知'}`;
      $('plan').replaceChildren(...value.todos.map(todo => { const li = document.createElement('li'); li.textContent = `${todo.status === 'completed' ? '✓' : '○'} ${todo.content}`; return li; }));
      $('commands').replaceChildren(...value.commands.map(command => { const pre = document.createElement('pre'); pre.textContent = `${command.command}\n${command.exitCode === null ? '退出码未记录' : `exit ${command.exitCode}`}\n${command.detail}`; return pre; }));
      $('files').replaceChildren(...value.files.map(file => { const li = document.createElement('li'), a = document.createElement('a'); a.textContent = `${file.path} · VS Code`; a.href = file.editorUri; li.append(a); return li; }));
      $('diff').disabled = value.changesSeq === undefined;
      $('continue').disabled = sending || value.status === 'waiting' || pending.get(id)?.uncertain === true;
      $('retry').hidden = !pending.get(id)?.uncertain; $('retry').disabled = sending;
      if (pending.get(id)?.uncertain && !$('error').textContent) $('error').textContent = '提交状态未知；可重试同一请求，避免重复提交。';
      $('cancel').disabled = sending || !['running', 'waiting'].includes(value.status);
      if (!pending.get(id)?.uncertain) $('error').textContent = '';
    } catch (error) { if (version === generation && !pending.get(id)?.uncertain) $('error').textContent = error.message; }
    finally { loading = false; }
  }
  async function open() {
    if (dialog.open) return;
    dialog.showModal(); generation++; const opening = generation; $('error').textContent = ''; $('notice').textContent = '';
    try {
      const list = await remote('session/list', { _request: {} }); if (opening !== generation || !dialog.open) return; const previous = $('session').value;
      $('session').replaceChildren(...list.items.map(row => { const option = document.createElement('option'); option.value = row.sessionId; option.textContent = row.title || row.sessionId; return option; }));
      if (list.items.some(row => row.sessionId === previous)) $('session').value = previous;
      if (!list.items.length) $('state').textContent = '暂无会话，请先在主界面创建编程任务。';
      await refresh(); timer = setInterval(refresh, 2000);
    } catch (error) { $('error').textContent = error.message; }
  }
  $('launch').onclick = open; $('close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { generation++; clearInterval(timer); });
  $('session').onchange = () => { generation++; current = undefined; $('changes').hidden = true; $('notice').textContent = ''; refresh(); };
  $('refresh').onclick = refresh;
  $('cancel').onclick = async () => {
    if (sending || !current) return; sending = true; $('session').disabled = true; $('cancel').disabled = true; const id = current.sessionId;
    try { await remote('session/cancel', { request: { sessionId: id } }); $('notice').textContent = '停止请求已接收；等待后端取消记录。'; }
    catch (error) { $('error').textContent = error.message; }
    finally { sending = false; $('session').disabled = false; await refresh(); }
  };
  $('continue').onclick = async () => {
    const id = $('session').value, text = $('prompt').value.trim(); if (!id || !text || sending || pending.get(id)?.uncertain) return;
    sending = true; $('session').disabled = true; $('continue').disabled = true;
    const request = { requestId: crypto.randomUUID(), sessionId: id, mode: current?.status === 'running' ? 'steer' : 'queue', content: [{ type: 'text', text }] };
    pending.set(id, request);
    try { await remote('session/prompt', { request }); pending.delete(id); $('prompt').value = ''; $('notice').textContent = '请求已由后端接收。'; }
    catch (error) { pending.set(id, { ...request, uncertain: true }); $('error').textContent = `${error.message}。提交状态未知，请先在主界面核对，避免重复提交。`; }
    finally { sending = false; $('session').disabled = false; await refresh(); }
  };
  $('retry').onclick = async () => {
    const id = $('session').value, prior = pending.get(id); if (!prior?.uncertain || sending) return;
    const { uncertain, ...request } = prior;
    sending = true; $('session').disabled = true; $('retry').disabled = true;
    try { await remote('session/prompt', { request }); pending.delete(id); $('prompt').value = ''; $('error').textContent = ''; $('notice').textContent = '同一请求已由后端确认接收。'; }
    catch (error) { $('error').textContent = `${error.message}。提交状态仍未知；重试保持同一个请求 ID。`; }
    finally { sending = false; $('session').disabled = false; await refresh(); }
  };
  $('diff').onclick = async () => {
    if (!current || current.changesSeq === undefined) return;
    const query = new URLSearchParams({ sessionId: current.sessionId, seq: String(current.changesSeq) });
    try {
      const response = await fetch(`/api/changes.summary?${query}`); if (!response.ok) throw new Error(`差异读取失败 (${response.status})`);
      const summary = await response.json(); $('changes').hidden = false; $('changes').textContent = JSON.stringify(summary, null, 2);
      const diff = await fetch(`/api/changes.diff?${query}&index=0`);
      if (diff.ok) $('changes').textContent += '\n\n' + (await diff.text()).slice(0, 100000);
    } catch (error) { $('error').textContent = error.message; }
  };
})();
