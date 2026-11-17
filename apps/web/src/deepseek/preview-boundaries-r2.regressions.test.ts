import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import type { ToolExecutionContext } from '@ar/contracts';
import { workspaceReadTool,workspaceMkdirTool } from './files.js';
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>(),open:(...a:Parameters<typeof fs.open>)=>fs.open(...a),mkdir:(...a:Parameters<typeof fs.mkdir>)=>fs.mkdir(...a)}));
let root:string;
beforeEach(async()=>{root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'web-preview-r2-')))});
afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50})});
const ctx=(signal=new AbortController().signal)=>({cwd:root,signal} as ToolExecutionContext);
it('Web preview of sixteen million short lines keeps observed heap allocation below 64MiB',async()=>{
 const path=join(root,'many.txt');await fs.writeFile(path,'first\n'+'\n'.repeat(16_000_000));
 const program=`import {workspaceReadTool} from ${JSON.stringify(new URL('../../dist/deepseek/files.js',import.meta.url).href)};let peak=0;const length=Buffer.byteLength;Buffer.byteLength=(...args)=>{peak=Math.max(peak,process.memoryUsage().heapUsed);return length(...args)};const r=await workspaceReadTool.execute({path:process.argv[1],operation:'read',offset:2,limit:3},{cwd:process.argv[2],signal:new AbortController().signal});if(r.status!=='success')throw new Error(JSON.stringify(r));console.log(JSON.stringify({output:r.output,peak}));`;
 const child=await promisify(execFile)(process.execPath,['--max-old-space-size=64','--input-type=module','-e',program,path,root],{timeout:20000,maxBuffer:65536});
 const observed=JSON.parse(child.stdout);expect(observed.output).toMatchObject({offset:2,text:'\n\n',lines:3,eof:false});expect(observed.peak).toBeLessThanOrEqual(64*1024*1024);
});
it('short native preview reads retain one bounded buffer rather than one allocation per fragment',async()=>{
 const path=join(root,'short.txt'),body='normal line\n'.repeat(30);await fs.writeFile(path,body);const open=fs.open.bind(fs);
 vi.spyOn(fs,'open').mockImplementation(async(...a)=>{const file=await open(...a);if(String(a[0])===path){const read=file.read.bind(file);vi.spyOn(file,'read').mockImplementation((async(buffer:Buffer,offset:number,length:number,position:number)=>read(buffer,offset,Math.min(length,17),position)) as typeof file.read);}return file;});
 const allocate=vi.spyOn(Buffer,'alloc');const result=await workspaceReadTool.execute({path,operation:'read',limit:2},ctx());
 expect(result).toMatchObject({status:'success',output:{text:'normal line\nnormal line',lines:2,eof:false}});
 const allocated=allocate.mock.calls.reduce((n,a)=>n+a[0],0);expect(allocated).toBeLessThanOrEqual(128*1024);
});
it.each([
 {text:'',offset:1,limit:3,expected:{text:'',lines:0,eof:true}},
 {text:'\n',offset:1,limit:3,expected:{text:'',lines:1,eof:true}},
 {text:'a\n\n',offset:2,limit:1,expected:{text:'',lines:1,eof:true}},
 {text:'a\nb',offset:1,limit:1,expected:{text:'a',lines:1,eof:false}},
 {text:'a\nb\n',offset:3,limit:1,expected:{text:'',lines:0,eof:true}},
 {text:'\ufeff汉字\r\n😀\nlast',offset:1,limit:2,expected:{text:'汉字\r\n😀',lines:2,eof:false}},
])('preview preserves actual page boundaries: %j',async({text,offset,limit,expected})=>{
 const path=join(root,'page.txt');await fs.writeFile(path,text);expect(await workspaceReadTool.execute({path,operation:'read',offset,limit},ctx())).toMatchObject({status:'success',output:expected});
});
it('preview limits and complete-snapshot credential policy still reject unsafe output',async()=>{
 const path=join(root,'large.txt');await fs.writeFile(path,'x'.repeat(2*1024*1024+1));expect((await workspaceReadTool.execute({path,operation:'read'},ctx())).status).toBe('failed');
 await fs.writeFile(path,'visible\n'+'ghp_'+'a'.repeat(36));expect(await workspaceReadTool.execute({path,operation:'read',limit:1},ctx())).toMatchObject({status:'failed',metadata:{remoteCode:'gateway/forbidden'}});
 await fs.writeFile(path,Buffer.from([255,65]));expect((await workspaceReadTool.execute({path,operation:'read'},ctx())).status).toBe('failed');
});
it('a directory created before cancellation is reported as committed instead of cancelled',async()=>{
 const controller=new AbortController(),mkdir=fs.mkdir.bind(fs),target=join(root,'created');
 vi.spyOn(fs,'mkdir').mockImplementation((async(...a:Parameters<typeof fs.mkdir>)=>{const result=await mkdir(...a);if(String(a[0])===target)controller.abort();return result;}) as typeof fs.mkdir);
 expect(await workspaceMkdirTool.execute({path:root,name:'created'},ctx(controller.signal))).toMatchObject({status:'success',output:target});expect((await fs.stat(target)).isDirectory()).toBe(true);
});
it('pre-cancelled directory creation creates nothing and existing directories still fail',async()=>{
 const c=new AbortController();c.abort();expect((await workspaceMkdirTool.execute({path:root,name:'absent'},ctx(c.signal))).status).toBe('cancelled');expect(await fs.stat(join(root,'absent')).catch(e=>e.code)).toBe('ENOENT');
 await fs.mkdir(join(root,'exists'));expect((await workspaceMkdirTool.execute({path:root,name:'exists'},ctx())).status).toBe('failed');
});
