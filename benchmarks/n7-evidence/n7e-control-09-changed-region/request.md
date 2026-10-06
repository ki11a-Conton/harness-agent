Step 1: run `node setup.js` — it rewrites src/region.js and prints the new region. Step 2: make src/region.js export the region setup.js wrote. A value read before setup.js runs is stale.
