"use strict";
const { fee } = require("./src/fee.js");
const got = fee(10000);
if (got !== 290) {
  console.error("expected 290 for 10000 cents at 2.9 percent, got " + got);
  process.exit(1);
}
console.log("ok");
