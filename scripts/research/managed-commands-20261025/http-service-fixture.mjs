// A real service lives until its request finishes or its production command
// owner terminates it. Do not add a shorter independent expiry: Windows tool
// scheduling can consume that margin while the original 5s budget still holds.
// The baseline's synchronous exec reaches that same owner deadline; candidate
// exec_start permits the real read/probe and closes the server after its reply.
export const HTTP_SERVICE_FIXTURE_SOURCE = String.raw`const fs=require('node:fs'),http=require('node:http');
fs.appendFileSync('starts.jsonl',JSON.stringify({pid:process.pid,at:Date.now()})+'\n');
const server=http.createServer((req,res)=>{
  fs.writeFileSync('api-observed.json',JSON.stringify({url:req.url,at:Date.now()}));
  res.setHeader('Connection','close');res.once('finish',()=>server.close());res.end('ACTUAL_API_OK');
});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync('port.txt',String(server.address().port));console.log('LISTENING '+server.address().port)});
process.on('exit',()=>fs.appendFileSync('exits.jsonl',JSON.stringify({code:process.exitCode??0,at:Date.now()})+'\n'));
`;
