/* Harness browser carrier for the unmodified DeepSeek Connection RPC seam.
 * This file owns carrier framing only. The server owns endpoint admission,
 * permissions, identity, argument validation, and all application state.
 */
(() => {
  "use strict";
  const ROOT = "/api/deepseek/";
  const MAX_FRAME_CHARACTERS = 64 * 1024 * 1024;
  const MAX_BINARY_BYTES = 32 * 1024 * 1024;
  const prefix = globalThis.crypto.randomUUID();
  let sequence = 0;
  const nextId = () => `${prefix}_${++sequence}`;
  const failure = (code, message, details = {}) => ({ code, message, details });
  const abortError = () => new DOMException("The operation was aborted", "AbortError");
  const throwIfAborted = signal => {
    if (signal?.aborted) throw signal.reason ?? abortError();
  };
  const encode = value => JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) return { $dshBytes: Array.from(item) };
    return item;
  });
  const decode = value => JSON.parse(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item) &&
      Object.keys(item).length === 1 && Object.hasOwn(item, "$dshBytes")) {
      if (!Array.isArray(item.$dshBytes) || item.$dshBytes.length > MAX_BINARY_BYTES || item.$dshBytes.some(byte =>
        !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        throw new Error("Harness transport received invalid binary data");
      }
      return Uint8Array.from(item.$dshBytes);
    }
    return item;
  });
  const isFailure = value => value && typeof value === "object" &&
    typeof value.code === "string" && typeof value.message === "string" &&
    value.details && typeof value.details === "object";
  const readResult = async response => {
    const result = decode(await response.text());
    if (result?.ok === true) {
      if (!response.ok) throw new Error(`Harness transport received success on a failed HTTP response (${response.status})`);
      return { ok: true, value: result.value };
    }
    if (result?.ok === false && isFailure(result.error)) return result;
    throw new Error(`Harness transport received an invalid RPC result (HTTP ${response.status})`);
  };
  const post = (path, value, signal, keepalive = false) => fetch(ROOT + path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "Accept": "application/json, application/x-ndjson" },
    body: encode(value),
    signal,
    keepalive,
    cache: "no-store",
  });
  const notifyCancellation = ids => {
    // A separate small request survives aborting the data request. It cannot
    // address another operation without its unguessable, page-minted ID. The
    // server additionally checks whether the ID names a call or a stream.
    void post("cancel", ids, undefined, true).catch(() => {});
  };
  const argsOf = (channel, payload) => {
    if (channel !== "/api") throw new Error(`Harness transport does not carry channel ${channel}`);
    if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "args")) {
      throw new Error("Harness transport requires the DeepSeek {args} payload");
    }
    return payload.args;
  };
  const streamError = value => {
    if (!isFailure(value)) throw new Error("Harness transport received an invalid stream failure");
    const error = new Error(value.message);
    error.code = value.code;
    error.details = value.details;
    return error;
  };

  async function call(channel, endpoint, payload, signal) {
    const args = argsOf(channel, payload);
    throwIfAborted(signal);
    const requestId = nextId();
    const onAbort = () => notifyCancellation({ requestId });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await post("call", { endpoint, args, requestId }, signal);
      const result = await readResult(response);
      throwIfAborted(signal);
      return result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function* open(channel, endpoint, payload, signal, uplink) {
    const args = argsOf(channel, payload);
    throwIfAborted(signal);
    const streamId = nextId();
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort(signal.reason ?? abortError());
      notifyCancellation({ streamId });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let reader;
    let iterator;
    let uplinkFailure;
    try {
      const response = await post("open", { endpoint, args, streamId }, controller.signal);
      if (!response.ok) {
        const result = await readResult(response);
        throw streamError(result.ok ? failure("gateway/internal", "Failed to open stream") : result.error);
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/x-ndjson") ||
        response.body === null) throw new Error("Harness transport expected an NDJSON stream");
      reader = response.body.getReader();
      if (uplink !== undefined) {
        iterator = uplink[Symbol.asyncIterator]();
        void (async () => {
          try {
            while (!controller.signal.aborted) {
              const item = await iterator.next();
              if (controller.signal.aborted) return;
              if (item.done) {
                const result = await readResult(await post("uplink", { streamId, done: true }, controller.signal));
                if (!result.ok) throw streamError(result.error);
                return;
              }
              const result = await readResult(await post("uplink", { streamId, item: item.value }, controller.signal));
              if (!result.ok) throw streamError(result.error);
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              uplinkFailure = error;
              controller.abort(error);
            }
          }
        })();
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffered = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        throwIfAborted(signal);
        if (uplinkFailure !== undefined) throw uplinkFailure;
        done = chunk.done;
        buffered += decoder.decode(chunk.value, { stream: !done });
        let newline;
        while ((newline = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          if (line.length > MAX_FRAME_CHARACTERS) throw new Error("Harness stream frame exceeds the transport limit");
          const value = decode(line);
          if (value && Object.hasOwn(value, "__deepseek_transport_error__")) {
            throw streamError(value.__deepseek_transport_error__);
          }
          yield value;
        }
        if (buffered.length > MAX_FRAME_CHARACTERS) throw new Error("Harness stream frame exceeds the transport limit");
      }
      if (buffered.trim()) throw new Error("Harness NDJSON stream ended inside a frame");
    } catch (error) {
      if (uplinkFailure !== undefined) throw uplinkFailure;
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      void reader?.cancel().catch(() => {});
      if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
      notifyCancellation({ streamId });
    }
  }

  // HTTP/1 browsers allow only six connections per authority. Official
  // clients open more permanent streams, so their Remote calls share one
  // socket. A failed connection rejects its current work; no model action is
  // replayed automatically when another operation opens a fresh connection.
  let socket;
  let connecting;
  const pending = new Map();
  let queuedFrames = 0;
  let queuedCharacters = 0;
  const clearFrames = entry => {
    for (const frame of entry.frames ?? []) { queuedFrames--; queuedCharacters -= frame.size; }
    if (entry.frames) entry.frames.length = 0;
  };
  const failEntry = (entry, error, preserveFrames = false) => {
    if (entry.done) return;
    entry.done = true; entry.error = error; if (!preserveFrames) clearFrames(entry);
    entry.reject?.(error); entry.rejectOpened?.(error); entry.wake?.(); entry.wake = undefined;
  };
  const failConnection = (connection, error) => {
    if (socket === connection) socket = undefined;
    for (const entry of pending.values()) if (entry.connection === connection) failEntry(entry, error);
  };
  const socketResult = (value, status) => {
    if (value?.ok === true) {
      if (status < 200 || status >= 300) throw new Error(`Harness transport received success on a failed socket response (${status})`);
      return { ok: true, value: value.value };
    }
    if (value?.ok === false && isFailure(value.error)) return value;
    throw new Error("Harness transport received an invalid socket RPC result");
  };
  const connection = () => {
    if (socket?.readyState === 1) return Promise.resolve(socket);
    if (connecting) return connecting;
    const url = new URL(ROOT + "socket", globalThis.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(url);
    socket = current;
    connecting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Harness socket connection timed out")); current.close(); }, 10_000);
      current.addEventListener("open", () => { clearTimeout(timer); resolve(current); }, { once: true });
      current.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Harness socket connection failed")); }, { once: true });
      current.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Harness socket disconnected before admission")); }, { once: true });
      current.addEventListener("message", event => {
        try {
          if (typeof event.data !== "string" || event.data.length > MAX_FRAME_CHARACTERS) throw new Error("Harness socket received invalid frame data");
          const frame = decode(event.data);
          if (!frame || typeof frame.id !== "string") throw new Error("Harness socket received invalid framing");
          const entry = pending.get(frame.id);
          // A server settlement can race the consumer's explicit cancel.
          if (!entry || entry.connection !== current || entry.done) return;
          if (frame.type === "result") {
            const result = socketResult(frame.value, frame.status);
            if (entry.kind !== "call") { if (result.ok) throw new Error("Harness socket stream received a unary result"); failEntry(entry, streamError(result.error)); }
            else { entry.done = true; entry.resolve(result); }
          } else if (frame.type === "opened" && entry.kind === "open") {
            if (entry.opened) throw new Error("Harness socket repeated stream admission");
            entry.opened = true; entry.resolveOpened();
          } else if (frame.type === "frame" && entry.kind === "open" && entry.opened) {
            if (frame.value && Object.hasOwn(frame.value, "__deepseek_transport_error__")) { failEntry(entry, streamError(frame.value.__deepseek_transport_error__), true); return; }
            if (queuedFrames >= 128 || queuedCharacters + event.data.length > 8 * 1024 * 1024) throw new Error("Harness socket receive queue exceeded its limit");
            entry.frames.push({ value: frame.value, size: event.data.length }); queuedFrames++; queuedCharacters += event.data.length;
            entry.wake?.(); entry.wake = undefined;
          } else if (frame.type === "end" && entry.kind === "open" && entry.opened) {
            entry.done = true; entry.ended = true; entry.wake?.(); entry.wake = undefined;
          } else throw new Error("Harness socket received an invalid operation frame");
        } catch (error) { failConnection(current, error); current.close(1008, "Invalid Remote frame"); }
      });
      current.addEventListener("close", () => failConnection(current, new Error("Harness socket disconnected; current operation was not replayed")));
      current.addEventListener("error", () => failConnection(current, new Error("Harness socket connection failed")));
    }).finally(() => { connecting = undefined; });
    return connecting;
  };
  const beginSocket = (route, body, signal, kind = "call") => {
    const id = nextId();
    if (pending.size >= 160) throw new Error("Harness socket pending request limit exceeded");
    const entry = { kind, frames: [], done: false, sent: false };
    if (kind === "call") entry.result = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    else {
      entry.admission = new Promise((resolve, reject) => { entry.resolveOpened = resolve; entry.rejectOpened = reject; });
      // Admission may fail before a consumer reaches its await.
      void entry.admission.catch(() => {});
    }
    pending.set(id, entry);
    void (async () => {
      try {
        const ready = connection(); entry.connection = socket;
        const actual = await ready; throwIfAborted(signal);
        if (entry.done) return;
        entry.connection = actual;
        const raw = encode({ type: "request", id, route, body });
        if (raw.length > 1_000_000 || actual.bufferedAmount + raw.length > 8 * 1024 * 1024) throw new Error("Harness socket request exceeded its limit");
        actual.send(raw); entry.sent = true;
      } catch (error) { failEntry(entry, error); }
    })();
    return { id, entry };
  };
  const socketCancel = ids => {
    if (socket?.readyState !== 1) return;
    void socketUnary("cancel", ids).catch(() => {});
  };
  async function socketUnary(route, body, signal) {
    throwIfAborted(signal);
    const { id, entry } = beginSocket(route, body, signal);
    const onAbort = () => { failEntry(entry, signal.reason ?? abortError()); if (entry.sent) socketCancel(route === "call" ? { requestId: body.requestId } : { streamId: body.streamId }); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try { const result = await entry.result; throwIfAborted(signal); return result; }
    finally { signal?.removeEventListener("abort", onAbort); pending.delete(id); }
  }
  async function socketCall(channel, endpoint, payload, signal) {
    return socketUnary("call", { endpoint, args: argsOf(channel, payload), requestId: nextId() }, signal);
  }
  async function* socketOpen(channel, endpoint, payload, signal, uplink) {
    const args = argsOf(channel, payload); throwIfAborted(signal);
    const streamId = nextId(); const { id, entry } = beginSocket("open", { endpoint, args, streamId }, signal, "open");
    const controller = new AbortController(); let iterator;
    let cancellationSent = false;
    const cancelOnce = () => { if (entry.sent && !entry.ended && !cancellationSent) { cancellationSent = true; socketCancel({ streamId }); } };
    const onAbort = () => { controller.abort(signal.reason ?? abortError()); failEntry(entry, signal.reason ?? abortError()); cancelOnce(); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await entry.admission;
      if (uplink !== undefined) {
        iterator = uplink[Symbol.asyncIterator]();
        void (async () => {
          try {
            while (!controller.signal.aborted && !entry.done) {
              const item = await iterator.next(); if (controller.signal.aborted || entry.done) return;
              const result = await socketUnary("uplink", item.done ? { streamId, done: true } : { streamId, item: item.value }, controller.signal);
              if (!result.ok) throw streamError(result.error);
              if (item.done) return;
            }
          } catch (error) { if (!controller.signal.aborted) { failEntry(entry, error); cancelOnce(); } }
        })();
      }
      while (true) {
        throwIfAborted(signal);
        if (entry.frames.length) {
          const frame = entry.frames.shift(); queuedFrames--; queuedCharacters -= frame.size; yield frame.value;
        } else if (entry.error) throw entry.error;
        else if (entry.done) return;
        else await new Promise(resolve => { entry.wake = resolve; });
      }
    } finally {
      signal.removeEventListener("abort", onAbort); controller.abort(); clearFrames(entry); pending.delete(id);
      if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
      cancelOnce();
    }
  }

  // Deliberately omit ownsHost: the official Connection plugin must continue
  // to classify the actual browser authority and enforce its loopback rules.
  globalThis.__DSH_TRANSPORT__ = { rpc: typeof WebSocket === "function" ? { call: socketCall, open: socketOpen } : { call, open } };
})();
