import {OpenAICompatibleProvider} from '/workspace/harness-agent/packages/model/dist/openai.js';
const provider=new OpenAICompatibleProvider({apiKey:'local-placeholder',baseUrl:process.argv[2],modelId:'system-serialization-probe',requestPolicy:{maxProviderRetries:0,retryDelayMs:0,requestTimeoutMs:5000}});
const client=provider.createClient({providerId:'openai',modelId:'system-serialization-probe'},{});
const msg=(role,content)=>({id:'message_fixture',sessionId:'session_fixture',role,content,createdAt:0});
const outputs=[];
for(const req of [{system:'TOPLEVEL_SYSTEM_中文marker',messages:[msg('user','USER_MARKER')]},{system:'TOPLEVEL_SYSTEM_中文marker',messages:[msg('system','HISTORY_SYSTEM_MARKER'),msg('user','USER_MARKER')]},{messages:[msg('system','HISTORY_SYSTEM_MARKER'),msg('user','USER_MARKER')]},{system:'',messages:[msg('user','USER_MARKER')]},{messages:[msg('user','USER_MARKER')]}]){
 const events=[];for await(const event of client.generate(req,new AbortController().signal))events.push(event);
 outputs.push({request:req,events});
}
console.log(JSON.stringify(outputs));
