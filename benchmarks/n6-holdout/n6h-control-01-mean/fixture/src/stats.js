"use strict";
function mean(xs) {
  let total = 0;
  for (const x of xs) total += x;
  return total / (xs.length - 1);
}
module.exports = { mean };
