"use strict";
const fs = require("node:fs");
const items = ["a", "b", "c", "d", "e", "f", "g"];
fs.writeFileSync("data/catalog.json", JSON.stringify({ items }));
console.log("items=" + items.length);
