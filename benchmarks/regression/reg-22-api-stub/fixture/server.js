const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});

module.exports = server;
