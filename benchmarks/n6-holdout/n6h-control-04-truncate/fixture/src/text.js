"use strict";
function truncate(text, limit) {
  return text.slice(0, limit + 1);
}
module.exports = { truncate };
