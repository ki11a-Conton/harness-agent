import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFileTool } from './tools/write-file.js';
import { WorkspaceChangeTransaction } from './transaction.js';
import type { ToolExecutionContext } from '@ar/contracts';
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), stat: (...a: Parameters<typeof fs.stat>) => fs.stat(...a) }));
let root: string;
beforeEach(async()=>{root=await fs.mkdtemp(join(tmpdir(),'write-r2-'));});
afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});});
const context=()=>({cwd:root,signal:new AbortController().signal} as ToolExecutionContext);
it('write safety survives a failed path stat without destroying the actual large file',async()=>{
 const path=join(root,'source.txt'),body='original'.repeat(1024);await fs.writeFile(path,body);
 const stat=fs.stat.bind(fs);vi.spyOn(fs,'stat').mockImplementation(((p:Parameters<typeof fs.stat>[0],...a:unknown[])=>String(p)===path?Promise.reject(Object.assign(new Error('metadata outage'),{code:'EIO'})):Reflect.apply(stat,fs,[p,...a])) as typeof fs.stat);
 const result=await writeFileTool.execute({path,content:'tiny'},context());
 expect(result.status).not.toBe('success');expect(await fs.readFile(path,'utf8')).toBe(body);
});
it('write safety checks a large file created between writable open and exclusive creation',async()=>{
 const path=join(root,'raced.txt'),body='racing owner'.repeat(1024),open=fs.open.bind(fs);let injected=false;
 vi.spyOn(fs,'open').mockImplementation(async(...a)=>{try{return await open(...a);}catch(e){if(!injected&&String(a[0])===path&&(Number(a[1])&constants.O_WRONLY)!==0&&(Number(a[1])&constants.O_CREAT)===0){injected=true;await fs.writeFile(path,body);}throw e;}});
 const result=await writeFileTool.execute({path,content:'tiny'},context());
 expect(injected).toBe(true);expect(result.status).toBe('denied');expect(await fs.readFile(path,'utf8')).toBe(body);
});
it.each([false,true])('write rejects unpaired surrogate without touching existing bytes, append=%s',async append=>{
 const path=join(root,'existing.txt');await fs.writeFile(path,'before');
 const result=await writeFileTool.execute({path,content:'broken\ud800',append},context());
 expect(result.status).toBe('failed');expect(result.error?.message).toMatch(/Unicode|surrogate/i);expect(await fs.readFile(path,'utf8')).toBe('before');
});
it('invalid text cannot create parent directories or a file',async()=>{
 const path=join(root,'missing','new.txt');const result=await writeFileTool.execute({path,content:'\udc00'},context());
 expect(result.status).toBe('failed');expect(await fs.stat(join(root,'missing')).catch(e=>e.code)).toBe('ENOENT');
});
it.each(['utf8','utf-8'] as const)('UTF8 transaction rejects lossy new content before staging or writing: %s',async encoding=>{
 const tx=new WorkspaceChangeTransaction({root,encoding});
 await expect((async()=>{await tx.snapshot([{path:'nested/new.txt',content:'\ud800'}]);await tx.commit();})()).rejects.toThrow(/Unicode|surrogate/i);
 expect(tx.entries()).toEqual([]);expect(await fs.stat(join(root,'nested')).catch(e=>e.code)).toBe('ENOENT');
});
it('valid Unicode, explicit replacement characters, append and non-UTF8 transaction remain supported',async()=>{
 const path=join(root,'normal.txt');expect((await writeFileTool.execute({path,content:'汉字😀�\r\n'},context())).status).toBe('success');
 expect((await writeFileTool.execute({path,content:'tail',append:true},context())).status).toBe('success');expect(await fs.readFile(path,'utf8')).toBe('汉字😀�\r\ntail');
 const tx=new WorkspaceChangeTransaction({root,encoding:'latin1'});await tx.snapshot([{path:'latin.txt',content:'ÿ'}]);await tx.commit();expect(await fs.readFile(join(root,'latin.txt'))).toEqual(Buffer.from([255]));
});
