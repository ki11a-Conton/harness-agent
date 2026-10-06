"use strict";
const { discounted } = require("./src/discount.js");
const got = discounted(1000, 10);
if (got !== 900) {
  console.error("expected 900 for 1000 cents at 10 percent, got " + got);
  process.exit(1);
}
console.log("ok");
