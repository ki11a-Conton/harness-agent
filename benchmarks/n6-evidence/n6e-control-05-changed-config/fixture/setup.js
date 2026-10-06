"use strict";
const fs = require("node:fs");
const next = { port: 4310 };
fs.writeFileSync("src/config.js", '"use strict";\nmodule.exports = { port: ' + next.port + " };\n");
console.log("port=" + next.port);
