import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { buildSandboxLaunch, prepareSandboxedExec, resolveExecCwd } from "@ar/tools";
import type { IPty } from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon as Serializer } from "@xterm/addon-serialize";
import { SandboxManager } from "@ar/security";
import { exact, integer, record, requireFileSession, text, WorkspaceRemoteError } from "./files.js";
import type { WorkspaceHost } from "./workspace.js";

export interface TerminalShell {path:string;args:string[];name:string}
export interface WebTerminalInfo {id:string;title:string;shell:TerminalShell;cwd:string;cols:number;rows:number;state:"running"|"exited"|"failed";exitCode:number|null;error?:string;controllerId?:string}
type Frame={type:"snapshot";sequence:number;screen:string;info:WebTerminalInfo}|{type:"output";sequence:number;data:string}|{type:"state";info:WebTerminalInfo};
const MAX_INPUT=64*1024, MAX_BUFFER=2*1024*1024;
function identity(value:unknown,name:string):string {const result=text(value,name);if(!/^[\w-]{1,128}$/u.test(result))throw new WorkspaceRemoteError("gateway/bad-request",`Invalid ${name}`);return result;}
function dimensions(cols:unknown,rows:unknown):{cols:number;rows:number}{return{cols:integer(cols,"cols",2,500),rows:integer(rows,"rows",1,200)};}
class Follower {
  queue:Frame[]=[];bytes=0;ended=false;error:Error|undefined;wake:(()=>void)|undefined;
  push(frame:Frame){if(this.ended)return;this.bytes+=Buffer.byteLength(JSON.stringify(frame));if(this.bytes>MAX_BUFFER){this.close(new WorkspaceRemoteError("terminal/unavailable","Terminal output consumer exceeded its buffer"));return;}this.queue.push(frame);this.wake?.();}
  close(error?:Error){this.ended=true;this.error=error;this.wake?.();}
  async *read(signal:AbortSignal):AsyncIterable<Frame>{const abort=()=>this.close();signal.addEventListener("abort",abort,{once:true});try{while(!signal.aborted){const next=this.queue.shift();if(next){this.bytes-=Buffer.byteLength(JSON.stringify(next));yield next;continue;}if(this.ended){if(this.error)throw this.error;return;}await new Promise<void>(done=>{this.wake=done;});this.wake=undefined;}}finally{signal.removeEventListener("abort",abort);this.close();}}
}
interface OwnedTerminal {info:WebTerminalInfo;pty:IPty;screen:HeadlessTerminal;serializer:Serializer;sequence:number;followers:Set<Follower>;tail:Promise<void>;exited:Promise<void>;resolveExit:()=>void;timer?:ReturnType<typeof setTimeout>;closed:boolean;processExited:boolean;bufferedBytes:number;closing?:Promise<void>}
/** Browser PTYs are private host tools; no ordinary chat process is exposed here. */
export interface TerminalHost extends WorkspaceHost {
  externalSessionId?(nativeId:string):string;
  withSessionLock?<T>(sessionId:string,action:()=>Promise<T>):Promise<T>;
}
export function createTerminalService(host:TerminalHost) {
  const logicalId=(nativeId:string)=>host.externalSessionId?.(nativeId)??nativeId;
  const terminals=new Map<string,Map<string,OwnedTerminal>>();const closed=new Map<string,Set<string>>();const pending=new Map<string,Promise<unknown>>();
  const endpoints=["terminal/environment","terminal/shells","terminal/list","terminal/create","terminal/retain","terminal/follow","terminal/write","terminal/resize","terminal/rename","terminal/close"];
  function collection(sessionId:string){let result=terminals.get(sessionId);if(!result){result=new Map();terminals.set(sessionId,result);}return result;}
  function tombstones(sessionId:string){let result=closed.get(sessionId);if(!result){result=new Set();closed.set(sessionId,result);}return result;}
  function lookup(sessionId:string,id:string){const terminal=collection(sessionId).get(id);if(!terminal||terminal.closed)throw new WorkspaceRemoteError("terminal/unavailable","Terminal is closing or unavailable");return terminal;}
  function broadcast(terminal:OwnedTerminal,frame:Frame){for(const follower of terminal.followers)follower.push(frame);}
  function enqueue<T>(terminal:OwnedTerminal,operation:()=>Promise<T>|T):Promise<T>{const result=terminal.tail.then(operation);terminal.tail=result.then(()=>{},()=>{});return result;}
  async function discover(signal:AbortSignal):Promise<TerminalShell[]> {
    const candidates=process.platform==="win32"?[resolve(process.env.SystemRoot??"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe"),resolve(process.env.SystemRoot??"C:\\Windows","System32","cmd.exe")]:["/bin/bash","/bin/sh","/usr/bin/zsh","/usr/bin/fish"];
    const shells:TerminalShell[]=[];for(const path of candidates){signal.throwIfAborted();try{await access(path,constants.X_OK);const absolute=await realpath(path);if(!shells.some(shell=>shell.path===absolute))shells.push({path:absolute,args:[],name:basename(path)});}catch(error){if(signal.aborted)throw error;if(!["ENOENT","EACCES"].includes(String((error as NodeJS.ErrnoException).code)))throw error;}}
    if(!shells.length)throw new WorkspaceRemoteError("terminal/unavailable","No installed shell was discovered");return shells;
  }
  async function closeProcess(terminal:OwnedTerminal):Promise<void> {
    if(terminal.closing)return terminal.closing;
    terminal.closed=true;if(terminal.timer)clearTimeout(terminal.timer);
    const cleanup=(async()=>{
      if(!terminal.processExited) {
        // The verified PID namespace owns all descendants. Terminating its
        // wrapper tears down that namespace, including background children.
        terminal.pty.kill("SIGTERM");
        const wait=async(ms:number)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([terminal.exited.then(()=>true),new Promise<boolean>(done=>{timer=setTimeout(()=>done(false),ms);})]);}finally{if(timer)clearTimeout(timer);}};
        if(!await wait(1000)){terminal.pty.kill("SIGKILL");if(!await wait(2000))throw new Error("Terminal process cleanup is not confirmed");}
      }
      await terminal.tail;for(const follower of terminal.followers)follower.close();terminal.followers.clear();terminal.screen.dispose();
    })();terminal.closing=cleanup;
    try{await cleanup;}catch(error){terminal.closing=undefined;terminal.info={...terminal.info,state:"failed",error:error instanceof Error?error.message:String(error)};broadcast(terminal,{type:"state",info:terminal.info});throw error;}
  }
  function toolFailure(error:unknown,signal:AbortSignal):ToolResult {return{status:signal.aborted?"cancelled":"failed",error:{code:"PROCESS_ERROR",message:error instanceof Error?error.message:String(error),retryable:false,safeToRetry:false},metadata:{remoteCode:error instanceof WorkspaceRemoteError?error.code:"terminal/unavailable",details:error instanceof WorkspaceRemoteError?error.details:{}}};}
  const createSchema=z.object({command:z.string().min(1),id:z.string(),cols:z.number().int(),rows:z.number().int(),shellPath:z.string().optional()}).strict();
  const createTool:ToolDefinition={name:"web_terminal_create",description:"Start an interactive shell confined to this session workspace with network disabled. Input can run commands within that confined process namespace.",inputSchema:createSchema,risk:"elevated",metadata:{name:"web_terminal_create",version:"1.0.0",sideEffect:true,filesystem:false,network:false,process:true,interactive:true,retry:"unknown"},async execute(raw,context){
    const input=createSchema.parse(raw);let terminal:OwnedTerminal|undefined;
    try {
      const id=identity(input.id,"terminal id");const size=dimensions(input.cols,input.rows);const owner=collection(logicalId(context.sessionId));
      if(tombstones(logicalId(context.sessionId)).has(id))throw new WorkspaceRemoteError("terminal/unavailable","Closed terminal identities cannot be recreated");
      const existing=owner.get(id);if(existing)return{status:"success",output:existing.info};
      const limit=Math.min(8,context.sandboxPolicy.process.maxProcesses??8);if(new Set([...owner.keys(),...Array.from(pending.keys()).filter(key=>key.startsWith(`${logicalId(context.sessionId)}/`)).map(key=>key.slice(logicalId(context.sessionId).length+1))]).size>limit || owner.size>=limit)throw new WorkspaceRemoteError("terminal/limit-reached","Session terminal limit reached",{limit});
      const policy=context.sandboxPolicy;
      if(policy.filesystem.mode==="read-only"||policy.process.allowedCommands?.length||policy.process.deniedSurfaces?.length)throw new WorkspaceRemoteError("terminal/unavailable","The session process policy cannot safely serve arbitrary PTY input");
      const cwd=await resolveExecCwd(undefined,context.cwd);
      const filesystemGate=new SandboxManager(context.cwd,context.cwd,policy).checkWrite(cwd);
      if(!filesystemGate.allowed)throw new WorkspaceRemoteError("terminal/unavailable",filesystemGate.reason);
      const shells=await discover(context.signal);const shell=shells.find(shell=>shell.path===input.command && (input.shellPath===undefined || input.shellPath===shell.path));
      if(!shell)throw new WorkspaceRemoteError("terminal/unavailable","Shell was not returned by shell discovery");
      const timeoutMs=policy.process.timeoutMs??7_200_000;
      // Always require actual isolation, including interactive profiles whose
      // ordinary exec tool uses a weaker static policy.
      const prepared=await prepareSandboxedExec({confinement:"strong",workspaceRoot:cwd,cwd,command:shell.path,timeoutMs,maxOutputBytes:policy.process.maxOutputBytes??MAX_BUFFER});
      context.signal.throwIfAborted();
      if(!prepared.ok)throw new WorkspaceRemoteError("terminal/unavailable",prepared.denial.reason,{code:prepared.denial.code,platform:process.platform});
      if(!prepared.backend.strongIsolation||prepared.backend.wrapperArgv(prepared.policy).length===0)throw new WorkspaceRemoteError("terminal/unavailable","PTY provider has no verified process confinement wrapper");
      const launch=buildSandboxLaunch(prepared.backend,prepared.policy,shell.path,shell.args,{PATH:process.env.PATH??"/usr/bin:/bin",LANG:process.env.LANG??"C.UTF-8",TERM:"xterm-256color"},cwd);
      const [{spawn},headless,serialize]=await Promise.all([import("node-pty"),import("@xterm/headless"),import("@xterm/addon-serialize")]);context.signal.throwIfAborted();
      const Headless=headless.Terminal??(headless as unknown as {default:{Terminal:typeof headless.Terminal}}).default.Terminal;
      const Serialize=serialize.SerializeAddon??(serialize as unknown as {default:{SerializeAddon:typeof serialize.SerializeAddon}}).default.SerializeAddon;
      const screen=new Headless({...size,scrollback:1000,allowProposedApi:true});const serializer=new Serialize();screen.loadAddon(serializer);
      const pty=spawn(launch.file,launch.args,{...size,cwd:launch.cwd,env:launch.env,name:"xterm-256color"});
      let resolveExit!:()=>void;const exited=new Promise<void>(done=>{resolveExit=done;});
      terminal={info:{id,title:shell.name,shell,cwd,...size,state:"running",exitCode:null},pty,screen,serializer,sequence:0,followers:new Set(),tail:Promise.resolve(),exited,resolveExit,closed:false,processExited:false,bufferedBytes:0};
      const owned=terminal;
      const failOutput=(error:unknown)=>{
        owned.info={...owned.info,state:"failed",error:error instanceof Error?error.message:String(error)};broadcast(owned,{type:"state",info:owned.info});
        void closeProcess(owned).catch(cleanupError=>{owned.info={...owned.info,state:"failed",error:cleanupError instanceof Error?cleanupError.message:String(cleanupError)};broadcast(owned,{type:"state",info:owned.info});});
      };
      pty.onData(data=>{
        if(owned.closed)return;
        const bytes=Buffer.byteLength(data);
        if(owned.bufferedBytes+bytes>MAX_BUFFER){failOutput(new WorkspaceRemoteError("terminal/unavailable","Terminal output backlog exceeded its bounded buffer"));return;}
        owned.bufferedBytes+=bytes;
        void enqueue(owned,async()=>{try{if(owned.closed)return;await new Promise<void>(done=>owned.screen.write(data,done));broadcast(owned,{type:"output",sequence:++owned.sequence,data});}finally{owned.bufferedBytes-=bytes;}}).catch(failOutput);
      });
      pty.onExit(({exitCode})=>{
        // Process death is independent of whether the screen parser has drained.
        owned.processExited=true;owned.resolveExit();
        void enqueue(owned,()=>{if(owned.timer)clearTimeout(owned.timer);owned.info={...owned.info,state:owned.info.state==="failed"?"failed":"exited",exitCode};broadcast(owned,{type:"state",info:owned.info});});
      });
      owned.timer=setTimeout(()=>{void closeProcess(owned).catch(error=>{owned.info={...owned.info,state:"failed",error:error instanceof Error?error.message:String(error)};broadcast(owned,{type:"state",info:owned.info});});},timeoutMs);owned.timer.unref();
      context.signal.throwIfAborted();if(tombstones(logicalId(context.sessionId)).has(id))throw new WorkspaceRemoteError("terminal/unavailable","Terminal was closed during allocation");owner.set(id,owned);
      return{status:"success",output:owned.info,metadata:{provenance:prepared.provenance,pid:pty.pid}};
    }catch(error){if(terminal){tombstones(logicalId(context.sessionId)).add(terminal.info.id);try{await closeProcess(terminal);}catch(cleanupError){collection(logicalId(context.sessionId)).set(terminal.info.id,terminal);return toolFailure(cleanupError,context.signal);}}return toolFailure(error,context.signal);}
  }};
  const controlsSchema=z.object({command:z.string(),operation:z.enum(["write","resize","rename","close"]),id:z.string(),attachmentId:z.string().optional(),data:z.string().optional(),cols:z.number().int().optional(),rows:z.number().int().optional(),title:z.string().optional()}).strict();
  const controlsTool:ToolDefinition={name:"web_terminal_control",description:"Control this session's existing confined terminal; close waits for actual process cleanup.",inputSchema:controlsSchema,risk:"elevated",metadata:{name:"web_terminal_control",version:"1.0.0",sideEffect:true,filesystem:false,network:false,process:true,interactive:true,retry:"unknown"},async execute(raw,context){try{
    const input=controlsSchema.parse(raw);const id=identity(input.id,"terminal id");
    if(input.operation==="close") {tombstones(logicalId(context.sessionId)).add(id);await pending.get(`${logicalId(context.sessionId)}/${id}`)?.catch(error=>{console.error("Terminal allocation failed during close",error instanceof Error?error.message:String(error));});const terminal=collection(logicalId(context.sessionId)).get(id);if(terminal){await closeProcess(terminal);collection(logicalId(context.sessionId)).delete(id);}return{status:"success"};}
    const terminal=lookup(logicalId(context.sessionId),id);
    await enqueue(terminal,()=>{context.signal.throwIfAborted();if(input.operation==="rename"){const title=text(input.title,"title").trim();if(title.length>120)throw new WorkspaceRemoteError("gateway/bad-request","Title exceeds 120 characters");terminal.info={...terminal.info,title};broadcast(terminal,{type:"state",info:terminal.info});return;}
      if(terminal.info.state!=="running")throw new WorkspaceRemoteError("terminal/control-unavailable","Terminal is not running",{reason:"not-running"});
      if(input.attachmentId!==terminal.info.controllerId)throw new WorkspaceRemoteError("terminal/control-unavailable","Terminal is controlled by another attachment",{reason:"read-only"});
      if(input.operation==="write"){if(typeof input.data!=="string"||Buffer.byteLength(input.data)>MAX_INPUT)throw new WorkspaceRemoteError("gateway/bad-request","Terminal input exceeds its byte cap");terminal.pty.write(input.data);}
      else{const size=dimensions(input.cols,input.rows);terminal.pty.resize(size.cols,size.rows);terminal.screen.resize(size.cols,size.rows);terminal.info={...terminal.info,...size};broadcast(terminal,{type:"state",info:terminal.info});}
    });return{status:"success"};
  }catch(error){return toolFailure(error,context.signal);}}};
  const discoverTool:ToolDefinition={name:"web_terminal_shells",description:"Discover executable shell profiles in the local process execution environment.",inputSchema:z.object({command:z.literal("shell-discovery")}).strict(),risk:"readonly",metadata:{name:"web_terminal_shells",version:"1.0.0",sideEffect:false,filesystem:true,network:false,process:true,interactive:false,retry:"safe",concurrencySafe:true},async execute(_input,context){try{return{status:"success",output:await discover(context.signal)};}catch(error){return toolFailure(error,context.signal);}}};
  for(const tool of [createTool,controlsTool,discoverTool])host.registerTool?.(tool);
  async function execute(sessionId:string,tool:ToolDefinition,args:Record<string,unknown>,signal:AbortSignal){signal.throwIfAborted();const result=await host.executeTool(sessionId,tool.name,args,signal) as ToolResult;if(result.status!=="success")throw new WorkspaceRemoteError(String(result.metadata?.remoteCode??(result.status==="denied"?"gateway/forbidden":result.status==="cancelled"?"gateway/cancelled":"terminal/unavailable")),result.error?.message??"Terminal operation failed",record(result.metadata?.details??{}));return result.output;}
  async function callRaw(endpoint:string,args:unknown,signal:AbortSignal):Promise<unknown>{
    signal.throwIfAborted();
    if(endpoint==="terminal/list"){const a=exact(args,["sessionId"]);const session=await requireFileSession(host,a.sessionId);return[...collection(session.id).values()].filter(t=>!t.closed||!t.processExited&&t.closing===undefined).map(t=>t.info);}
    const method=endpoint.split("/")[1];
    if(method==="environment"||method==="shells"){const a=exact(args,["agentId"]);const session=await requireFileSession(host,a.agentId);if(method==="environment")return{cwd:session.cwd,maxInputBytes:MAX_INPUT,maxCols:500,maxRows:200,scrollback:1000};return execute(session.id,discoverTool,{command:"shell-discovery"},signal);}
    if(method==="create") {
      const a=exact(args,["agentId","request"]);const session=await requireFileSession(host,a.agentId);const request=exact(a.request,["id","cols","rows","shellPath"],["id","cols","rows"]);identity(request.id,"terminal id");dimensions(request.cols,request.rows);
      const key=`${session.id}/${request.id}`;const current=pending.get(key);if(current)return current;
      const task=(async()=>{const shells=await execute(session.id,discoverTool,{command:"shell-discovery"},signal) as TerminalShell[];const shell=request.shellPath===undefined?shells[0]:shells.find(item=>item.path===request.shellPath);if(!shell)throw new WorkspaceRemoteError("terminal/unavailable","Requested shell is not installed");return execute(session.id,createTool,{...request,command:shell.path},signal);})();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
    }
    if(["write","resize","rename","close"].includes(method??"")) {
      const keys=method==="write"?["agentId","id","attachmentId","data"]:method==="resize"?["agentId","id","attachmentId","cols","rows"]:method==="rename"?["agentId","id","title"]:["agentId","id"];
      const a=exact(args,keys);const session=await requireFileSession(host,a.agentId);const id=identity(a.id,"terminal id");
      // Each input/control is checked by the same session permission engine.
      // Input is an opaque byte operation on an already isolated PTY, and is
      // never interpreted as a host command by this service.
      const terminal=collection(session.id).get(id);const command=terminal?.info.shell.path??"terminal-close";
      return execute(session.id,controlsTool,{...Object.fromEntries(Object.entries(a).filter(([key])=>key!=="agentId")),command,operation:method},signal);
    }
    throw new WorkspaceRemoteError("gateway/not-found","Unknown terminal endpoint");
  }
  async function call(endpoint:string,args:unknown,signal:AbortSignal):Promise<unknown>{
    if(host.withSessionLock!==undefined&&["terminal/create","terminal/write","terminal/resize","terminal/rename","terminal/close"].includes(endpoint)){
      const sessionId=text(record(args).agentId,"agentId");
      return host.withSessionLock(sessionId,()=>callRaw(endpoint,args,signal));
    }
    return callRaw(endpoint,args,signal);
  }
  async function* stream(endpoint:string,args:unknown,signal:AbortSignal):AsyncIterable<unknown>{
    signal.throwIfAborted();
    if(endpoint==="terminal/retain"){const a=exact(args,["sessionId","id"]);const session=await requireFileSession(host,a.sessionId);lookup(session.id,identity(a.id,"terminal id"));yield{type:"retained"};await new Promise<void>(done=>{if(signal.aborted)done();else signal.addEventListener("abort",()=>done(),{once:true});});return;}
    if(endpoint!=="terminal/follow")throw new WorkspaceRemoteError("gateway/not-found","Unknown terminal stream");const a=exact(args,["agentId","id","attachmentId"]);const session=await requireFileSession(host,a.agentId);const id=identity(a.id,"terminal id"),attachmentId=identity(a.attachmentId,"attachment id");const terminal=lookup(session.id,id);const follower=new Follower();
    const baseline=await enqueue(terminal,()=>{signal.throwIfAborted();if(terminal.closed)throw new WorkspaceRemoteError("terminal/unavailable","Terminal closed during attachment");terminal.info={...terminal.info,controllerId:attachmentId};broadcast(terminal,{type:"state",info:terminal.info});terminal.followers.add(follower);return{type:"snapshot",sequence:terminal.sequence,screen:terminal.serializer.serialize(),info:terminal.info};});
    try{yield baseline;yield* follower.read(signal);}finally{terminal.followers.delete(follower);follower.close();await enqueue(terminal,()=>{if(terminal.info.controllerId===attachmentId){const {controllerId:_controller,...info}=terminal.info;terminal.info=info;broadcast(terminal,{type:"state",info});}});}
  }
  return{endpoints,call,stream,tools:[createTool,controlsTool,discoverTool],
    async closeSession(sessionId:string,signal:AbortSignal):Promise<void>{
      const session=await requireFileSession(host,sessionId);
      const ids=new Set([...collection(session.id).keys(),...Array.from(pending.keys()).filter(key=>key.startsWith(`${session.id}/`)).map(key=>key.slice(session.id.length+1))]);
      for(const id of ids)await call("terminal/close",{agentId:session.id,id},signal);
    },
    async dispose(){const results=await Promise.allSettled([...terminals.values()].flatMap(owner=>[...owner.values()].map(closeProcess)));const failures=results.filter(result=>result.status==="rejected");if(failures.length)throw new AggregateError(failures.map(result=>(result as PromiseRejectedResult).reason),"Terminal process cleanup failed");terminals.clear();},
    active(sessionId:string){
      const rows=new Map([...collection(sessionId).values()].filter(t=>!t.processExited).map(t=>[t.info.id,{id:t.info.id,label:t.info.title}]));
      for(const key of pending.keys())if(key.startsWith(`${sessionId}/`)){const id=key.slice(sessionId.length+1);if(!rows.has(id))rows.set(id,{id,label:"Terminal allocation"});}
      return[...rows.values()];
    }};
}
