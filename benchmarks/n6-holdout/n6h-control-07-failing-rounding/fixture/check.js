"use strict";
const assert = require("node:assert");
const { roundHalfToEven } = require("./src/round.js");
assert.strictEqual(roundHalfToEven(2.5), 2);
assert.strictEqual(roundHalfToEven(3.5), 4);
console.log("ok");
