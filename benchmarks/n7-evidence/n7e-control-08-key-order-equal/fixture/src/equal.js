"use strict";
function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
module.exports = { equal };
