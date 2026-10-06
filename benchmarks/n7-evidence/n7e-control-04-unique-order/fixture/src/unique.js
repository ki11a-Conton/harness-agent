"use strict";
function unique(xs) {
  const seen = new Set();
  const out = [];
  for (let i = xs.length - 1; i >= 0; i -= 1) {
    if (!seen.has(xs[i])) {
      seen.add(xs[i]);
      out.push(xs[i]);
    }
  }
  return out;
}
module.exports = { unique };
