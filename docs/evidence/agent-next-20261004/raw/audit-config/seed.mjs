import {JsonlMemoryStore} from '/workspace/harness-agent/packages/memory/dist/memory-store.js';
import {newMemoryId,newSessionId} from '/workspace/harness-agent/packages/contracts/dist/index.js';
const now=Date.now();const store=new JsonlMemoryStore({dataDir:process.argv[2]});
await store.write({id:newMemoryId(),sourceSession:newSessionId(),content:'RecallProbe user preference: concise review notes in numbered steps.',type:'explicit',scope:'global',importance:0.9,confidence:0.9,novelty:0.9,stability:0.9,createdAt:now,updatedAt:now,deleted:false});
