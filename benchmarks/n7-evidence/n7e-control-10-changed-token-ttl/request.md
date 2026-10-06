Step 1: run `node rotate.js` — it rewrites config/token.json with a new ttl_seconds. Step 2: make src/load.js return that ttl_seconds, read from the file at call time.
