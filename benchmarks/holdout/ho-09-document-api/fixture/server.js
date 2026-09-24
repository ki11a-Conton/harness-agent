const http = require('http');
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/items') { res.writeHead(200); res.end('[]'); return; }
  if (req.method === 'POST' && req.url === '/items') { res.writeHead(201); res.end('{}'); return; }
  res.writeHead(404); res.end();
});
module.exports = server;
