src/equal.js compares objects by JSON text, so equal({a:1,b:2},{b:2,a:1}) is false. Fix src/equal.js so key order does not matter.
