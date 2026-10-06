"use strict";
function render(text, values) {
  return text.replace(/\{\{(\w+)\}\}/, (whole, key) => (values[key] === undefined ? "" : String(values[key])));
}
module.exports = { render };
