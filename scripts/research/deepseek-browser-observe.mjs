/** Read-only Playwright network observation; supports real HTTP and socket RPC. */
export function observeProductionRpc(page, origin) {
  const calls = [], results = [], sockets = [], externalRequests = [];
  const requests = new Map(), waiters = new Set(), pending = [];
  const emit = result => {
    results.push(result);
    for (const waiter of waiters) {
      if (waiter.endpoint !== result.endpoint || results.length <= waiter.since) continue;
      waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve({ result });
    }
  };
  page.on("request", request => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) externalRequests.push(request.url());
    if (!url.pathname.startsWith("/api/deepseek/")) return;
    let body; try { body = request.postDataJSON(); } catch {}
    calls.push({ carrier: "http", route: url.pathname.split("/").at(-1), method: request.method(),
      path: url.pathname, endpoint: body?.endpoint, argsKeys: Object.keys(body?.args ?? {}),
      uplink: body?.item !== undefined, uplinkDone: body?.done === true });
  });
  page.on("response", response => {
    if (new URL(response.url()).pathname !== "/api/deepseek/call") return;
    pending.push((async () => {
      let request; try { request = response.request().postDataJSON(); } catch {}
      let body; try { body = await response.json(); } catch {}
      emit({ carrier: "http", endpoint: request?.endpoint, status: response.status(), ok: body?.ok,
        ...(request?.endpoint === "session/create" && body?.ok === true ? { value: { sessionId: body.value?.sessionId } } : {}),
        ...(body?.error ? { error: body.error } : {}) });
    })());
  });
  page.on("websocket", socket => {
    const url = new URL(socket.url());
    if (![["ws:", "http:"], ["wss:", "https:"]].some(([socketProtocol, httpProtocol]) =>
      url.protocol === socketProtocol && new URL(origin).protocol === httpProtocol && url.host === new URL(origin).host)) {
      externalRequests.push(socket.url());
    }
    const observation = { url: socket.url(), sent: 0, received: 0, streamFrames: 0, closed: false, errors: [] };
    sockets.push(observation);
    socket.on("framesent", event => {
      observation.sent++;
      let frame; try { frame = JSON.parse(String(event.payload)); } catch { return; }
      if (frame.type !== "request") return;
      const call = { carrier: "websocket", route: frame.route, endpoint: frame.body?.endpoint,
        argsKeys: Object.keys(frame.body?.args ?? {}), uplink: frame.body?.item !== undefined,
        uplinkDone: frame.body?.done === true, state: "sent" };
      calls.push(call); requests.set(frame.id, call);
    });
    socket.on("framereceived", event => {
      observation.received++;
      let frame; try { frame = JSON.parse(String(event.payload)); } catch { return; }
      const call = requests.get(frame.id); if (!call) return;
      if (frame.type === "opened") call.state = "opened";
      if (frame.type === "frame") {
        observation.streamFrames++;
        const error = frame.value?.__deepseek_transport_error__;
        if (error) emit({ carrier: "websocket-stream", endpoint: call.endpoint, ok: false, error });
      }
      if (frame.type === "end") { call.state = "ended"; requests.delete(frame.id); }
      if (frame.type === "result") {
        call.state = "settled"; requests.delete(frame.id);
        emit({ carrier: "websocket", endpoint: call.endpoint, status: frame.status, ok: frame.value?.ok,
          ...(call.endpoint === "session/create" && frame.value?.ok === true ? { value: { sessionId: frame.value.value?.sessionId } } : {}),
          ...(frame.value?.error ? { error: frame.value.error } : {}) });
      }
    });
    socket.on("close", () => { observation.closed = true; });
    socket.on("socketerror", error => { observation.errors.push(String(error)); });
  });
  return { calls, results, sockets, externalRequests,
    settled: () => Promise.allSettled(pending),
    waitForResult(endpoint, timeoutMs = 12000) {
      return new Promise(resolve => {
        const waiter = { endpoint, resolve, since: results.length };
        waiter.timer = setTimeout(() => { waiters.delete(waiter); resolve({ error: new Error(`Production RPC ${endpoint} did not return within ${timeoutMs} ms`) }); }, timeoutMs);
        waiters.add(waiter);
      });
    },
  };
}

/** Upstream graph URLs and the preloaded bootstrap address the same original bytes. */
export function canonicalPluginResource(url, origin) {
  const parsed = new URL(url, origin), resource = parsed.pathname + parsed.search;
  const combo = /^\/deepseek\/plugins\/\?\?(@deepseek-ai\/dsh-[a-z0-9-]+)\/client\.js&rev=[a-f0-9]{12}$/.exec(resource);
  if (combo) return `/deepseek/plugins/${combo[1].slice("@deepseek-ai/".length)}/client.js`;
  const scoped = /^\/deepseek\/plugins\/@deepseek-ai\/(dsh-[a-z0-9-]+)\/(client(?:\.[A-Za-z0-9._-]+)?\.js)$/.exec(parsed.pathname);
  if (scoped) return `/deepseek/plugins/${scoped[1]}/${scoped[2]}`;
  return parsed.pathname;
}
