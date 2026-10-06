lib/range.js builds ranges exclusive of the end, so rangeOf(2,5) is [2,3,4] instead of [2,3,4,5]. Fix lib/range.js to include both ends.
