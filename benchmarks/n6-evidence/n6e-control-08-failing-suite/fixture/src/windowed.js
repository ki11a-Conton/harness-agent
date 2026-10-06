"use strict";
function windowed(xs, size) {
  const out = [];
  for (let i = 0; i + size <= xs.length; i += 1) out.push(xs.slice(i, i + size - 1));
  return out;
}
module.exports = { windowed };
