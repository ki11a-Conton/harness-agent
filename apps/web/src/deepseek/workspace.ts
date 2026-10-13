import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import type { Harness } from "@ar/harness";
import type { SessionId, ToolDefinition, ToolResult } from "@ar/contracts";
import { exact, inside, record, text, toolValue, WorkspaceRemoteError, workspaceReadTool, type WorkspaceFileHost } from "./files.js";

export interface WorkspaceView { workspaceId:string; path:string; title:string; sessionIds:string[]; createdAt:string; updatedAt:string }
export interface WorkspaceDocument { version:1; revision:number; items:WorkspaceView[]; archivedSessionIds:string[]; pinnedSessionIds:string[] }
export interface WorkspaceHost extends WorkspaceFileHost {
  dataDir?:string;
  harness:Harness;
  registerTool?(tool:ToolDefinition):void;
  executeHostTool?(sessionId:string|undefined,definition:ToolDefinition,args:Record<string,unknown>,signal:AbortSignal):Promise<ToolResult>;
  sessionActivity?(sessionId:string,signal:AbortSignal):Promise<Array<{kind:string;items?:Array<{id:string;label?:string}>}>>;
  stopSessionActivity?(sessionId:string,signal:AbortSignal):Promise<void>;
}
const empty = ():WorkspaceDocument => ({version:1,revision:0,items:[],archivedSessionIds:[],pinnedSessionIds:[]});
const documentSchema=z.object({version:z.literal(1),revision:z.number().int().nonnegative(),items:z.array(z.object({workspaceId:z.string().min(1),path:z.string().min(1),title:z.string().min(1),sessionIds:z.array(z.string()),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict()),archivedSessionIds:z.array(z.string()),pinnedSessionIds:z.array(z.string())}).strict();

/** One fixed host file, accessed only in the controlled metadata definitions. */
export function createWorkspaceMetadataStore(host:WorkspaceHost) {
  const path=resolve(host.dataDir ?? host.cwd,"deepseek","workspace-metadata.json");
  let memory=empty(); let chain=Promise.resolve();
  async function directory(signal:AbortSignal,create=false) {
    signal.throwIfAborted();
    const root=await realpath(host.dataDir ?? host.cwd);
    const directoryPath=dirname(path);
    if(create)await mkdir(directoryPath,{recursive:true,mode:0o700});
    const actual=await realpath(directoryPath);
    if(!inside(root,actual)||actual!==directoryPath||(await lstat(directoryPath)).isSymbolicLink())throw new Error("Workspace metadata directory is outside its fixed host root");
    signal.throwIfAborted();
  }
  async function load(signal:AbortSignal):Promise<WorkspaceDocument> {
    if(host.dataDir===undefined)return structuredClone(memory);
    try {
      await directory(signal);
      const file=await open(path,constants.O_RDONLY | (process.platform==="win32" ? 0:constants.O_NOFOLLOW|constants.O_NONBLOCK));
      try { const info=await file.stat();if(!info.isFile()||info.size>8*1024*1024)throw new Error("Invalid workspace metadata file");const raw=await file.readFile({encoding:"utf8",signal});return documentSchema.parse(JSON.parse(raw)); }
      finally{await file.close();}
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return empty();throw error;}
  }
  async function save(document:WorkspaceDocument,signal:AbortSignal) {
    if(host.dataDir===undefined){signal.throwIfAborted();memory=structuredClone(document);return;}
    await directory(signal,true);
    try{if((await lstat(path)).isSymbolicLink())throw new Error("Workspace metadata file is a symlink");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const temporary=`${path}.${randomUUID()}.tmp`;
    try {
      const file=await open(temporary,"wx",0o600);
      try{await file.writeFile(JSON.stringify(document));await file.sync();}finally{await file.close();}
      signal.throwIfAborted();await directory(signal);await rename(temporary,path);
      if(process.platform!=="win32"){const handle=await open(dirname(path),"r");try{await handle.sync();}finally{await handle.close();}}
    }finally{await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});}
  }
  const read:ToolDefinition={name:"web_workspace_metadata_read",description:"Read the web workspace registry at the fixed host metadata path.",inputSchema:z.object({path:z.literal(path)}).strict(),risk:"readonly",metadata:{name:"web_workspace_metadata_read",version:"1.0.0",filesystem:true,process:false,network:false,sideEffect:false,interactive:false,retry:"safe"},async execute(_input,context){try{return{status:"success",output:await load(context.signal)};}catch(error){return{status:context.signal.aborted?"cancelled":"failed",error:{code:"PERSISTENCE_ERROR",message:error instanceof Error?error.message:String(error),retryable:false,safeToRetry:false}};}}};
  const write:ToolDefinition={name:"web_workspace_metadata_write",description:"Atomically replace the web workspace registry with revision checking.",inputSchema:z.object({path:z.literal(path),expectedRevision:z.number().int().nonnegative(),document:documentSchema}).strict(),risk:"side_effect",metadata:{name:"web_workspace_metadata_write",version:"1.0.0",filesystem:true,process:false,network:false,sideEffect:true,interactive:false,retry:"safe"},async execute(raw,context){const input=raw as {expectedRevision:number;document:WorkspaceDocument};try{const current=await load(context.signal);if(current.revision!==input.expectedRevision)throw new WorkspaceRemoteError("workspace/conflict","Workspace registry revision changed");await save(input.document,context.signal);return{status:"success",output:input.document};}catch(error){return{status:context.signal.aborted?"cancelled":"failed",error:{code:"PERSISTENCE_ERROR",message:error instanceof Error?error.message:String(error),retryable:false,safeToRetry:false}};}}};
  async function invoke(tool:ToolDefinition,args:Record<string,unknown>,signal:AbortSignal):Promise<WorkspaceDocument> {
    if(!host.executeHostTool)throw new WorkspaceRemoteError("gateway/unavailable","Controlled host metadata executor is not configured");
    signal.throwIfAborted();const result=await host.executeHostTool(undefined,tool,{path,...args},signal);
    if(result.status!=="success")throw new WorkspaceRemoteError(result.status==="cancelled"?"gateway/cancelled":"gateway/internal",result.error?.message??"Workspace metadata operation failed");
    return documentSchema.parse(result.output);
  }
  return {
    path,tools:[read,write],
    async read(signal:AbortSignal){await chain;return invoke(read,{},signal);},
    async update(mutate:(document:WorkspaceDocument)=>void,signal:AbortSignal):Promise<WorkspaceDocument>{
      const result=chain.then(async()=>{signal.throwIfAborted();const current=await invoke(read,{},signal);const expectedRevision=current.revision;mutate(current);current.revision++;return invoke(write,{expectedRevision,document:current},signal);});chain=result.then(()=>{},()=>{});return result;
    }
  };
}

export function createWorkspaceService(host:WorkspaceHost) {
  const metadata=createWorkspaceMetadataStore(host);
  host.registerTool?.(workspaceReadTool);
  const endpoints=["workspace/create","workspace/initializeDefault","workspace/rename","workspace/delete","workspace/insertBefore","workspace/insertSessionBefore","workspace/archiveSession","workspace/unarchiveSession","workspace/pinSession","workspace/unpinSession","workspace/follow"];
  const now=()=>new Date().toISOString();
  function workspace(document:WorkspaceDocument,id:unknown):WorkspaceView {
    const workspaceId=text(id,"workspaceId");const row=document.items.find(item=>item.workspaceId===workspaceId);
    if(!row)throw new WorkspaceRemoteError("workspace/not-found","Workspace not found",{workspaceId});return row;
  }
  async function canonical(path:string,signal:AbortSignal):Promise<string> {
    // directoryList returns the actual canonical directory after read/sandbox gates.
    const result=record(await toolValue(host,undefined,workspaceReadTool.name,{operation:"directoryList",path},signal));return text(result.path,"canonical path");
  }
  async function accountSession(sessionId:string,cwd:string,workspaceId?:string,signal:AbortSignal=new AbortController().signal) {
    const session=await host.harness.store.getSession(sessionId as SessionId);if(!session||session.status==="failed")throw new WorkspaceRemoteError("session/not-found","Session not found",{sessionId});
    if(session.cwd!==cwd)throw new WorkspaceRemoteError("gateway/bad-request","Session working directory does not match its workspace");
    return metadata.update(document=>{
      const row=workspaceId===undefined?document.items.find(item=>item.path===cwd):workspace(document,workspaceId);
      if(!row)return;if(row.path!==cwd)throw new WorkspaceRemoteError("workspace/move-invalid","Session cwd differs from workspace",{workspaceId:row.workspaceId,sessionId});
      if(!row.sessionIds.includes(sessionId)){row.sessionIds.unshift(sessionId);row.updatedAt=now();}
    },signal);
  }
  async function reconcile(signal:AbortSignal) {
    const sessions=await host.harness.store.listSessions();const document=await metadata.read(signal);
    if(document.items.some(row=>sessions.some(session=>session.cwd===row.path&&session.status!=="failed"&&!row.sessionIds.includes(session.id)) || row.sessionIds.some(id=>!sessions.some(session=>session.id===id&&session.cwd===row.path&&session.status!=="failed")))) {
      return metadata.update(current=>{for(const row of current.items){const ids=new Set(row.sessionIds);for(const session of sessions.sort((a,b)=>a.createdAt-b.createdAt)){if(session.cwd===row.path&&session.status!=="failed"&&!ids.has(session.id)){row.sessionIds.unshift(session.id);ids.add(session.id);row.updatedAt=now();}}row.sessionIds=row.sessionIds.filter(id=>sessions.some(s=>s.id===id&&s.cwd===row.path&&s.status!=="failed"));}},signal);
    }
    return document;
  }
  async function activity(id:string,signal:AbortSignal):Promise<Array<{kind:string;items?:Array<{id:string;label?:string}>}>> {
    if(host.sessionActivity)return host.sessionActivity(id,signal);
    const sessions=await host.harness.store.listSessions();const descendants=new Set<string>([id]);let changed=true;
    while(changed){changed=false;for(const session of sessions){if(session.parentId&&descendants.has(session.parentId)&&!descendants.has(session.id)){descendants.add(session.id);changed=true;}}}
    const result:Array<{kind:string;items?:Array<{id:string;label?:string}>}>=[];const children:Array<{id:string}>=[];
    for(const child of descendants){
      signal.throwIfAborted();
      const turns=await host.harness.store.listTurns(child as SessionId);if(turns.some(turn=>["running","waiting_for_user","waiting_for_approval"].includes(turn.status))){if(child===id)result.push({kind:"turn"});else children.push({id:child});}
      const queued=(await host.harness.inbox.listAll(child as SessionId)).filter(prompt=>prompt.status!=="consumed");
      if(queued.length)result.push({kind:"queued-prompt",items:queued.map(prompt=>({id:prompt.id}))});
    }
    if(children.length)result.push({kind:"subagent",items:children});return result;
  }
  async function call(endpoint:string,args:unknown,signal:AbortSignal):Promise<unknown> {
    signal.throwIfAborted();
    if(endpoint==="workspace/initializeDefault") {
      exact(args,[]);const before=await reconcile(signal);if(before.items.length)return undefined;
      return call("workspace/create",{request:{path:host.cwd}},signal).then(value=>({workspace:record(value).workspace}));
    }
    const a=exact(args,["request"]);const input=record(a.request,"request");
    if(endpoint==="workspace/create") {
      const r=exact(input,["path"]);const path=await canonical(text(r.path,"path"),signal);let created=false;let selected:WorkspaceView|undefined;
      await metadata.update(document=>{selected=document.items.find(item=>item.path===path);if(selected)return;created=true;const instant=now();selected={workspaceId:randomUUID(),path,title:basename(path)||path,sessionIds:[],createdAt:instant,updatedAt:instant};document.items.push(selected);},signal);
      await reconcile(signal);const latest=await metadata.read(signal);return{workspace:latest.items.find(item=>item.workspaceId===selected?.workspaceId),created};
    }
    if(endpoint==="workspace/rename") {
      const r=exact(input,["workspaceId","title"]);const title=text(r.title,"title").trim();let selected:WorkspaceView|undefined;
      await metadata.update(document=>{selected=workspace(document,r.workspaceId);if(document.items.some(item=>item.workspaceId!==selected?.workspaceId&&item.title===title))throw new WorkspaceRemoteError("workspace/name-conflict","Workspace name is already in use",{name:title});selected.title=title;selected.updatedAt=now();},signal);return{workspace:selected};
    }
    if(endpoint==="workspace/delete") {const r=exact(input,["workspaceId"]);await metadata.update(document=>{const row=workspace(document,r.workspaceId);document.items=document.items.filter(item=>item.workspaceId!==row.workspaceId);},signal);return{deleted:true};}
    if(endpoint==="workspace/insertBefore") {
      const r=exact(input,["workspaceId","beforeWorkspaceId"],["workspaceId"]);const document=await metadata.update(document=>{const row=workspace(document,r.workspaceId);const anchor=r.beforeWorkspaceId===undefined?undefined:workspace(document,r.beforeWorkspaceId);if(anchor===row)return;document.items=document.items.filter(item=>item!==row);const index=anchor===undefined?document.items.length:document.items.indexOf(anchor);document.items.splice(index,0,row);},signal);return{workspaceIds:document.items.map(row=>row.workspaceId)};
    }
    if(endpoint==="workspace/insertSessionBefore") {
      const r=exact(input,["workspaceId","sessionId","beforeSessionId"],["workspaceId","sessionId"]);const id=text(r.sessionId,"sessionId");let selected:WorkspaceView|undefined;
      await metadata.update(document=>{selected=workspace(document,r.workspaceId);const before=r.beforeSessionId===undefined?undefined:text(r.beforeSessionId,"beforeSessionId");if(!selected.sessionIds.includes(id)||(before!==undefined&&!selected.sessionIds.includes(before)))throw new WorkspaceRemoteError("workspace/move-invalid","Session or anchor is not in this workspace",{workspaceId:selected.workspaceId,sessionId:id,...before?{beforeSessionId:before}:{}});if(before===id)return;selected.sessionIds=selected.sessionIds.filter(item=>item!==id);selected.sessionIds.splice(before===undefined?selected.sessionIds.length:selected.sessionIds.indexOf(before),0,id);selected.updatedAt=now();},signal);return{workspace:selected};
    }
    if(["workspace/archiveSession","workspace/unarchiveSession","workspace/pinSession","workspace/unpinSession"].includes(endpoint)) {
      const r=exact(input,endpoint==="workspace/archiveSession"?["sessionId","stopActivity"]:["sessionId"],["sessionId"]);const id=text(r.sessionId,"sessionId");const selected=await host.harness.store.getSession(id as SessionId);if(!selected||selected.status==="failed")throw new WorkspaceRemoteError("session/not-found","Session not found",{sessionId:id});
      if(r.stopActivity!==undefined&&typeof r.stopActivity!=="boolean")throw new WorkspaceRemoteError("gateway/bad-request","stopActivity must be a boolean");
      if(endpoint==="workspace/archiveSession") {
        const active=await activity(id,signal);
        if(active.length){if(r.stopActivity!==true)throw new WorkspaceRemoteError("workspace/session-active","Session has active work",{sessionId:id,activity:active});
          if(host.stopSessionActivity)await host.stopSessionActivity(id,signal);
          else {const ids=[id,...active.flatMap(item=>item.kind==="subagent"?item.items?.map(i=>i.id)??[]:[])];for(const owned of ids){const actor=await host.harness.sessions.load(owned as SessionId);await actor.interrupt();}}
          // Refuse durable uncertainty; archive must not claim unsuccessful cancellation.
          if((await activity(id,signal)).length)throw new WorkspaceRemoteError("workspace/session-active","Work remains active after cancellation",{sessionId:id,activity:await activity(id,signal)});
        }
      }
      const document=await metadata.update(document=>{
        if(endpoint==="workspace/archiveSession"){if(!document.archivedSessionIds.includes(id))document.archivedSessionIds.push(id);document.pinnedSessionIds=document.pinnedSessionIds.filter(item=>item!==id);}
        if(endpoint==="workspace/unarchiveSession")document.archivedSessionIds=document.archivedSessionIds.filter(item=>item!==id);
        if(endpoint==="workspace/pinSession"){if(document.archivedSessionIds.includes(id))throw new WorkspaceRemoteError("gateway/bad-request","Archived session cannot be pinned");document.pinnedSessionIds=[id,...document.pinnedSessionIds.filter(item=>item!==id)];}
        if(endpoint==="workspace/unpinSession")document.pinnedSessionIds=document.pinnedSessionIds.filter(item=>item!==id);
      },signal);return endpoint.includes("archive")?{archivedSessionIds:document.archivedSessionIds}:{pinnedSessionIds:document.pinnedSessionIds};
    }
    throw new WorkspaceRemoteError("gateway/not-found","Unknown workspace endpoint");
  }
  async function* stream(endpoint:string,args:unknown,signal:AbortSignal):AsyncIterable<unknown> {
    if(endpoint!=="workspace/follow")throw new WorkspaceRemoteError("gateway/not-found","Unknown workspace stream");exact(args,[]);signal.throwIfAborted();
    let prior=await reconcile(signal);yield{type:"baseline",value:{items:prior.items,archivedSessionIds:prior.archivedSessionIds,pinnedSessionIds:prior.pinnedSessionIds}};
    while(!signal.aborted){await new Promise<void>(done=>{const timer=setTimeout(finish,350);function finish(){clearTimeout(timer);signal.removeEventListener("abort",finish);done();}signal.addEventListener("abort",finish,{once:true});});if(signal.aborted)return;const next=await reconcile(signal);if(next.revision===prior.revision)continue;
      for(const row of prior.items)if(!next.items.some(item=>item.workspaceId===row.workspaceId))yield{type:"remove",workspaceId:row.workspaceId};
      for(const row of next.items)if(JSON.stringify(row)!==JSON.stringify(prior.items.find(item=>item.workspaceId===row.workspaceId)))yield{type:"upsert",workspace:row};
      if(JSON.stringify(next.items.map(row=>row.workspaceId))!==JSON.stringify(prior.items.map(row=>row.workspaceId)))yield{type:"order",workspaceIds:next.items.map(row=>row.workspaceId)};
      if(JSON.stringify(next.archivedSessionIds)!==JSON.stringify(prior.archivedSessionIds))yield{type:"archived",archivedSessionIds:next.archivedSessionIds};
      if(JSON.stringify(next.pinnedSessionIds)!==JSON.stringify(prior.pinnedSessionIds))yield{type:"pinned",pinnedSessionIds:next.pinnedSessionIds};prior=next;
    }
  }
  return {endpoints,call,stream,accountSession,metadata,async workspace(id?:string,signal:AbortSignal=new AbortController().signal){const document=await reconcile(signal);const row=id===undefined?document.items[0]:workspace(document,id);if(!row)throw new WorkspaceRemoteError("workspace/not-found","No workspace registered");return{id:row.workspaceId,path:row.path,title:row.title};},async getArchivedIds(signal:AbortSignal=new AbortController().signal){return(await metadata.read(signal)).archivedSessionIds;}};
}
