"use strict";
const assert = require("node:assert");
const { dedupe } = require("./src/dedupe.js");
assert.deepStrictEqual(dedupe(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
console.log("ok");
