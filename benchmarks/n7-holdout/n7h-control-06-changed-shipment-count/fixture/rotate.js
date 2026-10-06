"use strict";
const fs = require("node:fs");
const count = 41;
fs.writeFileSync("data/shipment.json", JSON.stringify({ count }));
console.log("count=" + count);
