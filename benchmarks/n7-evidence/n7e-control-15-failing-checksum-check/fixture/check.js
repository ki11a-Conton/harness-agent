"use strict";
const { checksum } = require("./src/checksum.js");
const got = checksum("abc");
if (got !== 43430) {
  console.error("expected 43430 for abc, got " + got);
  process.exit(1);
}
console.log("ok");
