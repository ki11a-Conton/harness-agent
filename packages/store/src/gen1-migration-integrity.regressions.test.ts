import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT_ABI_VERSION, newEventId, newSessionId, type AgentEvent } from "@ar/contracts";
import { SqliteRuntimeStore } from "./sqlite-runtime-store.js";
import { migrateJsonlToSqlite } from "./migrate.js";

const roots: string[] = [], stores: SqliteRuntimeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gen1-migration-")); roots.push(root);
  const sessionDataDir = join(root,"sessions"), eventDataDir = join(root,"events");
  await mkdir(sessionDataDir); await mkdir(eventDataDir);
  const target = new SqliteRuntimeStore({dataDir:join(root,"target")}); stores.push(target);
  const sessionId = newSessionId();
  const event: AgentEvent = {id:newEventId(),sessionId,sequence:0,timestamp:1,type:"turn.started",payload:{},schemaVersion:EVENT_ABI_VERSION};
  return {source:{sessionDataDir,eventDataDir},target,sessionId,event};
}

describe("Gen1 migration never certifies missing or rejected source rows", () => {
  it.each([false,true])("rejects a non-directory source read instead of claiming an empty clean migration (dryRun=%s)", async dryRun => {
    const {source,target}=await fixture(); await writeFile(join(source.sessionDataDir,"sessions"),"not a directory");
    await expect(migrateJsonlToSqlite({source,target,dryRun})).rejects.toThrow(/migrate.*sessions/);
  });

  it.each([false,true])("marks unknown event ABI/wrapper and malformed payloads as bad source in dry/write mode (%s)", async dryRun => {
    const {source,target,sessionId,event}=await fixture();
    const rows=[{schemaVersion:1,event:{...event,schemaVersion:999}}, {schemaVersion:999,event}, {schemaVersion:1,event:null}];
    await writeFile(join(source.eventDataDir,`${sessionId}.jsonl`),rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
    const result=await migrateJsonlToSqlite({source,target,dryRun});
    expect(result).toMatchObject({events:0,allSourcesClean:false});
    expect(await target.list(sessionId)).toEqual([]);
  });

  it("propagates a real closed-database target failure rather than counting an unwritten row as success", async () => {
    const {source,target,sessionId,event}=await fixture();
    await writeFile(join(source.eventDataDir,`${sessionId}.jsonl`),JSON.stringify({schemaVersion:1,event})+"\n");
    target.close();
    await expect(migrateJsonlToSqlite({source,target})).rejects.toThrow(/closed|not open/i);
  });
});
