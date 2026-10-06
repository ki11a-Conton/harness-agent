"use strict";
const fs = require("node:fs");
const next = "eu-west";
fs.writeFileSync("src/region.js", '"use strict";\nmodule.exports = { region: ' + JSON.stringify(next) + " };\n");
console.log("region=" + next);
