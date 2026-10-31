// Engineering-fixture coordination, not an agent capability or a model-quality
// benchmark. Keep native work and all production command/turn budgets unchanged.
import { createServer } from "node:http";
import { observeReadOverlap } from "./observe-read-overlap.mjs";

export const CHECK_BARRIER_URL_FILE = ".paired-check-read-barrier-url";
export const CHECK_WORK_MS = 2000;
export const CHECK_FIXTURE_SOURCE = `const fs=require('node:fs'),http=require('node:http');
fs.appendFileSync('starts.jsonl',JSON.stringify({pid:process.pid,at:Date.now()})+'\\n');console.log('STARTED');
const gate=new Promise((resolve,reject)=>{http.get(fs.readFileSync(${JSON.stringify(CHECK_BARRIER_URL_FILE)},'utf8').trim(),response=>{response.resume();response.on('error',reject);response.on('end',()=>response.statusCode===200?resolve():reject(new Error('read barrier refused')))}).on('error',reject)});
const work=new Promise(resolve=>setTimeout(()=>{fs.appendFileSync('native-work.jsonl',JSON.stringify({pid:process.pid,at:Date.now()})+'\\n');resolve()},${CHECK_WORK_MS}));
Promise.all([work,gate]).then(()=>{const ok=require('./source.cjs')===1;fs.appendFileSync('exits.jsonl',JSON.stringify({code:ok?0:1,at:Date.now()})+'\\n');console.log(ok?'CHECK_OK':'CHECK_FAILED');process.exitCode=ok?0:1}).catch(error=>{console.error(error);process.exitCode=1});
`;

/** Baseline releases before exec because its synchronous command cannot permit
 * a read during execution. Candidate release requires the actual correlated
 * successful source read, not STARTED, tool admission, or model scheduling.
 * Native work and the read gate run concurrently, so this does not add another
 * two-second delay after the read. A missing read still hits the original
 * production process/turn deadline; this helper supplies no fallback release. */
export async function createCheckReadBarrier({ sourcePath, preReleased = false }) {
  const responses = new Set();
  let released = preReleased, closed = false, closing;
  let releaseProof = preReleased ? { kind: "baseline-pre-released", at: Date.now() } : undefined;
  let connected;
  const connection = new Promise(resolve => { connected = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    if (request.url !== "/read-completed") { response.writeHead(404).end(); return; }
    responses.add(response);
    response.once("close", () => responses.delete(response));
    connected();
    if (released) response.end("actual read completed");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/read-completed`,
    connection,
    isReleased: () => released,
    releaseAfterSuccessfulRead(events, { sessionId, turnId }) {
      if (closed) throw new Error("read barrier is closed");
      if (released) return releaseProof;
      const read = observeReadOverlap({ events, sourcePath }).reads.find(
        read => read.sessionId === sessionId && read.turnId === turnId,
      );
      if (!read) throw new Error("read barrier requires a correlated successful source-file read");
      releaseProof = { kind: "correlated-successful-read", ...read, releasedAt: Date.now() };
      released = true;
      for (const response of responses) response.end("actual read completed");
      return releaseProof;
    },
    snapshot: () => ({ released, closed, releaseProof, pendingConnections: responses.size }),
    close() {
      if (closing) return closing;
      closed = true;
      closing = new Promise((resolve, reject) => {
        // A cleanup cannot manufacture a successful gate acknowledgement.
        for (const response of responses) response.destroy();
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
      });
      return closing;
    },
  };
}
