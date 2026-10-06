"use strict";
const fs = require("node:fs");
const region = "eu-west-2";
fs.writeFileSync("src/env.js", '"use strict";\nmodule.exports = { region: ' + JSON.stringify(region) + " };\n");
console.log("region=" + region);
