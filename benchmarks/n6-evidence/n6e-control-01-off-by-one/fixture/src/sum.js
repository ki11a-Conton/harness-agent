"use strict";
function sum(xs) {
  let total = 0;
  for (let i = 0; i < xs.length - 1; i += 1) total += xs[i];
  return total;
}
module.exports = { sum };
