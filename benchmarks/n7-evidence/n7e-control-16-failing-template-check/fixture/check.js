"use strict";
const { render } = require("./src/template.js");
const got = render("a {{x}} b {{x}} c {{y}}", { x: 1 });
if (got !== "a 1 b 1 c {{y}}") {
  console.error("unexpected render output: " + JSON.stringify(got));
  process.exit(1);
}
console.log("ok");
