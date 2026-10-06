"use strict";
const assert = require("node:assert");
const { rotate } = require("./lib/rotate.js");
assert.deepStrictEqual(rotate([1, 2, 3, 4, 5], 2), [3, 4, 5, 1, 2]);
assert.deepStrictEqual(rotate([1, 2, 3], 4), [2, 3, 1]);
console.log("ok");
