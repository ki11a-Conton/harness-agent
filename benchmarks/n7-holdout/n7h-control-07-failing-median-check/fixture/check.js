"use strict";
const { median } = require("./lib/median.js");
const a = median([3, 1, 2]);
const b = median([4, 1, 3, 2]);
if (a !== 2 || b !== 2.5) {
  console.error("expected median 2 and 2.5, got " + a + " and " + b);
  process.exit(1);
}
console.log("ok");
