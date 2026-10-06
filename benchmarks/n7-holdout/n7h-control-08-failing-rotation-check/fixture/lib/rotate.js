"use strict";
function rotate(xs, k) {
  return xs.slice(k).concat(xs.slice(0, k - 1));
}
module.exports = { rotate };
