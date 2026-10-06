Step 1: run `node setup.js` — it rewrites data/shards.json with the shard map. Step 2: make src/lookup.js shardOf(name) return the mapped shard id for that name.
