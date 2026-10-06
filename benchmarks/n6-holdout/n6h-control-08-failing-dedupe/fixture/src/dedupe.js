"use strict";
function dedupe(records) {
  return records.filter((r, i) => records.indexOf(r) !== i);
}
module.exports = { dedupe };
