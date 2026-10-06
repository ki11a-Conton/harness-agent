"use strict";
function fee(cents) {
  return Math.floor((cents * 3) / 100);
}
module.exports = { fee };
