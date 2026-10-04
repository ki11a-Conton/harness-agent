// Explicit controlled-protocol fixture. It replaces browser transport only in
// controlled cases; production cases install no transport or runtime overrides.
(() => {
  const A = 'browser-control-A-123';
  const B = 'browser-control-B-123';
  localStorage.setItem('harness.web.froms', JSON.stringify([A, B]));
  localStorage.setItem('harness.web.activeFrom', B);
  const originalFetch = window.fetch.bind(window);
  const control = window.__control = { A, B, streams: [], posts: [], historyWaiters: [], postWaiters: [], holdHistory: false, holdPost: false };
  const history = from => ({ sessionId: `session-${from}`, messages: [{ id: `history-${from}`, role: 'user', content: from === A ? 'A_ONLY_HISTORY' : 'B_ONLY_HISTORY' }] });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href);
    if (url.pathname === '/api/bootstrap') return json({ from: url.searchParams.get('from') ?? B });
    if (url.pathname === '/api/sessions') return json({ sessions: [] });
    if (url.pathname === '/api/history') {
      const from = url.searchParams.get('from');
      if (control.holdHistory && from === A) return new Promise(resolve => control.historyWaiters.push(() => resolve(json(history(from)))));
      return json(history(from));
    }
    if (options.method === 'POST' && ['/api/messages', '/api/commands'].includes(url.pathname)) {
      control.posts.push({ path: url.pathname, body: JSON.parse(options.body) });
      if (control.holdPost) return new Promise(resolve => control.postWaiters.push((status, body) => resolve(json(body, status))));
      return json({ ok: true });
    }
    return originalFetch(input, options);
  };
  window.EventSource = class ControlledEventSource {
    constructor(url) {
      this.url = url; this.closed = false; control.streams.push(this);
      setTimeout(() => this.onopen?.({}), 0);
    }
    close() { this.closed = true; }
  };
  control.emit = (index, frame) => control.streams[index].onmessage?.({ data: JSON.stringify(frame) });
  control.resolveHistory = () => control.historyWaiters.splice(0).forEach(resolve => resolve());
  control.resolvePost = (status = 400, body = { error: 'OLD_POST_FAILURE' }) => control.postWaiters.splice(0).forEach(resolve => resolve(status, body));
})();
