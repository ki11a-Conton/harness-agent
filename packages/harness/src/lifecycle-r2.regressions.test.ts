import { expect,it } from 'vitest';
import { Lifecycle,MemoryStoreCloser } from './lifecycle.js';
import type { MemoryStore } from '@ar/contracts';
it.each([undefined,null])('shutdown preserves the first rejection value and drains all resources: %s',async value=>{
 const order:string[]=[],l=new Lifecycle();l.add({close(){order.push('last');throw new Error('later');}});l.add({close(){order.push('first');return Promise.reject(value);}});
 const result=await l.close().then(()=>({ok:true,value:'unexpected'}),e=>({ok:false,value:e}));
 expect(result).toEqual({ok:false,value});expect(order).toEqual(['first','last']);
});
it('memory resource closure waits for the asynchronous store before closing its dependencies',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r});const order:string[]=[];const l=new Lifecycle();
 const store={async close(){order.push('memory-start');await gate;order.push('memory-end');}} as unknown as MemoryStore;
 l.add({close(){order.push('database');}});l.add(new MemoryStoreCloser(store));const closing=l.close();
 try {await Promise.resolve();await Promise.resolve();expect(order).toEqual(['memory-start']);}finally{release();await closing;}
 expect(order).toEqual(['memory-start','memory-end','database']);
});
it('synchronous close, original Error identity and stores without close remain compatible',async()=>{
 const l=new Lifecycle(),error=new Error('original');l.add(new MemoryStoreCloser({} as MemoryStore));l.add({close(){throw error;}});await expect(l.close()).rejects.toBe(error);
});
