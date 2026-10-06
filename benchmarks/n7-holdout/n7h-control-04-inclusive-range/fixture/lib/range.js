"use strict";
function rangeOf(start, end) {
  const out = [];
  for (let i = start; i < end; i += 1) out.push(i);
  return out;
}
module.exports = { rangeOf };
