"use strict";
const assert = require("node:assert");
const { windowed } = require("./src/windowed.js");
assert.deepStrictEqual(windowed([1, 2, 3, 4], 2), [[1, 2], [2, 3], [3, 4]]);
console.log("ok");
