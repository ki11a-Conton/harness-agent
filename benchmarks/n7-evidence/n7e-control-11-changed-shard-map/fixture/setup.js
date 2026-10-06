"use strict";
const fs = require("node:fs");
const shards = { alpha: 3, beta: 7 };
fs.writeFileSync("data/shards.json", JSON.stringify({ shards }));
console.log("shards=" + Object.keys(shards).length);
