"use strict";
function mergeDefaults(defaults, overrides) {
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (overrides[key] !== undefined) out[key] = overrides[key];
  }
  return out;
}
module.exports = { mergeDefaults };
