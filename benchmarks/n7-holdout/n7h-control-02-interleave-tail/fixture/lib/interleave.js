"use strict";
function interleave(a, b) {
  const out = [];
  for (let i = 0; i < a.length && i < b.length; i += 1) out.push(a[i], b[i]);
  return out;
}
module.exports = { interleave };
