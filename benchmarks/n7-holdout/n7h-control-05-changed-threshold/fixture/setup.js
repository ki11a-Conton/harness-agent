"use strict";
const fs = require("node:fs");
const threshold = 88;
fs.writeFileSync("config/threshold.json", JSON.stringify({ threshold }));
console.log("threshold=" + threshold);
