"use strict";
const assert = require("node:assert");
const { mergeIntervals } = require("./src/ranges.js");
assert.deepStrictEqual(mergeIntervals([[1, 3], [2, 6], [8, 10], [15, 18]]), [[1, 6], [8, 10], [15, 18]]);
console.log("ok");
