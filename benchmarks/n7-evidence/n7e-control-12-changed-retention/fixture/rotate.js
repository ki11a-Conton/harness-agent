"use strict";
const fs = require("node:fs");
const days = 365;
fs.writeFileSync("policy/retention.json", JSON.stringify({ days }));
console.log("days=" + days);
