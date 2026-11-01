import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { TurnEvent } from "@ar/protocol";
import { HarnessClient, OverflowError, SdkError } from "./client.js";
import { MemoryHarnessTransport } from "./transport.js";

const initialize = { protocolVersion: "1", serverInfo: { name: "sdk-lifecycle", version: "1" }, capabilities: {} };
const event = (type: TurnEvent["type"], sequence: number, fields: Record<string, unknown> = {}): TurnEvent =>
  ({ type, sequence, threadId: "thread-1", turnId: "turn-1", ...fields }) as TurnEvent;

function fixture(events: TurnEvent[] = []) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let transport: MemoryHarnessTransport;
  transport = new MemoryHarnessTransport(async (method, params) => {
    calls.push({ method, params });
    if (method === "initialize") return { result: initialize };
    if (method === "thread/start") return { result: { id: "thread-1" } };
    if (method === "turn/start") return { result: { turnId: "turn-1" } };
    if (method === "turn/run") for (const item of events) transport.emit(item);
    return { result: {} };
  });
  return { transport, calls };
}

describe("SDK reducer-only lifecycle", () => {
  it("reduces a synchronous replay beyond the public queue limit without losing the terminal result", async () => {
    const events = Array.from({ length: 4300 }, (_, i) => event("item/delta", i + 1, { delta: { text: "x" } }));
    events.push(event("item/completed", 4301, { item: { kind: "agent_message", sequence: 4301, final: true, text: "done", usage: { inputTokens: 8, outputTokens: 4300 } } }));
    events.push(event("turn/completed", 4302));
    const { transport, calls } = fixture(events);
    const client = await HarnessClient.connect(transport);
    try {
      const thread = await client.startThread({ agentName: "coding", cwd: "/project" });
      const result = await thread.run("code", { idempotencyKey: "run-request" });
      expect(result).toMatchObject({ status: "completed", turnId: "turn-1", finalResponse: "done", usage: { inputTokens: 8, outputTokens: 4300 } });
      expect(result.items).toHaveLength(1);
      expect(calls.filter(call => call.method === "turn/start")).toEqual([{ method: "turn/start", params: { threadId: "thread-1", prompt: "code", idempotencyKey: "run-request" } }]);
      expect(calls.filter(call => call.method === "turn/run")).toHaveLength(1);
      expect(transport.subscriberCount()).toBe(0);
      expect(transport.closeHandlerCount()).toBe(0);
    } finally { await client.close(); }
  });

  it("keeps runStreamed's absent-consumer failure at 4096 accepted events", async () => {
    const events = Array.from({ length: 4300 }, (_, i) => event("item/delta", i + 1, { delta: { text: "x" } }));
    events.push(event("turn/completed", 4301));
    const { transport } = fixture(events);
    const client = await HarnessClient.connect(transport);
    try {
      const thread = await client.startThread({ agentName: "coding", cwd: "/project" });
      const stream = await thread.runStreamed("stream without a consumer");
      expect(await stream.done).toMatchObject({ status: "failed", error: { code: "STREAM_BUFFER_OVERFLOW", retryable: true } });
      let accepted = 0;
      let failure: unknown;
      try { for await (const _ of stream.events) { accepted++; } } catch (error) { failure = error; }
      expect(accepted).toBe(4096);
      expect(failure).toBeInstanceOf(OverflowError);
      expect(transport.subscriberCount()).toBe(0);
      expect(transport.closeHandlerCount()).toBe(0);
    } finally { await client.close(); }
  });

  it.each(["turn/completed", "turn/failed"] as const)("terminal %s wins over a later abort without sending interrupt", async type => {
    const terminal = event(type, 1, type === "turn/failed" ? { error: { code: "MODEL_ERROR", message: "model failed", retryable: false } } : {});
    const { transport, calls } = fixture([terminal]);
    const client = await HarnessClient.connect(transport);
    try {
      const thread = await client.startThread({ agentName: "coding", cwd: "/project" });
      const controller = new AbortController();
      const done = thread.run("code", { signal: controller.signal });
      expect((await done).status).toBe(type === "turn/failed" ? "failed" : "completed");
      controller.abort();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(calls.some(call => call.method === "turn/interrupt")).toBe(false);
      expect(transport.subscriberCount()).toBe(0);
      expect(transport.closeHandlerCount()).toBe(0);
    } finally { await client.close(); }
  });

  it("preserves invocation failure and transport close for reducer-only runs", async () => {
    for (const mode of ["protocol-error", "close"] as const) {
      const { transport } = fixture();
      const invoke = transport.invoke.bind(transport);
      transport.invoke = async (method, params) => {
        if (method !== "turn/run") return invoke(method, params);
        if (mode === "close") { await transport.close(); return { result: {} }; }
        return { error: { code: "RUN_DENIED", message: "denied", retryable: true } };
      };
      const client = await HarnessClient.connect(transport);
      try {
        const thread = await client.startThread({ agentName: "coding", cwd: "/project" });
        expect(await thread.run("code")).toMatchObject({ status: "failed", error: { code: mode === "close" ? "STREAM_TERMINATED_BEFORE_TURN_END" : "RUN_DENIED", retryable: true } });
        expect(transport.subscriberCount()).toBe(0);
        expect(transport.closeHandlerCount()).toBe(0);
      } finally { await client.close(); }
    }
  });
});

describe("SDK interrupt errors", () => {
  it("rejects an explicit interrupt protocol error with SdkError metadata", async () => {
    const { transport } = fixture();
    const invoke = transport.invoke.bind(transport);
    transport.invoke = async (method, params) => method === "turn/interrupt"
      ? { error: { code: "gateway/forbidden", message: "interrupt denied", retryable: false } }
      : invoke(method, params);
    const client = await HarnessClient.connect(transport);
    try {
      const thread = await client.startThread({ agentName: "coding", cwd: "/project" });
      await expect(thread.interrupt("turn-1")).rejects.toBeInstanceOf(SdkError);
      await expect(thread.interrupt("turn-1")).rejects.toMatchObject({ code: "gateway/forbidden", message: "interrupt denied", retryable: false });
    } finally { await client.close(); }
  });

  it("keeps a successful explicit interrupt and rejects a transport failure", async () => {
    const { transport, calls } = fixture();
    const client = await HarnessClient.connect(transport);
    try {
      const thread = await client.startThread({ agentName: "coding", cwd: "/project" });
      await expect(thread.interrupt("turn-1")).resolves.toBeUndefined();
      expect(calls.at(-1)).toEqual({ method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } });
      const failure = new Error("offline");
      const invoke = transport.invoke.bind(transport);
      transport.invoke = (method, params) => method === "turn/interrupt" ? Promise.reject(failure) : invoke(method, params);
      await expect(thread.interrupt()).rejects.toBe(failure);
    } finally { await client.close(); }
  });

  // A separate Node process observes unhandledRejection without contaminating
  // Vitest's own process. Import the built SDK exactly as an installed host does.
  it.each(["reject", "protocol", "throw", "pending", "success"])("local abort handles %s notification without hanging or leaking errors", mode => {
    const script = `
      import { HarnessClient, MemoryHarnessTransport } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
      const mode = ${JSON.stringify(mode)};
      const secret = 'PRIVATE_GATEWAY_PAYLOAD_MUST_NOT_LEAK';
      let unhandled = 0, interruptCalls = 0, runCalls = 0;
      process.on('unhandledRejection', () => { unhandled++; });
      const base = new MemoryHarnessTransport(async method => {
        if(method==='initialize') return {result:${JSON.stringify(initialize)}};
        if(method==='thread/start') return {result:{id:'thread-1'}};
        if(method==='turn/start') return {result:{turnId:'turn-1'}};
        if(method==='turn/run') { runCalls++; return new Promise(()=>{}); }
        return {result:{}};
      });
      const transport = {
        invoke(method, params) {
          if(method!=='turn/interrupt') return base.invoke(method,params);
          interruptCalls++;
          if(mode==='throw') throw new Error(secret);
          if(mode==='reject') return Promise.reject(new Error(secret));
          if(mode==='protocol') return Promise.resolve({error:{code:secret,message:secret,retryable:false,data:{secret}}});
          if(mode==='pending') return new Promise(()=>{});
          return Promise.resolve({result:{}});
        },
        subscribe: base.subscribe.bind(base), onClose: base.onClose.bind(base),
        initializeResult: base.initializeResult.bind(base), close: base.close.bind(base)
      };
      const client=await HarnessClient.connect(transport);
      const thread=await client.startThread({agentName:'coding',cwd:'/project'});
      for(const preAborted of [false,true]) {
        const controller=new AbortController();
        if(preAborted) controller.abort();
        const stream=await thread.runStreamed('code',{signal:controller.signal});
        if(!preAborted) controller.abort();
        let timer;
        const result=await Promise.race([stream.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('local abort waited for acknowledgement')),500);})]);
        clearTimeout(timer);
        await new Promise(resolve=>setImmediate(resolve));
        await new Promise(resolve=>setImmediate(resolve));
        if(result.status!=='interrupted') throw new Error('abort status lost');
        if(base.subscriberCount()!==0 || base.closeHandlerCount()!==0) throw new Error('run listeners leaked');
      }
      await client.close();
      console.log(JSON.stringify({unhandled,interruptCalls,runCalls}));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ unhandled: 0, interruptCalls: 2, runCalls: 1 });
    expect(child.stderr).not.toContain("PRIVATE_GATEWAY_PAYLOAD_MUST_NOT_LEAK");
    if (["reject", "protocol", "throw"].includes(mode)) {
      expect(child.stderr.trim().split("\n")).toEqual(Array(2).fill("[harness-sdk] interrupt notification failed; server stop is not confirmed"));
    } else expect(child.stderr).toBe("");
  });
});
