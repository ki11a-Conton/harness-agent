"use strict";
const fs = require("node:fs");
const ttl = 900;
fs.writeFileSync("config/token.json", JSON.stringify({ ttl_seconds: ttl }));
console.log("ttl=" + ttl);
