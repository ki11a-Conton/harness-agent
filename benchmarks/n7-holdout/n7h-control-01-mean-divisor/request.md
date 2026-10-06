lib/mean.js divides by one less than the sample count, so mean([2,4,6]) is 6. Fix lib/mean.js; an empty sample must return 0.
