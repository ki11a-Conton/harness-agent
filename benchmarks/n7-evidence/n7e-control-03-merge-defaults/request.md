src/merge.js only copies keys that already exist in the defaults, so mergeDefaults({a:1},{b:2}) loses b. Fix src/merge.js.
