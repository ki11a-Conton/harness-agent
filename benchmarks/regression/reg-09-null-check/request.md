`safeLen` in src/util.js crashes when passed null. Add a null/undefined guard so it returns 0 instead.
