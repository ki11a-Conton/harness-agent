lib/interleave.js stops at the shorter input, so interleave([1,2,3], ["a"]) loses 2 and 3. Fix it to append the remaining tail.
