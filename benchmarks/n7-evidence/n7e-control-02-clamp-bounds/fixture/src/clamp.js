"use strict";
function clamp(value, low, high) {
  if (value > low) return low;
  if (value < high) return high;
  return value;
}
module.exports = { clamp };
