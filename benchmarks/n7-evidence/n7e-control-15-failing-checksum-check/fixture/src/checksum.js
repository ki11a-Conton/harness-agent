"use strict";
function checksum(text) {
  let total = 0;
  for (const ch of text) total += ch.charCodeAt(0);
  return total;
}
module.exports = { checksum };
