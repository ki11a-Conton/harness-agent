import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { annotationPackets } from './windows-acceptance-report.mjs';
const root = '.ci/paired-original';
async function locate(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p=join(dir,e.name); if(e.isDirectory()){const r=await locate(p);if(r)return r;} else if(e.name==='http-service-5-candidate.json')return p; } }
const path=await locate(root);if(!path)throw new Error('Original failed arm missing');
const bytes=await readFile(path);const r=JSON.parse(bytes);if(r.source!=='8bff2e03c743b0adc1e06bbb3b0c51f54b38b0da'||r.id!=='http-service-5-candidate')throw new Error('Original identity mismatch');
const record={originalSource:r.source,originalId:r.id,rawReportSha256:createHash('sha256').update(bytes).digest('hex'),rawReportBytes:bytes.length,originalCommandsRerun:false,
 startedAt:r.startedAt,starts:r.starts,exits:r.exits,outcome:r.outcome,independentExit:r.independentExit,timeline:r.timeline,
 events:r.events.filter(e=>e.type.startsWith('tool.')||e.type.startsWith('verification.')||e.type.startsWith('command.')),
 requestsLastTool:r.requests.map(q=>q.messages.filter(m=>m.role==='tool').at(-1)),cleanupAlive:r.cleanupAlive};
const dir='.ci/paired-original-diagnostic';await mkdir(dir,{recursive:true});await writeFile(join(dir,'receipt.json'),JSON.stringify(record,null,2));
const packets=annotationPackets([record]);if(packets.length>9)throw new Error('Diagnostic exceeds lossless notice budget');
for(const p of packets)console.log(`::notice title=Original managed HTTP arm ${p.index+1}/${p.total}::${JSON.stringify(p)}`);
