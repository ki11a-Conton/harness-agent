"use strict";
const fs = require("node:fs");
const rows = [1, 2, 3, 4, 5];
fs.writeFileSync("data/current.json", JSON.stringify({ rows }));
console.log("rows=" + rows.length);
