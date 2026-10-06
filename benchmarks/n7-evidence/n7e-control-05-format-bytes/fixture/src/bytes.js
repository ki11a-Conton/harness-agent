"use strict";
function formatBytes(bytes) {
  return (bytes / 1000).toFixed(1) + " KB";
}
module.exports = { formatBytes };
